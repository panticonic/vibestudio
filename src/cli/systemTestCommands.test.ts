import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "@vibestudio/direct-client";

interface RpcRequest {
  method: string;
  args: unknown[];
}

const DIGEST = "a".repeat(64);
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
    retainConnection(): () => Promise<void> {
      return async () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

type EvalResult = {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
};

function snapshot(
  runId: string,
  result: EvalResult | undefined,
  options: { status?: string; progress?: unknown } = {}
) {
  const status = options.status ?? (result?.success === false ? "failed" : "succeeded");
  const provenance = {
    startIntentDigest: DIGEST,
    sourceDigest: DIGEST,
    executionProvenanceDigest: DIGEST,
    scopeInputRevision: null,
    runDigest: DIGEST,
    sourceBundleDigest: DIGEST,
    manifestDigest: DIGEST,
    terminalReason: result?.error ?? null,
  };
  return {
    runId,
    status,
    acceptedAt: 1,
    startedAt: 2,
    endedAt: ["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(status)
      ? 3
      : null,
    deadlineAt: null,
    startIntentDigest: DIGEST,
    sourceDigest: DIGEST,
    executionProvenanceDigest: DIGEST,
    scopeInputRevision: null,
    runDigest: DIGEST,
    sourceBundleDigest: DIGEST,
    manifestDigest: DIGEST,
    ...(result ? { result: { ...result, provenance } } : {}),
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
    terminalReason: result?.error ?? null,
  };
}

function installEvalLifecycle(
  input: {
    results?: EvalResult[];
    get?: (runId: string, body: RpcRequest) => unknown;
    extra?: (body: RpcRequest) => unknown;
  } = {}
): void {
  const results = [...(input.results ?? [])];
  const resultByRun = new Map<string, EvalResult | undefined>();
  let sequence = 0;
  transportMock.handle = (body) => {
    if (body.method === "eval.start") {
      const start = body.args[0] as { idempotencyKey?: string };
      const runId = start.idempotencyKey ?? `eval-${++sequence}`;
      resultByRun.set(runId, results.shift());
      return { runId, status: "accepted", acceptedAt: 1, startIntentDigest: DIGEST };
    }
    if (body.method === "eval.events") return { events: [], next: 0 };
    if (body.method === "eval.get") {
      const runId = String((body.args[0] as { runId: string }).runId);
      return input.get?.(runId, body) ?? snapshot(runId, resultByRun.get(runId));
    }
    if (body.method === "eval.cancel") return { status: "requested" };
    const extra = input.extra?.(body);
    if (extra !== undefined) return extra;
    if (body.method === "runtime.listEntities") {
      return [
        {
          id: "session:default",
          kind: "session",
          source: "agent-cli",
          contextId: "ctx_1",
          createdAt: 1,
        },
      ];
    }
    throw new Error(`unexpected method ${body.method}`);
  };
}

function writeCredentials(root: string): void {
  const dir = path.join(root, ".config", "vibestudio");
  fs.mkdirSync(path.join(dir, "agent-sessions"), { recursive: true });
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

function writeRun(root: string, runId: string, overrides: Record<string, unknown> = {}): string {
  const dir = path.join(root, ".config", "vibestudio", "system-test-runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId,
      evalRunId: `eval-${runId}`,
      createdAt: 1,
      serverUrl: "webrtc://room-cli/_workspace/dev",
      sessionName: "default",
      ownerId: "session:default",
      contextId: "ctx_before_restart",
      subKey: "default",
      artifactDir: dir,
      config: { names: ["eval-return-value"], all: false, concurrency: 1 },
      ...overrides,
    })
  );
  return dir;
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
    // os.homedir() may be process-cached on some Node builds. Pin the actual
    // Linux path contract as well so a developer's live system-test target can
    // never leak into this CLI unit harness.
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, ".config"));
    vi.stubEnv("XDG_STATE_HOME", path.join(root, ".state"));
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

  it("lists the server catalog through start/events/get lifecycle composition", async () => {
    installEvalLifecycle({
      results: [
        {
          success: true,
          console: "",
          returnValue: [{ name: "eval-return-value", category: "smoke", description: "compute" }],
        },
      ],
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "list", "--category", "smoke", "--json"])).resolves.toBe(0);

    expect(output()).toEqual([
      { name: "eval-return-value", category: "smoke", description: "compute" },
    ]);
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "eval.start",
      "eval.events",
      "eval.get",
    ]);
    const start = transportMock.rpcBodies[1]!.args[0] as {
      source: { code: string };
      target: { ownerId: string; contextId: string };
      scope: { key: string };
    };
    expect(start.source.code).toContain("listSystemTests");
    expect(start.source.code).toContain('const category = "smoke"');
    expect(start).toMatchObject({
      target: { ownerId: "session:default", contextId: "ctx_1" },
      scope: { key: "default" },
    });
  });

  it("creates a dedicated session when no ambient scope exists", async () => {
    fs.rmSync(path.join(root, ".config", "vibestudio", "agent-sessions", "default.json"));
    installEvalLifecycle({
      results: [{ success: true, console: "", returnValue: [] }],
      extra: (body) =>
        body.method === "runtime.createEntity"
          ? {
              id: "session:system-tests",
              kind: "session",
              source: { repoPath: "agent-cli" },
              contextId: "ctx_system_tests",
              targetId: "session:system-tests",
            }
          : undefined,
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "list", "--json"])).resolves.toBe(0);

    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.createEntity",
      "eval.start",
      "eval.events",
      "eval.get",
    ]);
    expect(transportMock.rpcBodies[1]!.args[0]).toMatchObject({
      target: { ownerId: "session:system-tests", contextId: "ctx_system_tests" },
      scope: { key: "system-tests" },
    });
  });

  it("reconciles a stale default session before starting system eval", async () => {
    installEvalLifecycle({
      results: [{ success: true, console: "", returnValue: [] }],
      extra: (body) => {
        if (body.method === "runtime.listEntities") return [];
        if (body.method === "runtime.createEntity") {
          return {
            id: "session:default",
            kind: "session",
            source: { repoPath: "agent-cli" },
            contextId: "ctx_after_restart",
            targetId: "session:default",
          };
        }
        return undefined;
      },
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "list", "--json"])).resolves.toBe(0);

    expect(transportMock.rpcBodies.map((body) => body.method).slice(0, 3)).toEqual([
      "runtime.listEntities",
      "runtime.createEntity",
      "eval.start",
    ]);
    expect(transportMock.rpcBodies[2]!.args[0]).toMatchObject({
      target: { ownerId: "session:default", contextId: "ctx_after_restart" },
      scope: { key: "default" },
    });
  });

  it("records a doctor-verified loopback gateway with restrictive permissions", async () => {
    installEvalLifecycle({
      results: [
        {
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
                  serverId: `srv_${"S".repeat(24)}`,
                  serverBootId: "boot_local",
                  workspaceId: "ws_local",
                },
              },
            ],
          },
        },
      ],
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "doctor", "--json"])).resolves.toBe(0);

    const targetPath = path.join(root, ".config", "vibestudio", "system-test-target.json");
    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      serverUrl: "http://127.0.0.1:3031",
      serverBootId: "boot_local",
      workspaceId: "ws_local",
    });
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it("starts a detached durable eval and saves exact routing metadata", async () => {
    installEvalLifecycle();
    const { main } = await import("./client.js");

    await expect(
      main([
        "system-test",
        "run",
        "eval-return-value",
        "--model",
        "openai:test",
        "--approval-policy",
        "reachable",
        "--detach",
        "--json",
      ])
    ).resolves.toBe(0);

    const value = output() as { runId: string; status: string };
    expect(value).toMatchObject({ runId: expect.stringMatching(/^st_/), status: "running" });
    const start = transportMock.rpcBodies.find((body) => body.method === "eval.start")!;
    const input = start.args[0] as {
      source: { code: string };
      target: { ownerId: string; contextId: string };
      scope: { key: string };
      idempotencyKey: string;
    };
    expect(input).toMatchObject({
      target: { ownerId: "session:default", contextId: "ctx_1" },
      scope: { key: "default" },
      idempotencyKey: value.runId,
    });
    expect(input.source.code).toContain("runSystemTests");
    expect(input.source.code).toContain("openai:test");
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(root, ".config", "vibestudio", "system-test-runs", value.runId, "run.json"),
        "utf8"
      )
    ) as {
      evalRunId: string;
      ownerId: string;
      config: { names: string[]; testTimeoutMs?: number; approvalPolicy: string };
    };
    expect(stored).toMatchObject({
      evalRunId: value.runId,
      ownerId: "session:default",
      config: {
        names: ["eval-return-value"],
        approvalPolicy: "reachable",
      },
    });
  });

  it("cancels the durable run when a foreground command is interrupted", async () => {
    installEvalLifecycle({
      get: (runId) => snapshot(runId, undefined, { status: "running" }),
    });
    const { main } = await import("./client.js");
    const priorSigintListeners = new Set(process.listeners("SIGINT"));

    const running = main(["system-test", "run", "eval-return-value", "--poll-ms", "1", "--json"]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (transportMock.rpcBodies.some((body) => body.method === "eval.get")) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const interrupt = process
      .listeners("SIGINT")
      .find((listener) => !priorSigintListeners.has(listener));
    expect(interrupt).toBeDefined();
    interrupt!("SIGINT");

    await expect(running).resolves.toBe(1);
    expect(transportMock.rpcBodies.map((body) => body.method)).toContain("eval.cancel");
    expect(
      process.listeners("SIGINT").filter((listener) => !priorSigintListeners.has(listener))
    ).toEqual([]);
  });

  it("reads terminal status, durable progress, and persists a failing summary", async () => {
    const runId = "st_status";
    const dir = writeRun(root, runId);
    const summary = { runId, passed: 0, failed: 1, errored: 0, toolFailureCount: 0 };
    installEvalLifecycle({
      get: (evalRunId) =>
        snapshot(
          evalRunId,
          { success: true, console: "", returnValue: summary },
          {
            progress: {
              runId,
              status: "completed",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:10.000Z",
              running: [],
            },
          }
        ),
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "status", runId, "--json"])).resolves.toBe(1);

    expect(output()).toMatchObject({
      runId,
      status: "succeeded",
      progress: { elapsedMs: 10_000 },
      summary,
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"))).toEqual(summary);
    expect(transportMock.rpcBodies[1]!.args[0]).toMatchObject({
      runId: `eval-${runId}`,
      target: { contextId: "ctx_1" },
    });
  });

  it("serves bounded live inspection without launching another eval", async () => {
    const runId = "st_live1";
    writeRun(root, runId);
    installEvalLifecycle({
      get: (evalRunId) =>
        snapshot(evalRunId, undefined, {
          status: "running",
          progress: {
            runId,
            status: "running",
            liveInspection: {
              inspect: { runId, status: "running" },
              trajectories: {
                "eval-return-value": {
                  bounded: {
                    test: { name: "eval-return-value" },
                    result: { reason: "still running" },
                  },
                },
              },
            },
          },
        }),
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "inspect", runId, "--json"])).resolves.toBe(0);
    expect(output()).toMatchObject({ runId, status: "running" });
    await expect(
      main(["system-test", "trajectory", runId, "eval-return-value", "--full", "--json"])
    ).resolves.toBe(0);
    expect(output()).toMatchObject({ available: false, live: true });
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "eval.get",
      "runtime.listEntities",
      "eval.get",
    ]);
  });

  it("reconstructs a large persisted inspection through its deterministic pager", async () => {
    const runId = "st_large_inspect";
    writeRun(root, runId);
    const inspection = {
      runId,
      status: "failed",
      result: { reason: "diagnostic:" + "x".repeat(70_000) },
    };
    const serialized = JSON.stringify(inspection, null, 2);
    const firstPage = serialized.slice(0, 20_000);
    installEvalLifecycle({
      results: [
        {
          success: true,
          console: "",
          returnValue: {
            truncated: true,
            scopeKey: "$lastReturn",
            // The deterministic reconstruction, not the generic spill marker,
            // is authoritative for persisted inspect output.
            originalChars: serialized.length + 17,
          },
        },
        {
          success: true,
          console: "",
          returnValue: {
            length: serialized.length,
            encoding: "utf16le-base64",
            chunk: Buffer.from(firstPage, "utf16le").toString("base64"),
          },
        },
      ],
      get: (evalRunId) =>
        evalRunId === `eval-${runId}`
          ? snapshot(evalRunId, { success: true, console: "", returnValue: { runId } })
          : undefined,
      extra: (body) => {
        if (body.method === "eval.readScopeTextPage") {
          const input = body.args[0] as { offset: number; limit: number };
          const chunk = serialized.slice(input.offset, input.offset + input.limit);
          return {
            length: serialized.length,
            encoding: "utf16le-base64",
            chunk: Buffer.from(chunk, "utf16le").toString("base64"),
          };
        }
        if (body.method === "eval.deleteScopeValue") return { ok: true, existed: true };
        return undefined;
      },
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "inspect", runId, "--json"])).resolves.toBe(0);

    expect(output()).toEqual(inspection);
    expect(transportMock.rpcBodies.some((body) => body.method === "eval.readScopeTextPage")).toBe(
      true
    );
    const pagerStart = transportMock.rpcBodies.filter((body) => body.method === "eval.start")[1]!;
    expect(String((pagerStart.args[0] as { source: { code: string } }).source.code)).toContain(
      "inspectSystemTestRun(record"
    );
  });

  it("reruns failures from the restrictive local summary through a new eval handle", async () => {
    const runId = "st_prior";
    const dir = writeRun(root, runId, {
      config: { names: [], all: true, concurrency: 1, testTimeoutMs: 100 },
    });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        failedTests: ["failed-test"],
        testsWithUnexpectedToolFailures: ["probe-test", "failed-test"],
      })
    );
    installEvalLifecycle({
      results: [
        {
          success: true,
          console: "",
          returnValue: { passed: 2, failed: 0, errored: 0, toolFailureCount: 0 },
        },
      ],
    });
    const { main } = await import("./client.js");

    await expect(main(["system-test", "rerun", runId, "--poll-ms", "1", "--json"])).resolves.toBe(
      0
    );

    const start = transportMock.rpcBodies.find((body) => body.method === "eval.start")!;
    expect(String((start.args[0] as { source: { code: string } }).source.code)).toContain(
      '"names":["failed-test","probe-test"]'
    );
    expect(transportMock.rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "eval.start",
      "eval.get",
    ]);
  });

  it("rejects an unselected run before contacting the server", async () => {
    const { main } = await import("./client.js");
    await expect(main(["system-test", "run", "--json"])).resolves.toBe(2);
    expect(transportMock.rpcBodies).toEqual([]);
  });
});
