import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

vi.mock("@natstack/shared/tailscaleDiscovery", () => ({
  discoverNatstackServers: vi.fn(async () => []),
}));

interface RpcRequest {
  method: string;
  args: unknown[];
}

/** Stub fetch for a paired server: answers refresh-shell and routes /rpc bodies. */
function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  const rpcBodies: RpcRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
        return new Response(
          JSON.stringify({ shellToken: "tok", callerId: "shell:dev_cli", deviceId: "dev_cli" })
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as RpcRequest;
      rpcBodies.push(body);
      try {
        return new Response(JSON.stringify({ result: handle(body) }));
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
      }
    })
  );
  return { rpcBodies };
}

function writeCredentials(tmpDir: string): void {
  const dir = path.join(tmpDir, ".config", "natstack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    })
  );
}

function writeSession(tmpDir: string, name = "default"): void {
  const dir = path.join(tmpDir, ".config", "natstack", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      serverUrl: "https://host.tailnet.ts.net",
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

describe("natstack git commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-git-cli-"));
    vi.stubEnv("HOME", tmpDir);
    clearShellTokenCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status calls git.contextStatus with the session contextId first", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const statusResult = {
      branch: "main",
      commit: "abc123",
      dirty: true,
      files: [{ path: "index.ts", status: "modified", staged: false, unstaged: true }],
    };
    const { rpcBodies } = stubServer(() => statusResult);

    const { main } = await import("../client.js");
    await expect(main(["git", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "git.contextStatus", args: ["ctx_1", "panels/notes"] }]);
    expect(jsonOutput()).toEqual(statusResult);
  });

  it("diff passes the staged option and writes the patch raw without --json", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => "--- a/x\n+++ b/x\n");

    const { main } = await import("../client.js");
    await expect(main(["git", "diff", "--repo", "panels/notes", "--json"])).resolves.toBe(0);
    await expect(
      main(["git", "diff", "--repo", "panels/notes", "--staged", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "git.contextDiff", args: ["ctx_1", "panels/notes", { staged: false }] },
      { method: "git.contextDiff", args: ["ctx_1", "panels/notes", { staged: true }] },
    ]);
    expect(jsonOutput()).toBe("--- a/x\n+++ b/x\n");
  });

  it("add stages everything via git.contextAddAll", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(main(["git", "add", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "git.contextAddAll", args: ["ctx_1", "panels/notes"] }]);
  });

  it("commit -m sends the message and prints the commit", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({ commitId: "deadbeefcafe0000", summary: "Fix it" }));

    const { main } = await import("../client.js");
    await expect(
      main(["git", "commit", "-m", "Fix it", "--repo", "panels/notes", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "git.contextCommit", args: ["ctx_1", "panels/notes", "Fix it"] },
    ]);
    expect(jsonOutput()).toEqual({ commitId: "deadbeefcafe0000", summary: "Fix it" });
  });

  it("honors --session for non-default sessions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir, "work");
    const { rpcBodies } = stubServer(() => ({
      branch: null,
      commit: null,
      dirty: false,
      files: [],
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["git", "status", "--repo", "panels/notes", "--session", "work", "--json"])
    ).resolves.toBe(0);
    expect(rpcBodies[0]!.args[0]).toBe("ctx_1");
  });

  it("maps failures to the exit-code conventions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");

    // Missing --repo / missing -m → usage error (2).
    await expect(main(["git", "status", "--json"])).resolves.toBe(2);
    await expect(main(["git", "commit", "--repo", "panels/notes", "--json"])).resolves.toBe(2);

    // Server-side RPC error → 1.
    stubServer(() => {
      throw new Error("Nothing to commit: no staged changes");
    });
    await expect(
      main(["git", "commit", "-m", "msg", "--repo", "panels/notes", "--json"])
    ).resolves.toBe(1);
  });
});
