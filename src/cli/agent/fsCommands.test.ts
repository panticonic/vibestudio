import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";
import { renderGrepMatches } from "./fsCommands.js";

interface RpcRequest {
  method: string;
  args: unknown[];
  type?: "call";
  targetId?: string;
}

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

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

describe("vibestudio fs commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-fs-cli-"));
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

  it("ls injects the session contextId and recursive flag", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => [
      { name: "a.txt", _isFile: true, _isDirectory: false, _isSymbolicLink: false },
      { name: "sub", _isFile: false, _isDirectory: true, _isSymbolicLink: false },
    ]);

    const { main } = await import("../client.js");
    await expect(main(["fs", "ls", "/notes", "-R", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "fs.readdir",
        args: ["ctx_1", "/notes", { withFileTypes: true, recursive: true }],
      },
    ]);
    expect(jsonOutput()).toEqual([
      { name: "a.txt", type: "file" },
      { name: "sub", type: "dir" },
    ]);
  });

  it("read decodes the binary envelope to stdout", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({ __bin: true, data: Buffer.from("héllo\n").toString("base64") }));
    const writes: Buffer[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: Buffer | string
    ) => {
      writes.push(Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write);

    const { main } = await import("../client.js");
    await expect(main(["fs", "read", "/notes/a.txt"])).resolves.toBe(0);

    stdoutSpy.mockRestore();
    expect(Buffer.concat(writes).toString("utf8")).toBe("héllo\n");
  });

  it("read --out writes the decoded bytes to a local file", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const payload = Buffer.from([0, 1, 2, 255]);
    const { rpcBodies } = stubServer(() => ({ __bin: true, data: payload.toString("base64") }));
    const outFile = path.join(tmpDir, "out.bin");

    const { main } = await import("../client.js");
    await expect(main(["fs", "read", "/blob.bin", "--out", outFile, "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "fs.readFile", args: ["ctx_1", "/blob.bin"] }]);
    expect(fs.readFileSync(outFile)).toEqual(payload);
    expect(jsonOutput()).toMatchObject({ path: "/blob.bin", bytes: 4 });
  });

  it("write sends a binary envelope that round-trips the content", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => undefined);

    const { main } = await import("../client.js");
    await expect(
      main(["fs", "write", "/notes/a.txt", "--content", "héllo wörld", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    const [contextId, target, envelope] = rpcBodies[0]!.args as [
      string,
      string,
      { __bin: true; data: string },
    ];
    expect(rpcBodies[0]!.method).toBe("fs.writeFile");
    expect(contextId).toBe("ctx_1");
    expect(target).toBe("/notes/a.txt");
    expect(Buffer.from(envelope.data, "base64").toString("utf8")).toBe("héllo wörld");
  });

  it("write --append sends one append intent; the service creates parents", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => undefined);

    const { main } = await import("../client.js");
    await expect(
      main(["fs", "write", "/a/b/c.txt", "--content", "x", "--append", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies.map((body) => body.method)).toEqual(["fs.appendFile"]);
    expect(rpcBodies[0]!.args[1]).toBe("/a/b/c.txt");
  });

  it("write --from-file reads local content", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "from disk");
    const { rpcBodies } = stubServer(() => undefined);

    const { main } = await import("../client.js");
    await expect(
      main(["fs", "write", "/copy.txt", "--from-file", localFile, "--json"])
    ).resolves.toBe(0);

    const envelope = rpcBodies[0]!.args[2] as { data: string };
    expect(Buffer.from(envelope.data, "base64").toString("utf8")).toBe("from disk");
  });

  it("rm/mv/cp/mkdir/stat construct the expected fs calls", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      body.method === "fs.stat"
        ? {
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            size: 3,
            mtime: "2026-07-13T00:00:00.000Z",
            ctime: "2026-07-13T00:00:00.000Z",
            mode: 0o100644,
          }
        : undefined
    );

    const { main } = await import("../client.js");
    await expect(main(["fs", "rm", "/dir", "-r", "--json"])).resolves.toBe(0);
    await expect(main(["fs", "mv", "/a", "/b", "--json"])).resolves.toBe(0);
    await expect(main(["fs", "cp", "/b", "/c", "--json"])).resolves.toBe(0);
    await expect(main(["fs", "mkdir", "/d/e", "-p", "--json"])).resolves.toBe(0);
    await expect(main(["fs", "stat", "/c", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "fs.rm", args: ["ctx_1", "/dir", { recursive: true }] },
      { method: "fs.rename", args: ["ctx_1", "/a", "/b"] },
      { method: "fs.copyFile", args: ["ctx_1", "/b", "/c"] },
      { method: "fs.mkdir", args: ["ctx_1", "/d/e", { recursive: true }] },
      { method: "fs.stat", args: ["ctx_1", "/c"] },
    ]);
    expect(jsonOutput()).toMatchObject({ isFile: true, size: 3 });
  });

  it("grep passes search options and emits the result", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      matches: [{ file: "/src/a.ts", lineNumber: 3, line: "const x = 1;", before: [], after: [] }],
      matchCount: 1,
      truncated: false,
    };
    const { rpcBodies } = stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(
      main([
        "fs",
        "grep",
        "x =",
        "/src",
        "-i",
        "--glob",
        "*.ts",
        "-C",
        "2",
        "--max",
        "50",
        "--json",
      ])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "fs.grep",
        args: [
          "ctx_1",
          "x =",
          { path: "/src", glob: "*.ts", caseInsensitive: true, contextLines: 2, maxMatches: 50 },
        ],
      },
    ]);
    expect(jsonOutput()).toEqual(result);
  });

  it("grep rejects zero for --max and -C as usage errors (exit 2)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({ matches: [], matchCount: 0, truncated: false }));

    const { main } = await import("../client.js");
    await expect(main(["fs", "grep", "x", "--max", "0", "--json"])).resolves.toBe(2);
    await expect(main(["fs", "grep", "x", "-C", "0", "--json"])).resolves.toBe(2);
  });

  it("renderGrepMatches formats matches with context and truncation", () => {
    const lines = renderGrepMatches({
      matches: [
        {
          file: "/src/a.ts",
          lineNumber: 5,
          line: "match line",
          before: ["before 1", "before 2"],
          after: ["after 1"],
        },
      ],
      matchCount: 1,
      truncated: true,
    });
    expect(lines).toEqual([
      "/src/a.ts:3- before 1",
      "/src/a.ts:4- before 2",
      "/src/a.ts:5: match line",
      "/src/a.ts:6- after 1",
      "(truncated at 1 matches)",
    ]);
  });

  it("glob passes the optional search path", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ["/src/a.ts"]);

    const { main } = await import("../client.js");
    await expect(main(["fs", "glob", "**/*.ts", "/src", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "fs.glob", args: ["ctx_1", "**/*.ts", { path: "/src" }] },
    ]);
    expect(jsonOutput()).toEqual(["/src/a.ts"]);
  });

  it("maps failures to the exit-code conventions", async () => {
    const { main } = await import("../client.js");

    // No session file → operation error (1).
    writeCredentials(tmpDir);
    await expect(main(["fs", "ls", "/", "--json"])).resolves.toBe(1);

    // Missing required positional → usage error (2).
    writeSession(tmpDir);
    await expect(main(["fs", "grep", "--json"])).resolves.toBe(2);
    // Unknown flag → usage error (2).
    await expect(main(["fs", "ls", "--nope", "--json"])).resolves.toBe(2);

    // Server-side RPC error → 1.
    stubServer(() => {
      throw new Error("Path traversal detected");
    });
    await expect(main(["fs", "ls", "../../etc", "--json"])).resolves.toBe(1);

    // Session bound to a different server → stale session (5).
    writeSession(tmpDir, "other", `srv_${"O".repeat(24)}`);
    await expect(main(["fs", "ls", "/", "--session", "other", "--json"])).resolves.toBe(5);
  });

  it("session file without credentials is an auth error (exit 3)", async () => {
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["fs", "ls", "/", "--json"])).resolves.toBe(3);
  });
});
