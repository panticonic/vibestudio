import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

/**
 * `vibestudio eval` drives the server-side `eval` service (eval.run / eval.reset)
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

vi.mock("../webrtcClient.js", () => ({
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
      schemaVersion: 4,
      kind: "device",
      url,
      workspaceId: "ws_dev",
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

  it("eval run calls eval.run with the session subKey and exits 0", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) => (body.method === "eval.run" ? OK_RESULT : null));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.run"]);
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
      code: "return 42;",
      path: undefined,
      syntax: undefined,
      imports: undefined,
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

  it("eval run --fresh-scope resets before running", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      body.method === "eval.reset" ? { ok: true } : OK_RESULT
    );

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--fresh-scope", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.reset", "eval.run"]);
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
    });
  });

  it("eval run forwards syntax + imports", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);

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
      syntax: "typescript",
      imports: { lodash: "npm:4" },
    });
  });

  it("eval run --path lets the server read the file (no inline code)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "--path", "/snippets/a.ts", "--json"])).resolves.toBe(0);

    // `code` is undefined → dropped by JSON serialization; only `path` is sent.
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
      path: "/snippets/a.ts",
      syntax: undefined,
      imports: undefined,
    });
  });

  it("eval run reads code from a local FILE positional", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);
    const codeFile = path.join(tmpDir, "snippet.ts");
    fs.writeFileSync(codeFile, "return 42;");

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", codeFile, "--json"])).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toMatchObject({ code: "return 42;" });
  });

  it("eval run maps a failed result to exit 1", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({ success: false, console: "", error: "boom" }) satisfies RunResult);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "throw 1;", "--json"])).resolves.toBe(1);

    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["error"]).toBe("boom");
  });

  it("eval run maps a slow server call to a timeout (exit 4)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // The in-process WebRTC server never resolves eval.run, so the command's
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
    const { rpcBodies } = stubServer(() => ({ ok: true }));

    const { main } = await import("../client.js");
    await expect(main(["eval", "repl-reset", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]!.method).toBe("eval.reset");
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
    });
    expect(jsonOutput()).toMatchObject({ ok: true });
  });
});
