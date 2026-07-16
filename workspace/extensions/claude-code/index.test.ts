import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertClaudeCodeVersion } from "@vibestudio/shared/claudeLaunchProfile";

const childProcessMock = vi.hoisted(() => {
  const child = {
    pid: 4242,
    on: vi.fn(),
    kill: vi.fn(() => true),
  };
  child.on.mockReturnValue(child);
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMock.spawn,
}));

// The executing-host version probe is deterministic in orchestration tests;
// declaration parsing and filesystem materialization remain real.
vi.mock("@vibestudio/shared/claudeLaunchProfile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vibestudio/shared/claudeLaunchProfile")>()),
  assertClaudeCodeVersion: vi.fn(async () => "2.1.81"),
}));

import { activate } from "./index.js";

const CHANNEL = "chan-1";
const CONTEXT = "ctx-1";

function makeCtx(tmpRoot: string) {
  const contextProjectionsPath = path.join(tmpRoot, ".context-projections", "v5");
  const contextFolder = path.join(contextProjectionsPath, CONTEXT);
  mkdirSync(contextFolder, { recursive: true });

  const storage = new Map<string, string>();
  let mintSeq = 0;
  const revoked: string[] = [];

  const rpcCall = vi.fn(async (target: string, method: string, ...args: unknown[]) => {
    if (method === "getContextId") return CONTEXT;
    if (method === "runtime.createEntity") {
      const spec = args[0] as { kind: string; key: string };
      if (spec.kind === "session") {
        return { id: `session:${spec.key}`, contextId: CONTEXT, targetId: `session:${spec.key}` };
      }
      return {
        id: `do:${spec.key}`,
        contextId: CONTEXT,
        targetId: `do:workers/linked-agent:LinkedAgentWorker:${spec.key}`,
      };
    }
    if (method === "subscribeChannel") return { ok: true, participantId: "p1" };
    if (method === "auth.mintAgentCredential") {
      mintSeq += 1;
      return { agentId: `agt_${mintSeq}`, agentToken: `agent:agt_${mintSeq}:tok` };
    }
    if (method === "auth.revokeAgentCredential") {
      revoked.push(args[0] as string);
      return { revoked: true };
    }
    if (method === "reportExternalExit") return { ok: true, settled: true };
    throw new Error(`unexpected rpc ${target} ${method}`);
  });

  const approvalsRequest = vi.fn(async () => ({ kind: "choice", choice: "allow" }));

  const ctx = {
    rpc: { call: rpcCall },
    workers: {
      resolveService: vi.fn(async () => ({
        kind: "durable-object",
        targetId: `do:PubSubChannel:${CHANNEL}`,
      })),
    },
    workspace: {
      getInfo: vi.fn(async () => ({
        id: "ws",
        name: "ws",
        path: tmpRoot,
        statePath: path.join(tmpRoot, "state"),
        contextProjectionsPath,
      })),
      ensureContextFolder: vi.fn(async () => ({ dir: contextFolder })),
    },
    storage: {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async (p: string) => {
        if (!storage.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return storage.get(p)!;
      }),
      writeFile: vi.fn(async (p: string, data: string) => {
        storage.set(p, data);
      }),
    },
    approvals: { request: approvalsRequest },
    extensions: { invoke: vi.fn(async () => {}) },
    invocation: { current: vi.fn<() => unknown>(() => null) },
    health: { healthy: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  return { ctx, approvalsRequest, rpcCall, revoked, contextFolder };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "claude-ext-test-"));
  vi.stubEnv("VIBESTUDIO_EXTENSION_GATEWAY_URL", "http://127.0.0.1:5000/rpc");
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  childProcessMock.spawn.mockClear();
  childProcessMock.child.on.mockClear();
  childProcessMock.child.kill.mockClear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("@workspace-extensions/claude-code prepare", () => {
  it("keeps only adaptLaunch flat and matches the declared provider contract", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: {
        extension: { providerContracts: { claudeCode: { methods: string[] } } };
      };
    };

    expect(Object.keys(activated)).toEqual(["providerContracts", "adaptLaunch"]);
    expect(Object.keys(activated.providerContracts.claudeCode)).toEqual(
      manifest.vibestudio.extension.providerContracts.claudeCode.methods
    );
  });

  it("prepares without reading a host context binding or gateway path", async () => {
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const result = await api.prepare({ channelId: CHANNEL });

    expect(result.contextId).toBe(CONTEXT);
    expect(result.channelId).toBe(CHANNEL);
    expect(result.profile.environment.VIBESTUDIO_CHANNEL_ID).toBe(CHANNEL);
    expect(result.profile.environment.VIBESTUDIO_AGENT_TOKEN).toBe("agent:agt_1:tok");
    expect(result.profile.executable).toBe("claude");
    expect(JSON.stringify(result.profile)).not.toMatch(
      /contextFolder|SERVER_URL|LAUNCH_PROFILE|SKILLS_DIR/
    );
    expect(existsSync(path.join(tmpRoot, "state", "agent-launch"))).toBe(false);
    expect(ctx.workspace.ensureContextFolder).not.toHaveBeenCalled();
    expect(approvalsRequest).toHaveBeenCalledTimes(1);
    expect(rpcCall.mock.calls.find((c) => c[1] === "auth.mintAgentCredential")?.[2]).toEqual({
      entityId: "session:chan-1",
    });
    const sessionCreate = rpcCall.mock.calls.find(
      (c) => c[1] === "runtime.createEntity" && (c[2] as { kind: string }).kind === "session"
    );
    expect((sessionCreate?.[2] as { agentChannelId?: string }).agentChannelId).toBe(CHANNEL);
    const agentCreate = rpcCall.mock.calls.find(
      (c) => c[1] === "runtime.createEntity" && (c[2] as { kind: string }).kind === "do"
    );
    expect((agentCreate?.[2] as { agentBinding?: unknown }).agentBinding).toEqual({
      entityId: "session:chan-1",
      channelId: CHANNEL,
    });
  });

  it("prepares portably when the extension gateway is absent", async () => {
    vi.stubEnv("VIBESTUDIO_EXTENSION_GATEWAY_URL", "");
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(api.prepare({ channelId: CHANNEL })).resolves.toMatchObject({
      contextId: CONTEXT,
      profile: { executable: "claude" },
    });
    expect(approvalsRequest).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalled();
  });

  it("is idempotent on re-prepare: no second approval, rotates the credential", async () => {
    const { ctx, approvalsRequest, revoked } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const first = await api.prepare({ channelId: CHANNEL });
    const second = await api.prepare({ channelId: CHANNEL });

    // Same session entity reused (deterministic key).
    expect(second.entityId).toBe(first.entityId);
    // Approval only prompted on the first prepare.
    expect(approvalsRequest).toHaveBeenCalledTimes(1);
    // The prior credential was revoked and a fresh one minted.
    expect(revoked).toEqual(["agt_1"]);
    expect(second.profile.environment.VIBESTUDIO_AGENT_TOKEN).toBe("agent:agt_2:tok");
  });

  it("records the context→channel binding for resolvePrimaryChannel", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toBeNull();
    await api.prepare({ channelId: CHANNEL });
    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toEqual({ channelId: CHANNEL });
  });

  it("materializes a local terminal launch and returns one exact cleanup action", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);

    const adapted = await activated.adaptLaunch({
      contextId: CONTEXT,
      argv: ["claude"],
      cwd: path.join(tmpRoot, ".context-projections", "v5", CONTEXT),
      env: { ORIGINAL: "yes" },
      intent: { channelId: CHANNEL },
    });

    expect(adapted?.argv[0]).toBe("claude");
    expect(adapted?.env).toMatchObject({
      ORIGINAL: "yes",
      VIBESTUDIO_SERVER_URL: "http://127.0.0.1:5000",
      VIBESTUDIO_CONTEXT_ID: CONTEXT,
    });
    const profileDir = adapted?.env["VIBESTUDIO_LAUNCH_PROFILE"];
    expect(profileDir && existsSync(path.join(profileDir, "mcp.json"))).toBe(true);
    expect(adapted?.cleanup).toEqual({
      method: "release",
      args: [
        {
          entityId: "session:chan-1",
          launchId: expect.any(String),
        },
      ],
    });
    await activated.providerContracts.claudeCode.release(
      adapted!.cleanup.args[0] as { entityId: string; launchId: string }
    );
    expect(profileDir && existsSync(profileDir)).toBe(false);
  });

  it("revokes the prepared credential when local materialization fails", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);
    vi.mocked(assertClaudeCodeVersion).mockRejectedValueOnce(new Error("unsupported local Claude"));

    await expect(
      activated.adaptLaunch({
        contextId: CONTEXT,
        argv: ["claude"],
        cwd: tmpRoot,
        env: {},
        intent: { channelId: CHANNEL },
      })
    ).rejects.toThrow("unsupported local Claude");
    expect(revoked).toEqual(["agt_1"]);
  });

  it("rejects a terminal intent for another context and releases its credential", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);

    await expect(
      activated.adaptLaunch({
        contextId: "ctx-other",
        argv: ["claude"],
        cwd: tmpRoot,
        env: {},
        intent: { channelId: CHANNEL },
      })
    ).rejects.toThrow(/not terminal context ctx-other/);
    expect(revoked).toEqual(["agt_1"]);
    expect(ctx.workspace.ensureContextFolder).not.toHaveBeenCalled();
  });

  it("subagent launch: skips the approval, threads subagent duty into vessel state, returns vessel identity", async () => {
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const subagent = {
      runId: "run-1",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.prepare({ channelId: CHANNEL, subagent });

    // No human approval for a headless subagent launch.
    expect(approvalsRequest).not.toHaveBeenCalled();
    // Vessel identity is returned for the parent's run bookkeeping.
    expect(result.vesselEntityId).toMatch(/^do:/);
    expect(result.vesselParticipantId).toBe("p1");
    // The linked vessel DO was created WITH subagent task duty in its state.
    const vesselCreate = rpcCall.mock.calls.find(
      (c) => c[1] === "runtime.createEntity" && (c[2] as { kind: string }).kind === "do"
    );
    expect(vesselCreate).toBeDefined();
    expect((vesselCreate![2] as { stateArgs: { subagent: unknown } }).stateArgs.subagent).toEqual(
      subagent
    );
  });

  it("launchSubagent prepares, spawns headless Claude privately, and release kills it", async () => {
    const { ctx, approvalsRequest } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const subagent = {
      runId: "run-1",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.launchSubagent({
      channelId: CHANNEL,
      title: "Audit",
      task: "audit the repo",
      subagent,
    });

    expect(approvalsRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      entityId: "session:chan-1",
      contextId: CONTEXT,
      channelId: CHANNEL,
      vesselEntityId: "do:linked:session:chan-1",
      vesselParticipantId: "p1",
      launchId: "claude-code:run-1",
      generationId: expect.any(String),
      pid: 4242,
    });
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = childProcessMock.spawn.mock.calls[0]! as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean; env: Record<string, string> },
    ];
    expect(command).toMatch(/\/bwrap$/);
    expect(args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        path.join(tmpRoot, ".context-projections", "v5", CONTEXT),
        path.join(tmpRoot, ".context-projections", "v5", CONTEXT),
      ])
    );
    const claudeArgs = args.slice(args.indexOf("--") + 1);
    // Subagents default to autonomous permission handling (`auto`); the task
    // rides as the terminal -p prompt.
    expect(claudeArgs.slice(0, 4)).toEqual([
      "claude",
      "--channels",
      "server:vibestudio",
      "--dangerously-load-development-channels",
    ]);
    expect(claudeArgs.slice(-4)).toEqual([
      "--permission-mode",
      "auto",
      "-p",
      "audit the repo",
    ]);
    expect(claudeArgs).toContain("--mcp-config");
    expect(claudeArgs).toContain("--settings");
    expect(options).toMatchObject({
      cwd: path.join(tmpRoot, ".context-projections", "v5", CONTEXT),
      detached: false,
    });
    expect(options.env).toMatchObject({
      VIBESTUDIO_ENTITY_ID: "session:chan-1",
      VIBESTUDIO_AGENT_TOKEN: "agent:agt_1:tok",
      // Subagent duty rides the session env so the bridge can state it in the
      // MCP instructions instead of hedging.
      VIBESTUDIO_SUBAGENT_RUN_ID: "run-1",
      VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: "home-chan",
      VIBESTUDIO_LINKED_SCRATCH: expect.stringContaining("/scratch"),
      TMPDIR: "/tmp",
    });
    expect(options.env["VIBESTUDIO_SUBAGENT_CONTRACT"]).toContain("## Subagent Operating Contract");
    expect(options.env["VIBESTUDIO_SUBAGENT_CONTRACT"]).toContain(
      "Only `complete` ends this subagent run"
    );

    const released = await api.release({
      entityId: result.entityId,
      launchId: result.generationId,
    });
    expect(released).toEqual({ released: true });
    expect(childProcessMock.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(path.dirname(result.logPath))).toBe(false);
  });

  it("maps whitelisted CLI options onto the argv and drops unsafe values", async () => {
    const { ctx } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await api.launchSubagent({
      channelId: CHANNEL,
      task: "audit the repo",
      options: {
        model: "opus",
        effort: "high",
        permissionMode: "acceptEdits",
        fallbackModel: "--inject-me", // flag-shaped value: dropped
        maxBudgetUsd: 5,
        notAFlag: "ignored", // unknown key: dropped
        maxTurns: 3, // unsupported by the CLI: dropped
      },
      subagent: {
        runId: "run-1",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        parentContextId: "ctx-parent",
        depth: 1,
        mode: "fresh",
      },
    });

    const [, args] = childProcessMock.spawn.mock.calls[0]! as unknown as [string, string[]];
    expect(args.slice(-10)).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
      "--effort",
      "high",
      "--max-budget-usd",
      "5",
      "-p",
      "audit the repo",
    ]);
  });

  it("reports an unexpected process exit to the vessel; a deliberate kill stays silent", async () => {
    const { ctx, rpcCall, revoked } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    const subagent = {
      runId: "run-1",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.launchSubagent({ channelId: CHANNEL, task: "audit", subagent });

    const exitHandler = childProcessMock.child.on.mock.calls.find((c) => c[0] === "exit")![1] as (
      code: number | null,
      signal: string | null
    ) => void;

    // The session died on its own → the vessel is told so the run settles.
    exitHandler(1, null);
    const report = rpcCall.mock.calls.find((c) => c[1] === "reportExternalExit");
    expect(report).toBeDefined();
    expect(report![0]).toBe(result.vesselRef);
    expect(report![2]).toEqual({ runId: "run-1", code: 1, signal: null });
    await vi.waitFor(() => expect(existsSync(path.dirname(result.logPath))).toBe(false));
    expect(revoked).toContain("agt_1");

    // Relaunch, then a deliberate release-kill: no exit report.
    rpcCall.mockClear();
    childProcessMock.child.on.mockClear();
    const relaunched = await api.launchSubagent({
      channelId: CHANNEL,
      task: "audit again",
      subagent,
    });
    await api.release({
      entityId: relaunched.entityId,
      launchId: relaunched.generationId,
    });
    const exitHandler2 = childProcessMock.child.on.mock.calls.find((c) => c[0] === "exit")![1] as (
      code: number | null,
      signal: string | null
    ) => void;
    exitHandler2(null, "SIGTERM");
    expect(rpcCall.mock.calls.find((c) => c[1] === "reportExternalExit")).toBeUndefined();
  });

  it("launchSubagent rejects non-agent-vessel callers", async () => {
    const { ctx } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "panel-1", callerKind: "panel" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(
      api.launchSubagent({
        channelId: CHANNEL,
        task: "audit",
        subagent: {
          runId: "run-1",
          parentRef: "do:parent",
          parentChannelId: "home-chan",
          parentContextId: "ctx-parent",
          depth: 1,
        },
      })
    ).rejects.toThrow(/parent agent vessel/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it("release revokes the credential and reports released", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const prepared = await api.prepare({ channelId: CHANNEL });
    const out = await api.release({
      entityId: prepared.entityId,
      launchId: prepared.profile.launchId,
    });
    expect(out.released).toBe(true);
    expect(revoked).toContain("agt_1");
  });

  it("a stale generation release cannot revoke the current credential", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const first = await api.prepare({ channelId: CHANNEL });
    const second = await api.prepare({ channelId: CHANNEL });
    await api.release({
      entityId: first.entityId,
      launchId: first.profile.launchId,
    });

    expect(revoked).not.toContain("agt_2");
    await api.release({
      entityId: second.entityId,
      launchId: second.profile.launchId,
    });
    expect(revoked).toContain("agt_2");
  });
});
