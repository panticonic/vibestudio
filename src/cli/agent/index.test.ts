import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

interface RpcRequest {
  method: string;
  args: unknown[];
  type?: string;
  targetId?: string;
}

const transportMock = vi.hoisted(() => ({
  handle: null as ((body: RpcRequest) => unknown) | null,
  rpcBodies: [] as RpcRequest[],
}));

vi.mock("../webrtcClient.js", () => ({
  WebRtcRpcClient: class {
    async ready(): Promise<void> {}
    async call(method: string, args: unknown[] = []): Promise<unknown> {
      const body = { method, args };
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("WebRTC test server is not configured");
      return transportMock.handle(body);
    }
    async callTarget(targetId: string, method: string, args: unknown[] = []): Promise<unknown> {
      const body = { type: "call", targetId, method, args };
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("WebRTC test server is not configured");
      return transportMock.handle(body);
    }
    async close(): Promise<void> {}
  },
}));

/** Configure the canonical WebRTC RPC transport used by a paired CLI device. */
function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  transportMock.rpcBodies = [];
  transportMock.handle = handle;
  return { rpcBodies: transportMock.rpcBodies };
}

function writeCredentials(tmpDir: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(tmpDir, ".config", "vibestudio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 4,
      kind: "device",
      url: "webrtc://room-cli/_workspace/dev",
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
      ...overrides,
    })
  );
}

function sessionFile(tmpDir: string, name: string): string {
  return path.join(tmpDir, ".config", "vibestudio", "agent-sessions", `${name}.json`);
}

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

const SESSION_HANDLE = {
  id: "session:work",
  kind: "session",
  source: { repoPath: "agent-cli", effectiveVersion: "" },
  contextId: "ctx_1",
  targetId: "session:work",
};

const LIVE_SESSION_ROW = {
  id: "session:work",
  kind: "session",
  source: "agent-cli",
  key: "work",
  contextId: "ctx_1",
  title: "work",
  createdAt: 1,
};

describe("vibestudio agent commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-agent-"));
    vi.stubEnv("HOME", tmpDir);
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

  it("attach creates a session entity and persists a 0600 session file", async () => {
    writeCredentials(tmpDir);
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") return SESSION_HANDLE;
      throw new Error(`unexpected method ${body.method}`);
    });

    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "runtime.createEntity",
        args: [{ kind: "session", source: "agent-cli", key: "work", title: "work" }],
      },
    ]);
    const filePath = sessionFile(tmpDir, "work");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      schemaVersion: 3,
      name: "work",
      serverId: `srv_${"S".repeat(24)}`,
      workspaceId: "ws_dev",
      workspaceName: "dev",
      entityId: "session:work",
      contextId: "ctx_1",
      scopeKey: "work",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(jsonOutput()).toMatchObject({ entityId: "session:work" });
  });

  it("attach is idempotent when the entity is still live", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    {
      stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
      await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    }
    const before = fs.readFileSync(sessionFile(tmpDir, "work"), "utf8");

    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [LIVE_SESSION_ROW];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    expect(rpcBodies.map((body) => body.method)).toEqual(["runtime.listEntities"]);
    expect(fs.readFileSync(sessionFile(tmpDir, "work"), "utf8")).toBe(before);
  });

  it("keeps a live session across a workspace rename by stable workspace id", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    writeCredentials(tmpDir, {
      workspaceName: "renamed",
      url: "webrtc://room-cli/_workspace/renamed",
    });
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [LIVE_SESSION_ROW];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((body) => body.method)).toEqual(["runtime.listEntities"]);
    expect(JSON.parse(fs.readFileSync(sessionFile(tmpDir, "work"), "utf8"))).toMatchObject({
      workspaceId: "ws_dev",
      workspaceName: "renamed",
      entityId: "session:work",
    });
  });

  it("attach recreates the entity when it is gone", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    const recreated = { ...SESSION_HANDLE, id: "session:work2", contextId: "ctx_2" };
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") return recreated;
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    expect(rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "runtime.createEntity",
    ]);
    expect(jsonOutput()).toMatchObject({ entityId: "session:work2", contextId: "ctx_2" });
  });

  it("attach rejects a new pairing link when already paired (exit 2)", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const link =
      `vibestudio://connect?room=other-room&fp=${"BB".repeat(32)}` +
      `&code=${"C".repeat(32)}&sig=wss%3A%2F%2Fsignal.example%2F&v=2`;
    await expect(main(["agent", "attach", "work", link, "--json"])).resolves.toBe(2);
  });

  it("attach warns before overwriting a session from another server", async () => {
    writeCredentials(tmpDir);
    const dir = path.join(tmpDir, ".config", "vibestudio", "agent-sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionFile(tmpDir, "work"),
      JSON.stringify({
        schemaVersion: 3,
        name: "work",
        serverId: `srv_${"O".repeat(24)}`,
        workspaceId: "ws_old",
        workspaceName: "old",
        entityId: "session:old",
        contextId: "ctx_old",
        scopeKey: "work",
        createdAt: 1,
      })
    );
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));

    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    const warnings = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes(`srv_${"O".repeat(24)}/ws_old`))).toBe(true);
    const stored = JSON.parse(fs.readFileSync(sessionFile(tmpDir, "work"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      entityId: "session:work",
      serverId: `srv_${"S".repeat(24)}`,
      workspaceName: "dev",
    });
  });

  it("attach without credentials or pairing options is an auth error (exit 3)", async () => {
    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(3);
  });

  it("status reports stale sessions with exit 5", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer((body) => {
      if (body.method === "runtime.listEntities") return [LIVE_SESSION_ROW];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "status", "work", "--json"])).resolves.toBe(0);

    stubServer(() => []);
    await expect(main(["agent", "status", "work", "--json"])).resolves.toBe(5);
  });

  it("detach retires the entity and removes the session file", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.retireEntity") return undefined;
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "detach", "work", "--rm", "--json"])).resolves.toBe(0);
    expect(rpcBodies).toEqual([
      {
        method: "runtime.retireEntity",
        args: [{ id: "session:work", removeContext: true }],
      },
    ]);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(false);
  });

  it("detach deletes the session file when the entity is already gone", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer(() => {
      throw new Error("entity session:work not found");
    });
    await expect(main(["agent", "detach", "work", "--json"])).resolves.toBe(0);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(false);
    expect(jsonOutput()).toMatchObject({ detached: "work", entityMissing: true });
  });

  it("detach keeps the session file when retire fails for other reasons", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer(() => {
      throw new Error("durable object dispatch failed");
    });
    await expect(main(["agent", "detach", "work", "--json"])).resolves.toBe(1);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(true);
  });

  it("sessions reconciles local files against live entities", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    stubServer((body) => {
      if (body.method === "runtime.createEntity") {
        return { ...SESSION_HANDLE, id: "session:gone", contextId: "ctx_gone" };
      }
      return [];
    });
    await expect(main(["agent", "attach", "gone", "--json"])).resolves.toBe(0);

    stubServer((body) => {
      if (body.method === "runtime.listEntities") return [LIVE_SESSION_ROW];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "sessions", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([
      expect.objectContaining({ name: "gone", live: false }),
      expect.objectContaining({ name: "work", live: true }),
    ]);
  });

  it("sessions lists local files with unknown liveness when not paired", async () => {
    const dir = path.join(tmpDir, ".config", "vibestudio", "agent-sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionFile(tmpDir, "work"),
      JSON.stringify({
        schemaVersion: 3,
        name: "work",
        serverId: `srv_${"S".repeat(24)}`,
        workspaceId: "ws_dev",
        workspaceName: "dev",
        entityId: "session:work",
        contextId: "ctx_1",
        scopeKey: "work",
        createdAt: 1,
      })
    );

    const { main } = await import("../client.js");
    await expect(main(["agent", "sessions", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([expect.objectContaining({ name: "work", live: null })]);
  });

  it("call dispatches direct and relayed RPC and prints the result", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.type === "call") return { relayed: body.targetId };
      return { direct: body.method };
    });

    await expect(main(["agent", "call", "workspace.getActive", "[]", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual({ direct: "workspace.getActive" });

    await expect(
      main(["agent", "call", "stats.get", '[{"a":1}]', "--target", "worker:r:k", "--json"])
    ).resolves.toBe(0);
    expect(jsonOutput()).toEqual({ relayed: "worker:r:k" });
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: "worker:r:k",
      method: "stats.get",
      args: [{ a: 1 }],
    });
  });

  it("call allows plain method names when relaying with --target", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer(() => "pong");
    await expect(main(["agent", "call", "ping", "--target", "worker:r:k", "--json"])).resolves.toBe(
      0
    );
    expect(rpcBodies[0]).toEqual({
      type: "call",
      targetId: "worker:r:k",
      method: "ping",
      args: [],
    });
  });

  it("call rejects malformed args as usage errors (exit 2)", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["agent", "call", "no-dot", "--json"])).resolves.toBe(2);
    await expect(main(["agent", "call", "a.b", "{not json", "--json"])).resolves.toBe(2);
    await expect(main(["agent", "call", "a.b", '{"not":"array"}', "--json"])).resolves.toBe(2);
  });

  it("call surfaces server RPC errors as exit 1", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer(() => {
      throw new Error("Unknown service method");
    });
    await expect(main(["agent", "call", "nope.nope", "--json"])).resolves.toBe(1);
  });

  it("services lists and describes via the docs service", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "docs.listServices") {
        return [
          {
            name: "runtime",
            description: "Runtime entity creation",
            authority: { principals: ["user"] },
            methods: {},
          },
        ];
      }
      if (body.method === "docs.describeService") {
        return { name: "runtime", authority: { principals: ["user"] }, methods: {} };
      }
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "services", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([
      {
        name: "runtime",
        description: "Runtime entity creation",
        authority: { principals: ["user"] },
        methods: {},
      },
    ]);

    await expect(main(["agent", "services", "runtime", "--json"])).resolves.toBe(0);
    expect(rpcBodies[1]).toEqual({ method: "docs.describeService", args: ["runtime"] });
  });

  it("diag hits workspace.units.diagnostics and prints JSON", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const diagnostics = {
      unit: {
        name: "foo",
        kind: "worker",
        source: "workers/foo",
        status: "error",
        lastError: "boom",
      },
      logs: [],
      errors: [],
      builds: [],
      dropped: { entries: 0, errors: 0 },
      capacity: { entries: 1_000, errors: 500 },
    };
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "workspace.units.diagnostics") return diagnostics;
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "diag", "workers/foo", "--limit", "10", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies).toEqual([
      { method: "workspace.units.diagnostics", args: ["workers/foo", { limit: 10 }] },
    ]);
    expect(jsonOutput()).toEqual(diagnostics);
  });

  it("skills and logs hit the workspace service with the right shapes", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "workspace.listSkills") {
        return [
          {
            name: "alpha",
            description: "A skill",
            dirPath: "skills/alpha",
            skillPath: "skills/alpha/SKILL.md",
          },
        ];
      }
      if (body.method === "workspace.readSkill") return "# alpha skill";
      if (body.method === "workspace.units.logs") {
        return [
          {
            workspaceId: "ws_dev",
            unitName: "workers/foo",
            kind: "worker",
            timestamp: 1,
            level: "info",
            message: "hi",
          },
        ];
      }
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "skills", "--json"])).resolves.toBe(0);
    await expect(main(["agent", "skills", "alpha", "--json"])).resolves.toBe(0);
    await expect(
      main(["agent", "logs", "workers/foo", "--level", "info", "--limit", "10", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "workspace.listSkills", args: [] },
      { method: "workspace.readSkill", args: ["alpha"] },
      { method: "workspace.units.logs", args: ["workers/foo", { level: "info", limit: 10 }] },
    ]);
  });
});
