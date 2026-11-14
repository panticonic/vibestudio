import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";
import { evalRuntimeId } from "@vibestudio/shared/evalRuntimeIdentity";

/**
 * `vibestudio eval` admits a run with the host's `dynamicCode` service, starts it on the
 * session entity that hosts the kernel, and pulls its events and result from there
 * (dynamicCode.admit / start / await / events / dynamicCode.release; dynamicCode.reset)
 * over the paired CLI transport. These tests keep strict v2 Iroh credentials
 * and replace only the signaling/data-channel boundary with an in-process RPC
 * server, then assert the calls, output, and exit codes.
 */

interface RpcRequest {
  method: string;
  args: unknown[];
  type?: "call";
  targetId?: string;
}

type RunResult = {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: { message: string; errorKind: "application" };
  scopeKeys?: string[];
};

const transportMock = vi.hoisted(() => ({
  handle: null as ((body: RpcRequest) => unknown) | null,
  rpcBodies: [] as RpcRequest[],
  watchControllers: [] as ReadableStreamDefaultController<Uint8Array>[],
}));

vi.mock("../../node/iroh/irohRpcClient.js", () => ({
  IrohRpcClient: class {
    async ready(): Promise<void> {}

    async call(method: string, args: unknown[] = []): Promise<unknown> {
      return await this.dispatch({ method, args });
    }

    async callTarget(targetId: string, method: string, args: unknown[] = []): Promise<unknown> {
      return await this.dispatch({ type: "call", targetId, method, args });
    }

    async streamReadable(
      _targetId: string,
      method: string,
      args: unknown[] = [],
      options?: { signal?: AbortSignal }
    ): Promise<import("@vibestudio/rpc").DecodedFramedStream> {
      if (method !== "events.watch") throw new Error(`Unexpected streamReadable ${method}`);
      const streamReadable = new ReadableStream<Uint8Array>({
        start(controller) {
          transportMock.watchControllers.push(controller);
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({
                kind: "watching",
                events: args[0],
                epoch: "eval-cli-test",
              })}\n`
            )
          );
          options?.signal?.addEventListener(
            "abort",
            () => {
              controller.close();
            },
            { once: true }
          );
        },
      });
      return { status: 200, statusText: "OK", headers: [], finalUrl: "", body: streamReadable };
    }

    async close(): Promise<void> {}

    private async dispatch(body: RpcRequest): Promise<unknown> {
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("Iroh test server is not configured");
      return await transportMock.handle(body);
    }
  },
}));

/** Configure the deterministic Iroh RPC boundary used by paired CLI credentials. */
function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  transportMock.rpcBodies = [];
  transportMock.handle = handle;
  return { rpcBodies: transportMock.rpcBodies };
}

function writeCredentials(tmpDir: string, url = `iroh://${"bb".repeat(32)}/_workspace/dev`): void {
  const dir = path.join(tmpDir, ".config", "vibestudio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 6,
      phase: "workspace",
      kind: "device",
      transport: "iroh",
      deviceSecret: "E".repeat(43),
      url,
      workspaceId: "ws_dev",
      workspaceName: "dev",
      serverId: `srv_${"S".repeat(24)}`,
      deviceId: `dev_${"D".repeat(24)}`,
      refreshToken: "R".repeat(43),
      controlPairing: {
        endpointId: "aa".repeat(32),
        relays: ["https://relay.example/"],
        v: 5,
      },
      workspacePairing: {
        endpointId: "bb".repeat(32),
        relays: ["https://relay.example/"],
        v: 5,
      },
      pairedAt: 1,
    })
  );
}

function writeSession(tmpDir: string, name = "default", serverId = `srv_${"S".repeat(24)}`) {
  const dir = path.join(tmpDir, ".config", "vibestudio", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 3,
      name,
      serverId,
      workspaceId: "ws_dev",
      workspaceName: "dev",
      entityId: `session:${name}`,
      contextId: "ctx_1",
      scopeKey: name,
      createdAt: 1,
    })
  );
}

const OK_RESULT: RunResult = {
  success: true,
  console: "hello\n[WARN] careful",
  returnValue: { answer: 42 },
  scopeKeys: ["x"],
};

const HOST_ID = `do:workers/session:SessionDO:${"c".repeat(40)}`;

type PulledEvent = { sequence: number; at: number; kind: string; payload: unknown };

/**
 * The server side of the pull protocol: `dynamicCode.admit`, then the session entity's
 * `start`, `await` and `events`, then `dynamicCode.release`. `onCall` sees every request first.
 */
function pullServer(
  result: RunResult,
  options: {
    events?: PulledEvent[];
    onCall?: (body: RpcRequest) => void;
    /** Statuses `await` answers before the terminal one. */
    pending?: number;
    fallback?: (body: RpcRequest) => unknown;
  } = {}
): (body: RpcRequest) => unknown {
  let awaits = 0;
  return (body) => {
    options.onCall?.(body);
    switch (body.method) {
      case "dynamicCode.admit": {
        const runId = (body.args[0] as { runId: string }).runId;
        return {
          runId,
          runDigest: "a".repeat(64),
          authorityManifestDigest: "b".repeat(64),
          host: { source: "workers/session", className: "SessionDO", objectKey: "c".repeat(40) },
          hostId: HOST_ID,
          nonce: "nonce-1",
          start: { runId, code: "x" },
        };
      }
      case "start":
        return { runId: (body.args[0] as { runId: string }).runId, status: "pending" };
      case "await":
        return awaits++ < (options.pending ?? 0)
          ? { status: "running" }
          : { status: "done", result };
      case "events":
        return { events: options.events ?? [], next: options.events?.length ?? 0, hasMore: false };
      case "dynamicCode.release":
        return { released: true };
      default:
        return options.fallback ? options.fallback(body) : null;
    }
  };
}

function jsonOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function jsonErrorOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("vibestudio eval commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-eval-cli-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(tmpDir, ".config"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected network request from Iroh CLI test");
      })
    );
    clearShellTokenCache();
    transportMock.handle = null;
    transportMock.rpcBodies = [];
    transportMock.watchControllers = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("eval run admits the run, starts it on the session entity, pulls the result and releases", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(pullServer(OK_RESULT));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((b) => b.method)).toEqual([
      "dynamicCode.admit",
      "start",
      "await",
      "events",
      "dynamicCode.release",
    ]);
    // The run goes to the entity the admission named, with the admission's nonce.
    expect(rpcBodies[1]).toMatchObject({ targetId: HOST_ID, args: [expect.anything(), "nonce-1"] });
    expect(rpcBodies[2]!.args[0]).toBe((rpcBodies[0]!.args[0] as { runId: string }).runId);
    expect(rpcBodies[4]!.args[0]).toEqual({
      runId: (rpcBodies[0]!.args[0] as { runId: string }).runId,
      hostId: HOST_ID,
    });
    expect(rpcBodies[0]!.args[0]).toEqual({
      runId: expect.any(String),
      target: { kind: "owner-session", sessionId: "session:default" },
      scope: { key: "default" },
      source: { kind: "inline", code: "return 42;", syntax: undefined },
      imports: undefined,
    });

    const output = jsonOutput();
    expect(output["success"]).toBe(true);
    expect(output["returnValue"]).toEqual({ answer: 42 });
    expect(output["console"]).toBe("hello\n[WARN] careful");
    expect(output["scopeKeys"]).toEqual(["x"]);
    // Strict v2 pairing uses the persistent Iroh credential directly: no
    // refresh-shell or HTTP RPC compatibility path is involved.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("eval run --fresh-scope resets atomically with the run's admission", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(pullServer(OK_RESULT));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--fresh-scope", "--json"])).resolves.toBe(
      0
    );

    // The reset rides on the admission; there is no separate reset call.
    expect(rpcBodies.map((b) => b.method)).not.toContain("dynamicCode.reset");
    expect(rpcBodies[0]!.args[0]).toMatchObject({
      target: { kind: "owner-session", sessionId: "session:default" },
      scope: { key: "default" },
      reset: true,
    });
  });

  it("eval run forwards syntax + imports", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(pullServer(OK_RESULT));

    const { main } = await import("../client.js");
    await expect(
      main([
        "eval",
        "run",
        "-e",
        "return 1;",
        "--syntax",
        "typescript",
        "--imports",
        '{"lodash":"npm:4"}',
        "--json",
      ])
    ).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toMatchObject({
      source: expect.objectContaining({ syntax: "typescript" }),
      imports: { lodash: "npm:4" },
    });
  });

  it("eval run enables invocation-local full-auto approval explicitly", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(
      pullServer(OK_RESULT, {
        fallback: (body) => (body.method === "shellApproval.listPending" ? [] : null),
      })
    );

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "return 1;", "--approval-level", "2", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies.map((body) => body.method).slice(0, 2)).toEqual([
      "shellApproval.listPending",
      "dynamicCode.admit",
    ]);
  });

  it("eval run --path lets the server read the file (no inline code)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(pullServer(OK_RESULT));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "--path", "/snippets/a.ts", "--json"])).resolves.toBe(0);

    // `code` is undefined → dropped by JSON serialization; only `path` is sent.
    expect(rpcBodies[0]!.args[0]).toEqual({
      runId: expect.any(String),
      target: { kind: "owner-session", sessionId: "session:default" },
      scope: { key: "default" },
      source: { kind: "context-file", path: "/snippets/a.ts", syntax: undefined },
      imports: undefined,
    });
  });

  it("eval run reads code from a local FILE positional", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(pullServer(OK_RESULT));
    const codeFile = path.join(tmpDir, "snippet.ts");
    fs.writeFileSync(codeFile, "return 42;");

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", codeFile, "--json"])).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toMatchObject({
      source: { kind: "inline", code: "return 42;" },
    });
  });

  it("eval run maps a failed result to exit 1", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(
      pullServer({
        success: false,
        console: "",
        error: { message: "boom", errorKind: "application" },
      } satisfies RunResult)
    );

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "throw 1;", "--json"])).resolves.toBe(1);

    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["error"]).toEqual({ message: "boom", errorKind: "application" });
  });

  it("reports only actionable approvals belonging to this eval", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const callerId = evalRuntimeId("session:default", "default");
    const approval = {
      kind: "capability",
      capability: "workspace.publish",
      callerId,
      callerKind: "do",
      repoPath: "vibestudio/internal",
      effectiveVersion: "ev-1",
      requestedAt: 1,
    };
    stubServer(
      pullServer(OK_RESULT, {
        onCall: (body) => {
          if (body.method === "dynamicCode.admit") {
            transportMock.watchControllers[0]?.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  kind: "event",
                  event: "shell-approval:pending-changed",
                  sequence: 1,
                  payload: {
                    pending: [
                      { ...approval, approvalId: "unrelated", callerId: "another-agent" },
                      { ...approval, approvalId: "preparing", lifecycle: { state: "preparing" } },
                      { ...approval, approvalId: "actionable", lifecycle: { state: "ready" } },
                    ],
                  },
                })}\n`
              )
            );
          }
        },
      })
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1", "--json"])).resolves.toBe(0);
    const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(text).toContain("approval actionable");
    expect(text).not.toContain("approval unrelated");
    expect(text).not.toContain("approval preparing");
  });

  it("eval run prints console events it pulls in text mode without printing them twice", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(
      pullServer(OK_RESULT, {
        events: [{ sequence: 1, at: 1, kind: "console", payload: { text: OK_RESULT.console } }],
      })
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--plain"])).resolves.toBe(0);

    const consoleWrites = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes("hello"));
    expect(consoleWrites).toEqual(["hello\n[WARN] careful\n"]);
  });

  it("eval run waits through pending pulls and reports an authority wait it pulled", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(
      pullServer(OK_RESULT, {
        pending: 2,
        events: [
          {
            sequence: 1,
            at: 1,
            kind: "authority-requested",
            payload: { capability: "workspace.publish", acquisitionId: "acq-1" },
          },
        ],
      })
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.filter((body) => body.method === "await")).toHaveLength(3);
    expect(rpcBodies.at(-1)!.method).toBe("dynamicCode.release");
    // The diagnostic is delayed 500 ms; the run ended first, so nothing is printed late.
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).not.toContain("approval");
  });

  it("eval run maps a slow server call to a timeout (exit 4)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // The in-process Iroh server never resolves dynamicCode.admit, so the command's
    // client-side timeout remains deterministic without signaling or network.
    stubServer(() => new Promise<never>(() => {}));

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "while(true){}", "--timeout", "200", "--json"])
    ).resolves.toBe(4);

    const output = jsonErrorOutput();
    expect(String(output["error"])).toContain("timed out");
    expect(output["exitCode"]).toBe(4);
  });

  it("eval run usage errors exit 2", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--timeout", "nope", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--imports", "[1]", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--approval-level", "3", "--json"])).resolves.toBe(
      2
    );
    await expect(main(["eval", "run", "file.ts", "-e", "1", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--path", "/a.ts", "--json"])).resolves.toBe(2);
  });

  it("eval run without credentials is an auth error (exit 3)", async () => {
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--json"])).resolves.toBe(3);
  });

  it("eval repl-reset calls dynamicCode.reset with the session scope key", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({ ok: true }));

    const { main } = await import("../client.js");
    await expect(main(["eval", "repl-reset", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]!.method).toBe("dynamicCode.reset");
    expect(rpcBodies[0]!.args[0]).toEqual({
      target: { kind: "owner-session", sessionId: "session:default" },
      scopeKey: "default",
    });
    expect(jsonOutput()).toMatchObject({ ok: true });
  });
});
