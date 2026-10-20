import { deserializeRpcFailure, type RpcFailure, RemoteRpcAggregateError } from "@vibestudio/rpc";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ownership, type OwnedProcess } from "@vibestudio/shared/ownership";
import { CurrentHostDevelopmentClientExecutor } from "./currentHostDevelopmentClientExecutor.js";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
} from "@vibestudio/shared/ownedProcessIdentity";

const roots: string[] = [];
const executors: CurrentHostDevelopmentClientExecutor[] = [];

/** The executor's ownership: a real reaper over a private profile, observable at spawn. */
async function realOwnership(
  onSpawn?: (owned: OwnedProcess, args: readonly string[], options: SpawnOptions) => void
) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-executor-ownership-"));
  roots.push(profileDir);
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  return {
    get: vi.fn(async () => ({
      spawn: (command: string, args: readonly string[], options: never) => {
        const owned = ownership.spawn(command, args, options);
        onSpawn?.(owned, args, options);
        return owned;
      },
    })),
    close: () => ownership.close(),
  };
}

/**
 * A stand-in "Electron": an executable that ignores its arguments and runs a
 * script, so a real client group exists without launching a browser.
 */
function fixtureExecutable(dir: string, script: string): string {
  const js = path.join(dir, "client-fixture.cjs");
  fs.writeFileSync(js, script);
  const executable = path.join(dir, "electron-fixture");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`,
    { mode: 0o755 }
  );
  return executable;
}

/** This controlled fixture supplies only the ReadStream readable contract
 * consumed by hashing; it deliberately has no file descriptor or file path. */
function controlledExecutableStream(stream: PassThrough): ReturnType<typeof fs.createReadStream> {
  return stream as unknown as ReturnType<typeof fs.createReadStream>;
}

describe("diagnostic executor startup ownership", () => {
  it("does not fingerprint in the constructor and keeps the event loop available during streamed startup", async () => {
    const stream = new PassThrough();
    const read = vi
      .spyOn(fs, "createReadStream")
      .mockReturnValue(controlledExecutableStream(stream));
    const call = vi.fn(async () => ({ leaseExpiresAt: Date.now() + 60_000 }));
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: { call } as never,
      stateRoot: "/unused-diagnostic-state",
    });
    executors.push(executor);
    expect(read).not.toHaveBeenCalled();
    const startup = executor.start();
    expect(executor.start()).toBe(startup);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledWith(expect.any(String), { highWaterMark: 1024 * 1024 });
    expect(call).not.toHaveBeenCalled();
    // A renderer IPC/presentation task can complete while executor bytes have
    // not arrived. No synchronous whole-executable read owns the main thread.
    const presented = vi.fn();
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        presented();
        resolve();
      })
    );
    expect(presented).toHaveBeenCalledOnce();
    let retired = false;
    const close = executor.close().then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    stream.end("executable bytes");
    await startup;
    await close;
    expect(call).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("preserves the original fingerprint failure for an actual diagnostic consumer", async () => {
    const failure = new Error("executable read failed");
    const stream = new PassThrough();
    const read = vi
      .spyOn(fs, "createReadStream")
      .mockReturnValue(controlledExecutableStream(stream));
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: { call: vi.fn() } as never,
      stateRoot: "/unused-diagnostic-state",
    });
    const startup = executor.start();
    const rejected = expect(startup).rejects.toBe(failure);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    stream.destroy(failure);
    await rejected;
    await expect(executor.close()).rejects.toMatchObject({ errors: [failure] });
    read.mockRestore();
  });

  it("joins an admitted registration before shutdown and propagates its original failure", async () => {
    const stream = new PassThrough();
    const read = vi
      .spyOn(fs, "createReadStream")
      .mockReturnValue(controlledExecutableStream(stream));
    const failure = new Error("registration rejected");
    let reject!: (error: Error) => void;
    const call = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: { call } as never,
      stateRoot: "/unused-diagnostic-state",
    });
    const startup = executor.start();
    const rejected = expect(startup).rejects.toBe(failure);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    stream.end("executable bytes");
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith("developmentClientExecutor", "register", [
      expect.objectContaining({
        executorDigest: createHash("sha256").update("executable bytes").digest("hex"),
      }),
    ]);
    let retired = false;
    const close = executor.close();
    const closeAssertion = expect(close).rejects.toMatchObject({ errors: [failure] });
    void close.catch(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    reject(failure);
    await rejected;
    await closeAssertion;
    read.mockRestore();
  });
});

function materializationFixture(
  readArtifact: (input: { offset: number }) => Promise<unknown>,
  onCall?: (method: string, args: unknown[]) => void | Promise<void>,
  launch?: {
    executable: (root: string) => string;
    ownership: Awaited<ReturnType<typeof realOwnership>>;
  }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-executor-"));
  roots.push(root);
  const stateRoot = path.join(root, "clients");
  const requestId = `development-client-${"2".repeat(32)}`;
  const main = Buffer.from("module.exports = {};\n");
  const integrity = `sha256-${createHash("sha256").update(main).digest("hex")}`;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ownership = {
    get: vi.fn(async () => {
      throw new Error("An unmaterialized client must never launch");
    }),
    close: async () => undefined,
  };
  const executor = new CurrentHostDevelopmentClientExecutor({
    stateRoot,
    electronExecutable: launch ? launch.executable(root) : process.execPath,
    nativeModulesRoot: null,
    ownership: (launch ? launch.ownership : ownership) as never,
    client: {
      async call(_service: string, method: string, args: unknown[]) {
        calls.push({ method, args });
        await onCall?.(method, args);
        if (method === "claim")
          return {
            requestId,
            runId: "run:materialization",
            mainEntryBuildId: integrity.slice("sha256-".length),
            executionDigest: "3".repeat(64),
            recipeId: "recipe:materialization",
            artifacts: [{ path: "dist/main.cjs", integrity, byteLength: main.byteLength }],
            pairingDeepLink: "vibestudio://connect?opaque",
            expiresAt: Date.now() + 60_000,
          };
        if (method === "readArtifact") return readArtifact(args[0] as { offset: number });
        if (method === "register") return { leaseExpiresAt: Date.now() + 60_000 };
        return { accepted: true };
      },
    } as never,
  });
  executors.push(executor);
  return {
    executor,
    requestId,
    ownedRoot: path.join(stateRoot, requestId),
    main,
    calls,
    ownership,
  };
}

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("CurrentHostDevelopmentClientExecutor", () => {
  it("rolls back downloaded bytes and closes the artifact when the next chunk fails", async () => {
    const fixture = materializationFixture(async ({ offset }) => {
      if (offset === 0)
        return {
          base64: fixture.main.subarray(0, 5).toString("base64"),
          nextOffset: 5,
          eof: false,
        };
      expect(fs.readFileSync(path.join(fixture.ownedRoot, "dist/main.cjs"))).toEqual(
        fixture.main.subarray(0, 5)
      );
      throw Object.assign(new Error("Artifact transport disconnected"), { code: "ECONNRESET" });
    });
    await fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });
    expect(fixture.ownership.get).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      failure: {
        code: "ECONNRESET",
        message: "Artifact transport disconnected",
      },
    });
  });

  it("reports the complete artifact failure graph to the launch owner", async () => {
    const child = Object.assign(new Error("Artifact storage unavailable"), {
      code: "ESTORAGE",
      errorData: { artifact: "dist/main.cjs" },
    });
    const failure = Object.assign(
      new AggregateError(
        [child, new Error("Artifact stream aborted", { cause: child })],
        "Artifact materialization failed",
        { cause: child }
      ),
      { code: "EARTIFACT" }
    );
    const fixture = materializationFixture(async () => {
      throw failure;
    });
    await fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });
    const report = fixture.calls.find((call) => call.method === "fail")?.args[0] as {
      failure: RpcFailure;
    };
    const graph = deserializeRpcFailure(report.failure) as RemoteRpcAggregateError;
    expect(graph).toBeInstanceOf(RemoteRpcAggregateError);
    expect(graph).toMatchObject({ code: "EARTIFACT" });
    expect(graph.errors[0]).toMatchObject({
      code: "ESTORAGE",
      errorData: { artifact: "dist/main.cjs" },
    });
    expect(graph.cause).toBe(graph.errors[0]);
    expect((graph.errors[1] as Error).cause).toBe(graph.errors[0]);
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
  });

  it("joins native spawn failure before removing the materialized root or reporting failure", async () => {
    let childClosed = false;
    // Present but not executable: the kernel refuses the exec, so the failed
    // launch still owns an IPC handle until the child's `close`.
    const ownership = await realOwnership((owned) => {
      owned.child.once("close", () => {
        expect(fs.existsSync(fixture.ownedRoot)).toBe(true);
        expect(fixture.calls.some((call) => call.method === "fail")).toBe(false);
        childClosed = true;
      });
    });
    const fixture = materializationFixture(
      async () => ({
        base64: fixture.main.toString("base64"),
        nextOffset: fixture.main.byteLength,
        eof: true,
      }),
      undefined,
      {
        ownership,
        executable: (root) => {
          const executable = path.join(root, "not-executable");
          fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o644 });
          return executable;
        },
      }
    );

    await fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });

    expect(childClosed).toBe(true);
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      failure: {
        code: "EACCES",
      },
    });
    expect(fixture.calls.some((call) => call.method === "launched")).toBe(false);
    // The ownership scope keeps the spawn failure too (the library reports a
    // group that never registered), so closing carries the original error.
    executors.splice(executors.indexOf(fixture.executor), 1);
    const closed = await fixture.executor.close().catch((error: unknown) => error);
    const originals = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(originals) : [error];
    expect(originals(closed)).toEqual([expect.objectContaining({ code: "EACCES" })]);
  });

  it.each(["launch-failure", "native-exit"] as const)(
    "publishes one terminal receipt when %s wins the launch/exit race",
    async (winner) => {
      let publishing!: () => void;
      const publicationEntered = new Promise<void>((resolve) => {
        publishing = resolve;
      });
      let rejectPublication!: (error: Error) => void;
      const publication = new Promise<void>((_resolve, reject) => {
        rejectPublication = reject;
      });
      let retired!: () => void;
      const terminalEntered = new Promise<void>((resolve) => {
        retired = resolve;
      });
      let child!: ChildProcess;
      const ownership = await realOwnership((owned) => {
        child = owned.child;
      });
      const fixture = materializationFixture(
        async () => ({
          base64: fixture.main.toString("base64"),
          nextOffset: fixture.main.byteLength,
          eof: true,
        }),
        async (method) => {
          if (method === "launched") {
            publishing();
            await publication;
          }
          if (method === "exited" || method === "fail") {
            expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
            retired();
          }
        },
        {
          ownership,
          executable: (root) =>
            fixtureExecutable(
              root,
              "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"
            ),
        }
      );
      const launching = fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });
      await publicationEntered;
      if (winner === "native-exit") {
        child.kill("SIGTERM");
        await terminalEntered;
      }
      rejectPublication(
        Object.assign(new Error("Launch acknowledgement lost"), { code: "ECONNRESET" })
      );
      await launching;

      expect(
        fixture.calls
          .filter((call) => call.method === "exited" || call.method === "fail")
          .map((call) => call.method)
      ).toEqual([winner === "native-exit" ? "exited" : "fail"]);
      expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    }
  );

  it("joins a pending artifact producer on close and prevents it from launching a client", async () => {
    let release!: (value: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const chunk = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const fixture = materializationFixture(async () => {
      started();
      return chunk;
    });
    const launch = fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });
    await reading;
    let closed = false;
    const closing = fixture.executor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(fs.existsSync(fixture.ownedRoot)).toBe(true);
    release({
      base64: fixture.main.toString("base64"),
      nextOffset: fixture.main.byteLength,
      eof: true,
    });
    await Promise.all([launch, closing]);
    expect(fixture.ownership.get).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      failure: {
        code: "ESHUTDOWN",
      },
    });
    const callsBefore = fixture.calls.length;
    await expect(
      fixture.executor.handleLaunchRequest({ requestId: fixture.requestId })
    ).rejects.toMatchObject({ code: "ESHUTDOWN" });
    expect(fixture.calls).toHaveLength(callsBefore);
  });

  it("refuses to replace or remove a pre-existing request root", async () => {
    const fixture = materializationFixture(async () => {
      throw new Error("Existing roots must be rejected before artifact reads");
    });
    fs.mkdirSync(fixture.ownedRoot, { recursive: true });
    const sentinel = path.join(fixture.ownedRoot, "existing-owner");
    fs.writeFileSync(sentinel, "retained generation");
    await fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });
    expect(fixture.ownership.get).not.toHaveBeenCalled();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained generation");
    expect(fixture.calls.some((call) => call.method === "readArtifact")).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      failure: {
        code: "EEXIST",
      },
    });
    await fixture.executor.close();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained generation");
  });

  it("retires surviving descendants before reporting exit and deleting their root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-executor-"));
    roots.push(root);
    const stateRoot = path.join(root, "clients");
    const requestId = `development-client-${"4".repeat(32)}`;
    const main = Buffer.from("module.exports = {};\n");
    const integrity = `sha256-${createHash("sha256").update(main).digest("hex")}`;
    const ownedRoot = path.join(stateRoot, requestId);
    let child!: ChildProcess;
    let ready!: () => void;
    const descendantReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let reported!: () => void;
    const exitReport = new Promise<void>((resolve) => {
      reported = resolve;
    });
    let identity: ReturnType<typeof captureOwnedProcessIdentity>;
    const ownership = await realOwnership((owned) => {
      child = owned.child;
      child.on("message", (message) => {
        if ((message as { type?: string }).type === "fixture:descendant-ready") ready();
      });
    });
    const executor = new CurrentHostDevelopmentClientExecutor({
      stateRoot,
      electronExecutable: fixtureExecutable(
        root,
        `
          const { spawn } = require('node:child_process');
          const descendant = spawn(process.execPath, ['-e',
            "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"
          ], { stdio: ['ignore','pipe','ignore'] });
          descendant.stdout.once('data', () => process.send({ type: 'fixture:descendant-ready' }));
          setInterval(()=>{},1000);
        `
      ),
      nativeModulesRoot: null,
      ownership: ownership as never,
      client: {
        async call(_service: string, method: string) {
          if (method === "claim")
            return {
              requestId,
              runId: "run:descendants",
              mainEntryBuildId: integrity.slice("sha256-".length),
              executionDigest: "5".repeat(64),
              recipeId: "recipe:descendants",
              artifacts: [{ path: "dist/main.cjs", integrity, byteLength: main.byteLength }],
              pairingDeepLink: "vibestudio://connect?opaque",
              expiresAt: Date.now() + 60_000,
            };
          if (method === "readArtifact")
            return { base64: main.toString("base64"), nextOffset: main.byteLength, eof: true };
          if (method === "exited") {
            expect(observeOwnedProcessGroup(identity)).toBe("absent");
            expect(fs.existsSync(ownedRoot)).toBe(false);
            reported();
          }
          if (method === "register") return { leaseExpiresAt: Date.now() + 60_000 };
          return { accepted: true };
        },
      } as never,
    });
    executors.push(executor);
    await executor.handleLaunchRequest({ requestId });
    identity = captureOwnedProcessIdentity(child.pid!);
    await descendantReady;
    child.kill("SIGKILL");
    await exitReport;
    await executor.close();
  });

  it("materializes verified chunks, strips ambient secrets, and removes the exact root after exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-executor-"));
    roots.push(root);
    const executable = path.join(root, "electron");
    fs.writeFileSync(executable, "reviewed-electron");
    const stateRoot = path.join(root, "clients");
    const nativeModules = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nativeModules, "@number0", "iroh"), { recursive: true });
    fs.writeFileSync(path.join(nativeModules, "@number0", "iroh", "package.json"), "{}");
    const requestId = `development-client-${"1".repeat(32)}`;
    const main = Buffer.from("module.exports = {};\n");
    const integrity = `sha256-${createHash("sha256").update(main).digest("hex")}`;
    const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
    const client = {
      async call(service: string, method: string, args: unknown[]) {
        calls.push({ service, method, args });
        if (method === "claim") {
          return {
            requestId,
            runId: "run:one",
            mainEntryBuildId: integrity.slice("sha256-".length),
            executionDigest: "2".repeat(64),
            recipeId: "recipe:one",
            artifacts: [{ path: "dist/main.cjs", integrity, byteLength: main.byteLength }],
            pairingDeepLink: "vibestudio://connect?opaque",
            expiresAt: Date.now() + 60_000,
          };
        }
        if (method === "readArtifact") {
          const input = args[0] as { offset: number };
          return {
            base64: main.subarray(input.offset).toString("base64"),
            nextOffset: main.byteLength,
            eof: true,
          };
        }
        if (method === "register") return { leaseExpiresAt: Date.now() + 60_000 };
        return { accepted: true };
      },
    };
    let child: ChildProcess;
    let spawnOptions: SpawnOptions | undefined;
    let spawnArgs: readonly string[] | undefined;
    const ownership = await realOwnership((owned, args, options) => {
      child = owned.child;
      spawnArgs = args;
      spawnOptions = options;
    });
    fs.writeFileSync(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"\n`
    );
    fs.chmodSync(executable, 0o755);
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: client as never,
      stateRoot,
      electronExecutable: executable,
      ownership: ownership as never,
      nativeModulesRoot: nativeModules,
      processArgv: ["electron", "--password-store=gnome-libsecret", "--no-sandbox", "/app"],
    });

    executors.push(executor);
    const priorSecret = process.env["VIBESTUDIO_TEST_SECRET"];
    process.env["VIBESTUDIO_TEST_SECRET"] = "must-not-cross";
    try {
      await executor.handleLaunchRequest({ requestId });
    } finally {
      if (priorSecret === undefined) delete process.env["VIBESTUDIO_TEST_SECRET"];
      else process.env["VIBESTUDIO_TEST_SECRET"] = priorSecret;
    }

    const ownedRoot = path.join(stateRoot, requestId);
    expect(fs.readFileSync(path.join(ownedRoot, "dist", "main.cjs"))).toEqual(main);
    // A client bundle resolves native modules next to itself; materialized on
    // its own it cannot open the transport it was told to pair over.
    const linked = path.join(ownedRoot, "node_modules");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(linked, "@number0", "iroh", "package.json"))).toBe(true);
    // Which secret store holds a device credential belongs to the session, and
    // a launched client saves its own there before it can pair at all.
    expect(spawnArgs?.[0]).toBe("--password-store=gnome-libsecret");
    expect(spawnArgs).not.toContain("--no-sandbox");
    expect(spawnOptions?.env).not.toHaveProperty("VIBESTUDIO_TEST_SECRET");
    expect(spawnOptions?.env).toMatchObject({
      VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST: requestId,
      VIBESTUDIO_DEVELOPMENT_EXECUTION_DIGEST: "2".repeat(64),
    });
    expect(calls.some((call) => call.method === "launched")).toBe(true);

    await executor.handleLaunchRequest({ requestId });
    expect(calls.filter((call) => call.method === "claim")).toHaveLength(1);
    const exited = once(child!, "exit");
    child!.kill("SIGTERM");
    await exited;
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === "exited")).toBe(true);
      expect(fs.existsSync(ownedRoot)).toBe(false);
    });
    await executor.close();
  });
});
