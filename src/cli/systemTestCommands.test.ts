import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "@vibestudio/direct-client";

interface RpcRequest {
  method: string;
  args: unknown[];
}

const transportMock = vi.hoisted(() => ({
  handle: null as ((body: RpcRequest) => unknown) | null,
  rpcBodies: [] as RpcRequest[],
}));

vi.mock("@vibestudio/direct-client/webrtc", () => ({
  WebRtcRpcClient: class {
    async ready(): Promise<void> {}
    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
      const body = { method, args };
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("system-test transport is not configured");
      return (await transportMock.handle(body)) as T;
    }
    async close(): Promise<void> {}
  },
}));

function writeCredentials(root: string): void {
  const dir = path.join(root, ".config", "vibestudio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 3,
      kind: "device",
      url: "webrtc://room-cli/_workspace/dev",
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
  fs.mkdirSync(path.join(dir, "agent-sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent-sessions", "default.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "default",
      serverUrl: "webrtc://room-cli/_workspace/dev",
      entityId: "session:default",
      contextId: "ctx_1",
      scopeKey: "default",
      createdAt: 1,
    })
  );
}

function output(): Record<string, unknown> | unknown[] {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls[calls.length - 1]![0])) as Record<string, unknown> | unknown[];
}

describe("vibestudio system-test commands", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-system-test-cli-"));
    vi.stubEnv("HOME", root);
    clearShellTokenCache();
    writeCredentials(root);
    transportMock.rpcBodies = [];
    transportMock.handle = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists the server-built catalog through CLI-neutral eval", async () => {
    transportMock.handle = (body) => {
      if (body.method === "eval.run") {
        return {
          success: true,
          console: "",
          returnValue: [{ name: "eval-return-value", category: "smoke", description: "compute" }],
        };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "list", "--category", "smoke", "--json"])).resolves.toBe(0);

    expect(output()).toEqual([
      { name: "eval-return-value", category: "smoke", description: "compute" },
    ]);
    const code = String((transportMock.rpcBodies[0]!.args[0] as { code: string }).code);
    expect(code).toContain("listSystemTests");
    expect(code).toContain('const category = "smoke"');
  });

  it("creates a dedicated session when list has no ambient/default scope", async () => {
    fs.rmSync(path.join(root, ".config", "vibestudio", "agent-sessions", "default.json"));
    transportMock.handle = (body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") {
        return {
          id: "session:system-tests",
          kind: "session",
          source: { repoPath: "agent-cli" },
          contextId: "ctx_system_tests",
          targetId: "session:system-tests",
        };
      }
      if (body.method === "eval.run") {
        return { success: true, console: "", returnValue: [] };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    const { main } = await import("./client.js");

    const exitCode = await main(["system-test", "list", "--json"]);
    expect(vi.mocked(console.error).mock.calls).toEqual([]);
    expect(exitCode).toBe(0);

    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.createEntity",
      "eval.run",
    ]);
    expect(transportMock.rpcBodies[1]?.args[0]).toMatchObject({
      ownerId: "session:system-tests",
      contextId: "ctx_system_tests",
      subKey: "system-tests",
    });
  });

  it("recreates an explicit named session after an ephemeral workspace restart", async () => {
    const sessionsDir = path.join(root, ".config", "vibestudio", "agent-sessions");
    fs.writeFileSync(
      path.join(sessionsDir, "system-tests.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "system-tests",
        serverUrl: "webrtc://room-cli/_workspace/dev",
        entityId: "session:stale",
        contextId: "ctx_stale",
        scopeKey: "system-tests",
        createdAt: 1,
      })
    );
    transportMock.handle = (body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") {
        return {
          id: "session:fresh",
          kind: "session",
          source: { repoPath: "agent-cli" },
          contextId: "ctx_fresh",
          targetId: "session:fresh",
        };
      }
      if (body.method === "eval.run") {
        return {
          success: true,
          console: "",
          returnValue: { ok: true, checks: [] },
        };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    const { main } = await import("./client.js");

    const exitCode = await main(["system-test", "doctor", "--session", "system-tests", "--json"]);
    expect(vi.mocked(console.error).mock.calls).toEqual([]);
    expect(exitCode).toBe(0);

    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "runtime.createEntity",
      "eval.run",
    ]);
    const evalArgs = transportMock.rpcBodies[2]!.args[0] as {
      ownerId: string;
      contextId: string;
      subKey: string;
    };
    expect(evalArgs).toMatchObject({
      ownerId: "session:fresh",
      contextId: "ctx_fresh",
      subKey: "system-tests",
    });
  });

  it("records a doctor-verified loopback gateway for later headless polling", async () => {
    transportMock.handle = (body) => {
      if (body.method === "eval.run") {
        return {
          success: true,
          console: "",
          returnValue: {
            ok: true,
            checks: [
              {
                name: "server",
                ok: true,
                detail: "reachable",
                data: {
                  serverUrl: "http://127.0.0.1:3031",
                  protocol: "http",
                  externalHost: "127.0.0.1",
                  gatewayPort: 3031,
                  serverId: `srv_${"S".repeat(24)}`,
                  serverBootId: "boot_local",
                  workspaceId: "ws_local",
                  callerKind: "do",
                },
              },
            ],
          },
        };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "doctor", "--json"])).resolves.toBe(0);

    const target = JSON.parse(
      fs.readFileSync(path.join(root, ".config", "vibestudio", "system-test-target.json"), "utf8")
    );
    expect(target).toMatchObject({
      schemaVersion: 1,
      pairedUrl: "webrtc://room-cli/_workspace/dev",
      workspaceName: "dev",
      serverUrl: "http://127.0.0.1:3031",
      serverId: `srv_${"S".repeat(24)}`,
      serverBootId: "boot_local",
      workspaceId: "ws_local",
    });
    expect(
      fs.statSync(path.join(root, ".config", "vibestudio", "system-test-target.json")).mode & 0o777
    ).toBe(0o600);
  });

  it("starts a detached durable run and saves local routing metadata", async () => {
    transportMock.handle = (body) => {
      if (body.method === "eval.startRun") {
        const runId = (body.args[0] as { runId: string }).runId;
        return { runId };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(
      main([
        "system-test",
        "run",
        "eval-return-value",
        "--model",
        "openai:test",
        "--detach",
        "--json",
      ])
    ).resolves.toBe(0);

    const value = output() as { runId: string; status: string };
    expect(value.runId).toMatch(/^st_/);
    expect(value.status).toBe("running");
    const start = transportMock.rpcBodies.find((body) => body.method === "eval.startRun")!;
    const args = start.args[0] as {
      ownerId: string;
      contextId: string;
      subKey: string;
      code: string;
    };
    expect(args).toMatchObject({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
    });
    expect(args.code).toContain("runSystemTests");
    expect(args.code).toContain("openai:test");
    expect(args.code).toContain("updatedAt: new Date().toISOString()");
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(root, ".config", "vibestudio", "system-test-runs", value.runId, "run.json"),
        "utf8"
      )
    ) as { ownerId: string; artifactDir: string; config: { names: string[] } };
    expect(stored.ownerId).toBe("session:default");
    expect(stored.artifactDir).toBe(
      path.join(root, ".config", "vibestudio", "system-test-runs", value.runId)
    );
    expect(stored.config.names).toEqual(["eval-return-value"]);
  });

  it("preserves a custom artifact directory across detached status and run listing", async () => {
    const runId = "st_custom_status";
    const runDir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    const artifactDir = path.join(root, "custom-artifacts", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        artifactDir,
        config: { names: ["eval-return-value"], all: false, concurrency: 1 },
      })
    );
    transportMock.handle = (body) =>
      body.method === "eval.getRun"
        ? {
            status: "done",
            result: {
              success: true,
              console: "",
              returnValue: { runId, passed: 1, failed: 0, errored: 0, toolFailureCount: 0 },
            },
          }
        : null;
    const { main } = await import("./client.js");

    await expect(main(["system-test", "status", runId, "--json"])).resolves.toBe(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDir, "summary.json"), "utf8"))
    ).toMatchObject({ runId, passed: 1 });
    expect(fs.existsSync(path.join(runDir, "summary.json"))).toBe(false);

    await expect(main(["system-test", "runs", "--json"])).resolves.toBe(0);
    expect(output()).toEqual([expect.objectContaining({ runId, artifactDir })]);
  });

  it("polls status and maps a completed failing summary to exit 1", async () => {
    const runId = "st_12345678";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        config: {
          names: ["eval-return-value"],
          all: false,
          concurrency: 1,
          testTimeoutMs: 100,
        },
      })
    );
    transportMock.handle = (body) =>
      body.method === "eval.getRun"
        ? {
            status: "done",
            progress: {
              runId,
              status: "completed",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:10.000Z",
              total: 1,
              queued: [],
              running: [],
              completed: [],
            },
            result: {
              success: true,
              console: "",
              returnValue: { runId, passed: 0, failed: 1, errored: 0, toolFailureCount: 0 },
            },
          }
        : null;
    const { main } = await import("./client.js");

    await expect(
      main(["system-test", "status", runId, "--wait", "--poll-ms", "1", "--json"])
    ).resolves.toBe(1);
    expect(output()).toMatchObject({ runId, status: "done", progress: { elapsedMs: 10_000 } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"))).toMatchObject({
      runId,
      failed: 1,
      toolFailureCount: 0,
    });

    await expect(main(["system-test", "wait", runId, "--poll-ms", "1", "--json"])).resolves.toBe(1);
    expect(output()).toMatchObject({ runId, status: "done", progress: { elapsedMs: 10_000 } });
  });

  it("includes durable per-test progress while a detached run is active", async () => {
    const runId = "st_progress1";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        config: {
          names: ["eval-return-value"],
          all: false,
          concurrency: 1,
          testTimeoutMs: 100,
        },
      })
    );
    transportMock.handle = (body) => {
      if (body.method === "eval.getRun") {
        return {
          status: "running",
          progress: {
            runId,
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
            total: 1,
            queued: [],
            running: [
              {
                name: "eval-return-value",
                category: "smoke",
                startedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            completed: [],
            liveInspection: {
              inspect: { runId, status: "running" },
              trajectories: {
                "eval-return-value": {
                  bounded: {
                    test: { name: "eval-return-value" },
                    result: { passed: false, reason: "System test is still running" },
                  },
                },
              },
            },
          },
        };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "status", runId, "--json"])).resolves.toBe(0);
    expect(output()).toMatchObject({
      runId,
      status: "running",
      progress: {
        total: 1,
        running: [{ name: "eval-return-value", elapsedMs: expect.any(Number) }],
      },
    });
    expect((output() as Record<string, Record<string, unknown>>)["progress"]).not.toHaveProperty(
      "liveInspection"
    );
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual(["eval.getRun"]);

    await expect(
      main(["system-test", "trajectory", runId, "eval-return-value", "--json"])
    ).resolves.toBe(0);
    expect(output()).toMatchObject({
      test: { name: "eval-return-value" },
      result: { reason: "System test is still running" },
    });
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "eval.getRun",
      "eval.getRun",
    ]);

    await expect(
      main(["system-test", "inspect", runId, "--test", "eval-return-value", "--json"])
    ).resolves.toBe(0);
    expect(output()).toMatchObject({ test: { name: "eval-return-value" } });

    await expect(
      main(["system-test", "trajectory", runId, "eval-return-value", "--full", "--json"])
    ).resolves.toBe(0);
    expect(output()).toMatchObject({
      available: false,
      live: true,
      bounded: { test: { name: "eval-return-value" } },
    });
  });

  it("routes a persisted run through the session's current context after recovery", async () => {
    const runId = "st_recovered";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_before_restart",
        subKey: "default",
        config: { names: ["eval-return-value"], all: false, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    transportMock.handle = (body) =>
      body.method === "eval.getRun"
        ? { status: "running", progress: { runId, status: "running", total: 1 } }
        : null;
    const { main } = await import("./client.js");

    await expect(main(["system-test", "status", runId, "--json"])).resolves.toBe(0);

    expect(transportMock.rpcBodies[0]?.args[0]).toMatchObject({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
      runId,
    });
  });

  it("reads the durable record when the process-local run handle was lost", async () => {
    const runId = "st_after_restart";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_before_restart",
        subKey: "default",
        config: { names: ["eval-return-value"], all: false, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    transportMock.handle = (body) => {
      if (body.method === "eval.getRun") return { status: "unknown" };
      if (body.method === "eval.run") {
        return { success: true, console: "", returnValue: { runId, failed: 0 } };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "inspect", runId, "--json"])).resolves.toBe(0);

    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual(["eval.getRun", "eval.run"]);
    expect(output()).toMatchObject({ runId, failed: 0 });
  });

  it("pages and reconstructs a large inspect result from the EvalDO spill", async () => {
    const runId = "st_large_inspect";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        config: { names: ["large"], all: false, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    const fullValue = { runId, payload: "x".repeat(35_000) };
    const fullText = JSON.stringify(fullValue, null, 2);
    let inspectReturned = false;
    transportMock.handle = (body) => {
      if (body.method === "eval.getRun") return { status: "unknown" };
      if (body.method === "eval.readScopeTextPage") {
        const args = body.args[0] as { offset: number; limit: number };
        return {
          length: fullText.length,
          encoding: "utf16le-base64",
          chunk: Buffer.from(
            fullText.slice(args.offset, args.offset + args.limit),
            "utf16le"
          ).toString("base64"),
        };
      }
      if (body.method === "eval.deleteScopeValue") return { ok: true, existed: true };
      if (body.method !== "eval.run") return null;
      const code = String((body.args[0] as { code: string }).code);
      if (!inspectReturned) {
        inspectReturned = true;
        return {
          success: true,
          console: "",
          returnValue: {
            truncated: true,
            scopeKey: "$lastReturn",
            originalChars: fullText.length,
          },
        };
      }
      const match = code.match(/source\.slice\((\d+), (\d+)\)/);
      expect(match).not.toBeNull();
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      return {
        success: true,
        console: "",
        returnValue: {
          length: fullText.length,
          encoding: "utf16le-base64",
          chunk: Buffer.from(fullText.slice(start, end), "utf16le").toString("base64"),
        },
      };
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "inspect", runId, "--json"])).resolves.toBe(0);

    expect(output()).toEqual(fullValue);
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "eval.getRun",
      "eval.run",
      "eval.run",
      "eval.readScopeTextPage",
      "eval.deleteScopeValue",
    ]);
  });

  it("reconstructs a full trajectory larger than the generic EvalDO spill from read-only pages", async () => {
    const runId = "st_large_trajectory";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        config: { names: ["huge"], all: false, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    const fullValue = { test: { name: "huge" }, payload: "x".repeat(1_010_000) };
    const fullText = JSON.stringify(fullValue, null, 2);
    let initialReturned = false;
    transportMock.handle = (body) => {
      if (body.method === "eval.getRun") return { status: "unknown" };
      if (body.method === "eval.readScopeTextPage") {
        const args = body.args[0] as { offset: number; limit: number };
        return {
          length: fullText.length,
          encoding: "utf16le-base64",
          chunk: Buffer.from(
            fullText.slice(args.offset, args.offset + args.limit),
            "utf16le"
          ).toString("base64"),
        };
      }
      if (body.method === "eval.deleteScopeValue") return { ok: true, existed: true };
      if (body.method !== "eval.run") return null;
      const code = String((body.args[0] as { code: string }).code);
      if (!initialReturned) {
        initialReturned = true;
        return {
          success: true,
          console: "",
          returnValue: {
            truncated: true,
            scopeKey: "$lastReturn",
            originalChars: fullText.length,
          },
        };
      }
      expect(code).toContain("systemTestTrajectory(record");
      expect(code).toContain("scope[pageKey]");
      expect(code).not.toContain("scope.$lastReturn");
      const match = code.match(/source\.slice\((\d+), (\d+)\)/);
      expect(match).not.toBeNull();
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      return {
        success: true,
        console: "",
        returnValue: {
          length: fullText.length,
          encoding: "utf16le-base64",
          chunk: Buffer.from(fullText.slice(start, end), "utf16le").toString("base64"),
        },
      };
    };
    const { main } = await import("./client.js");

    await expect(
      main(["system-test", "trajectory", runId, "huge", "--full", "--json"])
    ).resolves.toBe(0);

    expect(output()).toEqual(fullValue);
    expect(transportMock.rpcBodies.filter((body) => body.method === "eval.run")).toHaveLength(2);
    expect(
      transportMock.rpcBodies.filter((body) => body.method === "eval.readScopeTextPage").length
    ).toBeLessThan(10);
    expect(transportMock.rpcBodies.at(-1)?.method).toBe("eval.deleteScopeValue");
  });

  it("reruns from the restrictive local summary after the durable workspace was replaced", async () => {
    const runId = "st_local_summary";
    const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_before_restart",
        subKey: "default",
        config: { names: [], all: true, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        failedTests: ["failed-test"],
        testsWithUnexpectedToolFailures: ["probe-test", "failed-test"],
      })
    );
    transportMock.handle = (body) => {
      if (body.method === "eval.startRun") {
        return { runId: (body.args[0] as { runId: string }).runId };
      }
      if (body.method === "eval.getRun") {
        return {
          status: "done",
          result: {
            success: true,
            console: "",
            returnValue: { passed: 2, failed: 0, errored: 0, toolFailureCount: 0 },
          },
        };
      }
      return null;
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "rerun", runId, "--json"])).resolves.toBe(0);

    const start = transportMock.rpcBodies.find((body) => body.method === "eval.startRun")!;
    const code = String((start.args[0] as { code: string }).code);
    expect(code).toContain('"names":["failed-test","probe-test"]');
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "eval.startRun",
      "eval.getRun",
    ]);
  });

  it("reruns from a custom artifact directory recorded with the source run", async () => {
    const runId = "st_custom_summary";
    const runDir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
    const artifactDir = path.join(root, "custom-artifacts", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        createdAt: 1,
        serverUrl: "webrtc://room-cli/_workspace/dev",
        sessionName: "default",
        ownerId: "session:default",
        contextId: "ctx_before_restart",
        subKey: "default",
        artifactDir,
        config: { names: [], all: true, concurrency: 1, testTimeoutMs: 100 },
      })
    );
    fs.writeFileSync(
      path.join(artifactDir, "summary.json"),
      JSON.stringify({ failedTests: ["failed-custom"], testsWithUnexpectedToolFailures: [] })
    );
    transportMock.handle = (body) => {
      if (body.method === "eval.startRun") {
        return { runId: (body.args[0] as { runId: string }).runId };
      }
      if (body.method === "eval.getRun") {
        return {
          status: "done",
          result: {
            success: true,
            console: "",
            returnValue: { passed: 1, failed: 0, errored: 0, toolFailureCount: 0 },
          },
        };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    const { main } = await import("./client.js");

    await expect(main(["system-test", "rerun", runId, "--json"])).resolves.toBe(0);

    const start = transportMock.rpcBodies.find((body) => body.method === "eval.startRun")!;
    expect(String((start.args[0] as { code: string }).code)).toContain('"names":["failed-custom"]');
  });

  it("rejects an unselected run before contacting the server", async () => {
    const { main } = await import("./client.js");
    await expect(main(["system-test", "run", "--json"])).resolves.toBe(2);
    expect(transportMock.rpcBodies).toEqual([]);
  });
});
