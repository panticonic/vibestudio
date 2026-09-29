import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentHostDevelopmentClientExecutor } from "./currentHostDevelopmentClientExecutor.js";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
} from "@vibestudio/shared/ownedProcessIdentity";

const roots: string[] = [];
const executors: CurrentHostDevelopmentClientExecutor[] = [];

function materializationFixture(
  readArtifact: (input: { offset: number }) => Promise<unknown>,
  onCall?: (method: string, args: unknown[]) => void | Promise<void>
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-executor-"));
  roots.push(root);
  const stateRoot = path.join(root, "clients");
  const requestId = `development-client-${"2".repeat(32)}`;
  const main = Buffer.from("module.exports = {};\n");
  const integrity = `sha256-${createHash("sha256").update(main).digest("hex")}`;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const spawnProcess = vi.fn(() => {
    throw new Error("An unmaterialized client must never launch");
  });
  const executor = new CurrentHostDevelopmentClientExecutor({
    stateRoot,
    electronExecutable: process.execPath,
    nativeModulesRoot: null,
    spawnProcess: spawnProcess as never,
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
    spawnProcess,
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
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      code: "ECONNRESET",
      message: "Artifact transport disconnected",
    });
  });

  it("joins native spawn failure before removing the materialized root or reporting failure", async () => {
    const fixture = materializationFixture(async () => ({
      base64: fixture.main.toString("base64"),
      nextOffset: fixture.main.byteLength,
      eof: true,
    }));
    let childClosed = false;
    fixture.spawnProcess.mockImplementation(() => {
      const child = spawn(path.join(fixture.ownedRoot, "missing-executable"), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.once("close", () => {
        expect(fs.existsSync(fixture.ownedRoot)).toBe(true);
        expect(fixture.calls.some((call) => call.method === "fail")).toBe(false);
        childClosed = true;
      });
      return child as never;
    });

    await fixture.executor.handleLaunchRequest({ requestId: fixture.requestId });

    expect(childClosed).toBe(true);
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      code: "ENOENT",
    });
    expect(fixture.calls.some((call) => call.method === "launched")).toBe(false);
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
        }
      );
      let child!: ChildProcess;
      fixture.spawnProcess.mockImplementation(() => {
        child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        return child as never;
      });
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
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownedRoot)).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      code: "ESHUTDOWN",
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
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained generation");
    expect(fixture.calls.some((call) => call.method === "readArtifact")).toBe(false);
    expect(fixture.calls.find((call) => call.method === "fail")?.args[0]).toMatchObject({
      code: "EEXIST",
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
    const executor = new CurrentHostDevelopmentClientExecutor({
      stateRoot,
      electronExecutable: process.execPath,
      nativeModulesRoot: null,
      spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
        child = spawn(
          process.execPath,
          [
            "-e",
            `
          const { spawn } = require('node:child_process');
          const descendant = spawn(process.execPath, ['-e',
            "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"
          ], { stdio: ['ignore','pipe','ignore'] });
          descendant.stdout.once('data', () => process.send({ type: 'fixture:descendant-ready' }));
          setInterval(()=>{},1000);
        `,
          ],
          options
        );
        child.on("message", (message) => {
          if ((message as { type?: string }).type === "fixture:descendant-ready") ready();
        });
        return child;
      }) as never,
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
        return { accepted: true };
      },
    };
    let child: ChildProcess;
    let spawnOptions: SpawnOptions | undefined;
    let spawnArgs: readonly string[] | undefined;
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: client as never,
      stateRoot,
      electronExecutable: executable,
      spawnProcess: ((_command: string, args: readonly string[], options: SpawnOptions) => {
        spawnArgs = args;
        spawnOptions = options;
        child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
        return child;
      }) as never,
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
