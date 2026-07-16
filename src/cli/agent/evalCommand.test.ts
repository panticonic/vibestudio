import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "@vibestudio/direct-client";

/**
 * `vibestudio eval` drives the server-side asynchronous eval lifecycle
 * over the paired CLI transport. These tests keep strict v2 WebRTC credentials
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
  error?: string;
  scopeKeys?: string[];
};

const transportMock = vi.hoisted(() => ({
  handle: null as ((body: RpcRequest) => unknown) | null,
  rpcBodies: [] as RpcRequest[],
}));

vi.mock("@vibestudio/direct-client/webrtc", () => ({
  WebRtcRpcClient: class {
    async ready(): Promise<void> {}

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
      return await this.dispatch<T>({ method, args });
    }

    async callTarget<T = unknown>(
      targetId: string,
      method: string,
      args: unknown[] = []
    ): Promise<T> {
      return await this.dispatch<T>({ type: "call", targetId, method, args });
    }

    async close(): Promise<void> {}

    private async dispatch<T>(body: RpcRequest): Promise<T> {
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("WebRTC test server is not configured");
      return (await transportMock.handle(body)) as T;
    }
  },
}));

/** Configure the deterministic WebRTC RPC boundary used by paired CLI credentials. */
function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  transportMock.rpcBodies = [];
  transportMock.handle = handle;
  return { rpcBodies: transportMock.rpcBodies };
}

function writeCredentials(tmpDir: string, url = "webrtc://room-cli/_workspace/dev"): void {
  const dir = path.join(tmpDir, ".config", "vibestudio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 3,
      kind: "device",
      url,
      workspaceName: "dev",
      serverId: `srv_${"S".repeat(24)}`,
      deviceId: `dev_${"D".repeat(24)}`,
      refreshToken: "R".repeat(43),
      controlPairing: {
        room: "room-control",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      workspacePairing: {
        room: "room-cli",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      pairedAt: 1,
    })
  );
}

function writeSession(
  tmpDir: string,
  name = "default",
  serverUrl = "webrtc://room-cli/_workspace/dev"
) {
  const dir = path.join(tmpDir, ".config", "vibestudio", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      serverUrl,
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

const DIGEST = "a".repeat(64);
const HANDLE = {
  runId: "run-1",
  status: "accepted",
  acceptedAt: 10,
  startIntentDigest: DIGEST,
};

function terminalSnapshot(result: RunResult) {
  const terminalReason = result.error ?? null;
  const publicResult = {
    ...result,
    provenance: {
      startIntentDigest: DIGEST,
      sourceDigest: DIGEST,
      executionProvenanceDigest: DIGEST,
      scopeInputRevision: null,
      runDigest: DIGEST,
      sourceBundleDigest: DIGEST,
      manifestDigest: DIGEST,
      terminalReason,
    },
  };
  return {
    runId: HANDLE.runId,
    status: result.success ? "succeeded" : "failed",
    acceptedAt: HANDLE.acceptedAt,
    startedAt: 11,
    endedAt: 12,
    deadlineAt: null,
    startIntentDigest: DIGEST,
    sourceDigest: DIGEST,
    executionProvenanceDigest: DIGEST,
    scopeInputRevision: null,
    runDigest: DIGEST,
    sourceBundleDigest: DIGEST,
    manifestDigest: DIGEST,
    result: publicResult,
    terminalReason,
  };
}

function completedServer(result: RunResult = OK_RESULT): (body: RpcRequest) => unknown {
  return (body) => {
    if (body.method === "eval.start") return HANDLE;
    if (body.method === "eval.events") return { events: [], next: 0 };
    if (body.method === "eval.get") return terminalSnapshot(result);
    throw new Error(`Unexpected eval method ${body.method}`);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected network request from WebRTC CLI test");
      })
    );
    clearShellTokenCache();
    transportMock.handle = null;
    transportMock.rpcBodies = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("eval run composes start/events/get with the session scope and exits 0", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(completedServer());

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.start", "eval.events", "eval.get"]);
    expect(rpcBodies[0]!.args[0]).toEqual({
      target: { kind: "attached-session", ownerId: "session:default", contextId: "ctx_1" },
      scope: { key: "default" },
      source: { kind: "inline", code: "return 42;" },
      authority: {},
    });

    const output = jsonOutput();
    expect(output["success"]).toBe(true);
    expect(output["returnValue"]).toEqual({ answer: 42 });
    expect(output["console"]).toBe("hello\n[WARN] careful");
    expect(output["scopeKeys"]).toEqual(["x"]);
    // Strict v2 pairing uses the persistent WebRTC credential directly: no
    // refresh-shell or HTTP RPC compatibility path is involved.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("eval run --fresh-scope atomically requests a reset on start", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(completedServer());

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--fresh-scope", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.start", "eval.events", "eval.get"]);
    expect(rpcBodies[0]!.args[0]).toMatchObject({ scope: { key: "default", reset: true } });
  });

  it("eval run forwards syntax + imports", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(completedServer());

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
      source: { kind: "inline", code: "return 1;", syntax: "typescript" },
      imports: { lodash: "npm:4" },
    });
  });

  it("eval run --path lets the server read the file (no inline code)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(completedServer());

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "--path", "/snippets/a.ts", "--json"])).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toEqual({
      target: { kind: "attached-session", ownerId: "session:default", contextId: "ctx_1" },
      scope: { key: "default" },
      source: { kind: "context-file", path: "/snippets/a.ts" },
      authority: {},
    });
  });

  it("eval run reads code from a local FILE positional", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(completedServer());
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
    stubServer(completedServer({ success: false, console: "", error: "boom" }));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "throw 1;", "--json"])).resolves.toBe(1);

    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["error"]).toBe("boom");
  });

  it("eval run maps a slow server call to a timeout (exit 4)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "eval.start") return HANDLE;
      if (body.method === "eval.events") return new Promise<never>(() => {});
      if (body.method === "eval.cancel") return { status: "requested" };
      throw new Error(`Unexpected eval method ${body.method}`);
    });

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "while(true){}", "--timeout", "200", "--json"])
    ).resolves.toBe(4);

    const output = jsonErrorOutput();
    expect(String(output["error"])).toContain("timed out");
    expect(output["exitCode"]).toBe(4);
    expect(rpcBodies.map((body) => body.method)).toContain("eval.cancel");
  });

  it("eval run usage errors exit 2", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--timeout", "nope", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--imports", "[1]", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "file.ts", "-e", "1", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--path", "/a.ts", "--json"])).resolves.toBe(2);
  });

  it("eval run without credentials is an auth error (exit 3)", async () => {
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--json"])).resolves.toBe(3);
  });

  it("eval repl-reset calls eval.reset with the session subKey", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({ status: "reset" }));

    const { main } = await import("../client.js");
    await expect(main(["eval", "repl-reset", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]!.method).toBe("eval.reset");
    expect(rpcBodies[0]!.args[0]).toEqual({
      target: { kind: "attached-session", ownerId: "session:default", contextId: "ctx_1" },
      scope: { key: "default" },
    });
    expect(jsonOutput()).toMatchObject({ status: "reset" });
  });
});
