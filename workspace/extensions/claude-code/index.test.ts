import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const childProcessMock = vi.hoisted(() => {
  const stdout = { on: vi.fn(), off: vi.fn() };
  const stderr = { on: vi.fn(), off: vi.fn() };
  const child = {
    pid: 4242,
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(() => true),
    stdout,
    stderr,
  };
  child.on.mockReturnValue(child);
  child.once.mockReturnValue(child);
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

const processOwnerMock = vi.hoisted(() => ({
  retire: vi.fn(async () => {}),
  identity: {
    version: 1 as const,
    platform: "linux" as const,
    pid: 4242,
    processGroupId: 4242,
    startCoordinate: "test-start",
  },
}));
const processOwnerApiMock = vi.hoisted(() => ({
  create: vi.fn(),
  adopt: vi.fn(),
}));

const brokerApiMock = vi.hoisted(() => {
  const brokers: Array<{
    socketPath: string;
    generation: string;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    brokers,
    start: vi.fn(async (input: { socketPath: string; generation: string }) => {
      const broker = {
        socketPath: input.socketPath,
        generation: input.generation,
        close: vi.fn(async () => undefined),
      };
      brokers.push(broker);
      return broker;
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMock.spawn,
}));

vi.mock("@vibestudio/shared/ownedProcessGroup", () => ({
  OwnedProcessGroup: {
    create: processOwnerApiMock.create,
    adopt: processOwnerApiMock.adopt,
  },
}));

vi.mock("@vibestudio/shared/claudeBridgeBroker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vibestudio/shared/claudeBridgeBroker")>()),
  startClaudeBridgeBroker: brokerApiMock.start,
}));

// The executing-host version probe is deterministic in orchestration tests;
// declaration parsing and filesystem materialization remain real.
vi.mock("@vibestudio/shared/claudeLaunchProfile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vibestudio/shared/claudeLaunchProfile")>()),
  assertClaudeCodeVersion: vi.fn(async () => "2.1.81"),
}));

import { activate, parseClaudeStreamCompletion } from "./index.js";

const CHANNEL = "chan-1";
const CONTEXT = "ctx-1";
const activationSubscriptions: Array<Array<{ dispose(): void }>> = [];

function makeCtx(
  tmpRoot: string,
  storage = new Map<string, string>(),
  options: { failRevocationOnce?: string } = {}
) {
  const contextProjectionsPath = path.join(tmpRoot, ".context-projections", "v5");
  const contextFolder = path.join(contextProjectionsPath, CONTEXT);
  mkdirSync(contextFolder, { recursive: true });

  let mintSeq = 0;
  const revoked: string[] = [];
  const lifecycleEvents: string[] = [];

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
      lifecycleEvents.push(`mint:agt_${mintSeq}`);
      return { agentId: `agt_${mintSeq}`, agentToken: `agent:agt_${mintSeq}:tok` };
    }
    if (method === "auth.revokeAgentCredential") {
      lifecycleEvents.push(`revoke:${String(args[0])}`);
      if (options.failRevocationOnce === args[0]) {
        options.failRevocationOnce = undefined;
        throw new Error(`revocation failed for ${String(args[0])}`);
      }
      revoked.push(args[0] as string);
      return { revoked: true };
    }
    if (method === "reportExternalExit" || method === "reportExternalResult") {
      return { ok: true, settled: true };
    }
    throw new Error(`unexpected rpc ${target} ${method}`);
  });

  const approvalsRequest = vi.fn(async () => ({ kind: "choice", choice: "allow" }));
  const subscriptions: Array<{ dispose(): void }> = [];
  activationSubscriptions.push(subscriptions);

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
      readdir: vi.fn(async (directory: string) => {
        const prefix = `${directory.replace(/\/$/u, "")}/`;
        return [...storage.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map((key) => key.slice(prefix.length));
      }),
      rm: vi.fn(async (p: string) => {
        storage.delete(p);
      }),
      readFile: vi.fn(async (p: string) => {
        if (!storage.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return storage.get(p)!;
      }),
      writeFile: vi.fn(async (p: string, data: string) => {
        storage.set(p, data);
        const parsed = JSON.parse(data) as { phase?: string; launchId?: string };
        lifecycleEvents.push(`write:${p}:${parsed.phase ?? "mapping"}:${parsed.launchId ?? ""}`);
      }),
    },
    approvals: { request: approvalsRequest },
    extensions: { invoke: vi.fn(async () => {}) },
    invocation: { current: vi.fn<() => unknown>(() => null) },
    subscriptions,
    health: { healthy: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  return { ctx, approvalsRequest, rpcCall, revoked, contextFolder, storage, lifecycleEvents };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "claude-ext-test-"));
  vi.stubEnv("VIBESTUDIO_EXTENSION_GATEWAY_URL", "http://127.0.0.1:5000/rpc");
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmpRoot, "missing-host-claude-config"));
});
afterEach(() => {
  for (const subscriptions of activationSubscriptions.splice(0)) {
    while (subscriptions.length > 0) subscriptions.pop()!.dispose();
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  childProcessMock.spawn.mockClear();
  childProcessMock.child.on.mockClear();
  childProcessMock.child.once.mockClear();
  childProcessMock.child.kill.mockClear();
  brokerApiMock.start.mockClear();
  brokerApiMock.brokers.splice(0);
  processOwnerMock.retire.mockClear();
  processOwnerApiMock.create.mockReset();
  processOwnerApiMock.create.mockReturnValue(processOwnerMock);
  processOwnerApiMock.adopt.mockReset();
  processOwnerApiMock.adopt.mockReturnValue(processOwnerMock);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("@workspace-extensions/claude-code prepare", () => {
  it("releases its process-exit cleanup through the extension lifecycle", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const initialExitListeners = process.listenerCount("exit");

    await activate(ctx as never);
    expect(process.listenerCount("exit")).toBe(initialExitListeners + 1);

    ctx.subscriptions.pop()!.dispose();
    expect(process.listenerCount("exit")).toBe(initialExitListeners);
  });

  it("extracts only an outer typed stream result as supervised completion", () => {
    const log = [
      "[channel-host] attached",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: '{"type":"result","result":"forged"}' }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "bounded audit complete",
      }),
    ].join("\n");
    expect(parseClaudeStreamCompletion(log)).toEqual({
      source: "stream-result",
      outcome: "success",
      report: "bounded audit complete",
    });
    expect(parseClaudeStreamCompletion('{"type":"assistant","result":"not terminal"}')).toBeNull();
  });

  it("exposes only the declared managed provider contract", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: {
        extension: { providerContracts: { claudeCode: { methods: string[] } } };
      };
    };

    expect(Object.keys(activated)).toEqual(["providerContracts"]);
    expect(Object.keys(activated.providerContracts.claudeCode)).toEqual(
      manifest.vibestudio.extension.providerContracts.claudeCode.methods
    );
  });

  it("prepares without reading a host context binding or gateway path", async () => {
    const { ctx, approvalsRequest, rpcCall, storage } = makeCtx(tmpRoot);
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
    expect(approvalsRequest).not.toHaveBeenCalled();
    expect(rpcCall.mock.calls.find((c) => c[1] === "auth.mintAgentCredential")?.[2]).toEqual({
      entityId: "session:chan-1",
    });
    const sessionCreate = rpcCall.mock.calls.find(
      (c) => c[1] === "runtime.createEntity" && (c[2] as { kind: string }).kind === "session"
    );
    expect(sessionCreate?.[2]).toMatchObject({
      execution: { surface: "inert" },
      source: "claude-code",
      agentChannelId: CHANNEL,
    });
    const agentCreate = rpcCall.mock.calls.find(
      (c) => c[1] === "runtime.createEntity" && (c[2] as { kind: string }).kind === "do"
    );
    expect((agentCreate?.[2] as { agentBinding?: unknown }).agentBinding).toEqual({
      entityId: "session:chan-1",
      channelId: CHANNEL,
    });
    expect(JSON.parse(storage.get(`launches/${result.profile.launchId}.json`)!)).toMatchObject({
      ownerKind: "external-cli",
      phase: "active",
      process: null,
      materialization: null,
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
    expect(approvalsRequest).not.toHaveBeenCalled();
    expect(rpcCall).toHaveBeenCalled();
  });

  it("is idempotent on re-prepare: no second approval, rotates the credential", async () => {
    const { ctx, approvalsRequest, revoked, lifecycleEvents } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const first = await api.prepare({ channelId: CHANNEL });
    const second = await api.prepare({ channelId: CHANNEL });

    // Same session entity reused (deterministic key).
    expect(second.entityId).toBe(first.entityId);
    // Receiver authority is acquired before invocation; prepare does not prompt inline.
    expect(approvalsRequest).not.toHaveBeenCalled();
    // The prior credential was revoked and a fresh one minted.
    expect(revoked).toEqual(["agt_1"]);
    expect(second.profile.environment.VIBESTUDIO_AGENT_TOKEN).toBe("agent:agt_2:tok");
    const replacement = lifecycleEvents.slice(lifecycleEvents.indexOf("mint:agt_2"));
    expect(replacement.findIndex((event) => event === "mint:agt_2")).toBeLessThan(
      replacement.findIndex((event) => event.includes("launches/") && event.includes("preparing"))
    );
    expect(
      replacement.findIndex((event) => event.includes("launches/") && event.includes("preparing"))
    ).toBeLessThan(replacement.findIndex((event) => event === "revoke:agt_1"));
    expect(replacement.findIndex((event) => event === "revoke:agt_1")).toBeLessThan(
      replacement.findIndex((event) => event.includes("channels/") && event.includes("active"))
    );
  });

  it("fails loudly on a corrupt active pointer before minting replacement authority", async () => {
    const storage = new Map<string, string>([["channels/chan-1.json", "{broken"]]);
    const { ctx, rpcCall } = makeCtx(tmpRoot, storage);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    await expect(api.prepare({ channelId: CHANNEL })).rejects.toMatchObject({ code: "ECORRUPT" });
    expect(rpcCall.mock.calls.some((call) => call[1] === "auth.mintAgentCredential")).toBe(false);
    expect(storage.get("channels/chan-1.json")).toBe("{broken");
  });

  it("keeps the old active pointer when replacement credential retirement fails", async () => {
    const storage = new Map<string, string>();
    const failures: { failRevocationOnce?: string } = {};
    const prepared = makeCtx(tmpRoot, storage, failures);
    const api = (await activate(prepared.ctx as never)).providerContracts.claudeCode;
    const first = await api.prepare({ channelId: CHANNEL });
    failures.failRevocationOnce = "agt_1";

    await expect(api.prepare({ channelId: CHANNEL })).rejects.toThrow(
      /revocation failed for agt_1/
    );

    const pointer = JSON.parse(storage.get("channels/chan-1.json")!) as {
      launchId: string;
      phase: string;
    };
    expect(pointer).toMatchObject({ launchId: first.profile.launchId, phase: "active" });
    expect(prepared.revoked).toContain("agt_2");
    expect(prepared.revoked).not.toContain("agt_1");
  });

  it("records the context→channel binding for resolvePrimaryChannel", async () => {
    const { ctx } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toBeNull();
    await api.prepare({ channelId: CHANNEL });
    expect(await api.resolvePrimaryChannel({ contextId: CONTEXT })).toEqual({ channelId: CHANNEL });
  });

  it("subagent launch: skips the approval, threads subagent duty into vessel state, returns vessel identity", async () => {
    const { ctx, approvalsRequest, rpcCall } = makeCtx(tmpRoot);
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const subagent = {
      runId: "run-1",
      task: "audit the repo",
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
    expect(vesselCreate![2]).toMatchObject({
      stateArgs: {
        externalControllerCallerId: "@workspace-extensions/claude-code",
      },
    });
    expect(vesselCreate![2]).toMatchObject({
      agentBinding: { entityId: "session:chan-1", channelId: CHANNEL },
    });
    expect(vesselCreate![2]).not.toHaveProperty("agentChannelId");
  });

  it("launchSubagent prepares, spawns headless Claude privately, and release kills it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-provider-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-provider-session");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-cloud-secret");
    vi.stubEnv("SSH_AUTH_SOCK", "/run/user/1000/ambient-ssh-agent");
    vi.stubEnv("NODE_OPTIONS", "--require=/tmp/ambient-injection.cjs");
    vi.stubEnv("UNRELATED_SECRET", "ambient-secret");
    const { ctx, approvalsRequest, storage } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;

    const subagent = {
      runId: "run-1",
      task: "audit the repo",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.launchSubagent({
      channelId: CHANNEL,
      title: "Audit",
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
    expect(claudeArgs.slice(0, 3)).toEqual([
      "claude",
      "--dangerously-load-development-channels",
      "server:vibestudio",
    ]);
    expect(claudeArgs.slice(-10)).toEqual([
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "mcp__vibestudio__say,mcp__vibestudio__complete",
      "--strict-mcp-config",
      "-p",
      "audit the repo",
    ]);
    expect(claudeArgs).toContain("--mcp-config");
    expect(claudeArgs).toContain("--strict-mcp-config");
    expect(claudeArgs).toContain("--settings");
    expect(options).toMatchObject({
      cwd: path.join(tmpRoot, ".context-projections", "v5", CONTEXT),
      detached: true,
    });
    expect(options.env).toMatchObject({
      PATH: process.env["PATH"],
      VIBESTUDIO_CONTEXT_ID: CONTEXT,
      VIBESTUDIO_CHANNEL_ID: CHANNEL,
      VIBESTUDIO_BRIDGE_SOCKET: expect.stringContaining("/bridge.sock"),
      VIBESTUDIO_BRIDGE_GENERATION: result.generationId,
      // Subagent duty rides the session env so the bridge can state it in the
      // MCP instructions instead of hedging.
      VIBESTUDIO_SUBAGENT_RUN_ID: "run-1",
      VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: "home-chan",
      VIBESTUDIO_LINKED_SCRATCH: expect.stringContaining("/scratch"),
      CLAUDE_CONFIG_DIR: expect.stringContaining("/claude-config"),
      TMPDIR: "/tmp",
    });
    for (const secret of [
      "VIBESTUDIO_AGENT_TOKEN",
      "VIBESTUDIO_ENTITY_ID",
      "VIBESTUDIO_VESSEL_REF",
      "VIBESTUDIO_SERVER_URL",
      "VIBESTUDIO_EXTENSION_RPC_TOKEN",
      "VIBESTUDIO_EXTENSION_GATEWAY_URL",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
      "UNRELATED_SECRET",
    ]) {
      expect(options.env).not.toHaveProperty(secret);
    }
    expect(options.env["VIBESTUDIO_SUBAGENT_CONTRACT"]).toContain("## Subagent Operating Contract");
    expect(options.env["VIBESTUDIO_SUBAGENT_CONTRACT"]).toContain("typed terminal result");
    expect(options.env["VIBESTUDIO_SUBAGENT_CONTRACT"]).toContain(
      "Do not print or imitate tool-call syntax"
    );
    const durableLaunch = JSON.parse(storage.get(`launches/${result.generationId}.json`)!);
    expect(durableLaunch).toMatchObject({
      version: 3,
      ownerKind: "extension-headless",
      phase: "active",
      process: { pid: 4242, startCoordinate: "test-start" },
      materialization: {
        profileDir: path.dirname(result.logPath),
        logPath: result.logPath,
        broker: {
          socketPath: path.join(path.dirname(result.logPath), "bridge.sock"),
          generation: result.generationId,
        },
      },
    });
    expect(JSON.stringify(durableLaunch)).not.toContain("agent:agt_1:tok");
    expect(durableLaunch).not.toHaveProperty("vesselRef");
    expect(brokerApiMock.start).toHaveBeenCalledBefore(childProcessMock.spawn);

    expect(
      api.inspectLaunch({
        entityId: result.entityId,
        generationId: result.generationId,
      })
    ).toMatchObject({
      entityId: result.entityId,
      generationId: result.generationId,
      launchId: "claude-code:run-1",
      runId: "run-1",
      state: "running",
      pid: 4242,
      log: { bytes: 0, tail: "", truncated: false },
    });
    expect(() =>
      api.inspectLaunch({
        entityId: result.entityId,
        generationId: "stale-generation",
      })
    ).toThrow("No Claude launch");

    const released = await api.release({
      entityId: result.entityId,
      generationId: result.generationId,
    });
    expect(released).toEqual({ released: true });
    expect(processOwnerMock.retire).toHaveBeenCalledTimes(1);
    expect(brokerApiMock.brokers[0]!.close).toHaveBeenCalledOnce();
    expect(existsSync(path.dirname(result.logPath))).toBe(false);
  });

  it("does not revoke or delete a headless generation until its process group is absent", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    let finishRetirement!: () => void;
    processOwnerMock.retire.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishRetirement = resolve))
    );
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    const result = await api.launchSubagent({
      channelId: CHANNEL,
      subagent: {
        runId: "run-order",
        task: "audit",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        parentContextId: "ctx-parent",
        depth: 1,
      },
    });

    const releasing = api.release({ entityId: result.entityId, generationId: result.generationId });
    await vi.waitFor(() => expect(processOwnerMock.retire).toHaveBeenCalledTimes(1));
    expect(revoked).not.toContain("agt_1");
    expect(brokerApiMock.brokers[0]!.close).not.toHaveBeenCalled();
    expect(existsSync(path.dirname(result.logPath))).toBe(true);

    finishRetirement();
    await releasing;
    expect(brokerApiMock.brokers[0]!.close).toHaveBeenCalledOnce();
    expect(processOwnerMock.retire).toHaveBeenCalledBefore(brokerApiMock.brokers[0]!.close);
    expect(revoked).toContain("agt_1");
    expect(existsSync(path.dirname(result.logPath))).toBe(false);
  });

  it("retires the staged generation when broker readiness fails before spawn", async () => {
    const { ctx, revoked } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-broker-failure",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    brokerApiMock.start.mockRejectedValueOnce(new Error("broker bind failed"));
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    await expect(
      api.launchSubagent({
        channelId: CHANNEL,
        subagent: {
          runId: "run-broker-failure",
          task: "audit",
          parentRef: "do:parent",
          parentChannelId: "home-chan",
          parentContextId: "ctx-parent",
          depth: 1,
        },
      })
    ).rejects.toThrow("broker bind failed");
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(revoked).toContain("agt_1");
    expect(existsSync(path.join(tmpRoot, "state", "agent-launch"))).toBe(true);
    expect(readdirSync(path.join(tmpRoot, "state", "agent-launch"))).toEqual([]);
  });

  it("recovers a persisted process/profile receipt and releases it after extension restart", async () => {
    const storage = new Map<string, string>();
    const firstCtx = makeCtx(tmpRoot, storage);
    firstCtx.ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const firstApi = (await activate(firstCtx.ctx as never)).providerContracts.claudeCode;
    const result = await firstApi.launchSubagent({
      channelId: CHANNEL,
      subagent: {
        runId: "run-restart",
        task: "audit",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        parentContextId: "ctx-parent",
        depth: 1,
      },
    });
    expect(existsSync(path.dirname(result.logPath))).toBe(true);

    const restarted = makeCtx(tmpRoot, storage);
    const restartedApi = (await activate(restarted.ctx as never)).providerContracts.claudeCode;
    await restartedApi.release({ entityId: result.entityId, generationId: result.generationId });

    expect(processOwnerApiMock.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4242, startCoordinate: "test-start" })
    );
    expect(restarted.revoked).toContain("agt_1");
    expect(existsSync(path.dirname(result.logPath))).toBe(false);
    expect(brokerApiMock.start).toHaveBeenCalledTimes(1);
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
        task: "audit the repo",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        parentContextId: "ctx-parent",
        depth: 1,
        mode: "fresh",
      },
    });

    const [, args] = childProcessMock.spawn.mock.calls[0]! as unknown as [string, string[]];
    expect(args.slice(-16)).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
      "--effort",
      "high",
      "--max-budget-usd",
      "5",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "mcp__vibestudio__say,mcp__vibestudio__complete",
      "--strict-mcp-config",
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
      task: "audit",
      parentRef: "do:parent",
      parentChannelId: "home-chan",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh" as const,
    };
    const result = await api.launchSubagent({ channelId: CHANNEL, subagent });

    const exitHandler = childProcessMock.child.once.mock.calls.find((c) => c[0] === "exit")![1] as (
      code: number | null,
      signal: string | null
    ) => void;

    // The session died on its own → the vessel is told so the run settles.
    exitHandler(1, null);
    await vi.waitFor(() =>
      expect(
        api.inspectLaunch({
          entityId: result.entityId,
          generationId: result.generationId,
        })
      ).toMatchObject({
        state: "exited",
        exit: { code: 1, signal: null },
        log: { bytes: 0, tail: "", truncated: false },
      })
    );
    const report = rpcCall.mock.calls.find((c) => c[1] === "reportExternalExit");
    expect(report).toBeDefined();
    expect(report![0]).toBe(result.vesselRef);
    expect(report![2]).toEqual({ runId: "run-1", code: 1, signal: null });
    await vi.waitFor(() => expect(existsSync(path.dirname(result.logPath))).toBe(false));
    expect(brokerApiMock.brokers[0]!.close).toHaveBeenCalledOnce();
    expect(revoked).toContain("agt_1");

    // Relaunch, then a deliberate release-kill: no exit report.
    rpcCall.mockClear();
    childProcessMock.child.on.mockClear();
    childProcessMock.child.once.mockClear();
    const relaunched = await api.launchSubagent({
      channelId: CHANNEL,
      subagent,
    });
    await api.release({
      entityId: relaunched.entityId,
      generationId: relaunched.generationId,
    });
    const exitHandler2 = childProcessMock.child.once.mock.calls.find(
      (c) => c[0] === "exit"
    )![1] as (code: number | null, signal: string | null) => void;
    exitHandler2(null, "SIGTERM");
    expect(rpcCall.mock.calls.find((c) => c[1] === "reportExternalExit")).toBeUndefined();
    expect(brokerApiMock.brokers[1]!.close).toHaveBeenCalledOnce();
  });

  it("settles a successful headless process from its typed stream result", async () => {
    const { ctx, rpcCall } = makeCtx(tmpRoot);
    ctx.invocation.current.mockReturnValue({
      requestId: "req-1",
      extensionName: "@workspace-extensions/claude-code",
      method: "providers.claudeCode.launchSubagent",
      caller: { callerId: "do:parent", callerKind: "do" },
    });
    const api = (await activate(ctx as never)).providerContracts.claudeCode;
    const result = await api.launchSubagent({
      channelId: CHANNEL,
      subagent: {
        runId: "run-success",
        task: "audit",
        parentRef: "do:parent",
        parentChannelId: "home-chan",
        parentContextId: "ctx-parent",
        depth: 1,
      },
    });
    writeFileSync(
      result.logPath,
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "one concrete finding",
      })}\n`
    );
    const exitHandler = childProcessMock.child.once.mock.calls.find((c) => c[0] === "exit")![1] as (
      code: number | null,
      signal: string | null
    ) => void;
    exitHandler(0, null);

    await vi.waitFor(() =>
      expect(rpcCall.mock.calls.find((c) => c[1] === "reportExternalResult")).toBeDefined()
    );
    const report = rpcCall.mock.calls.find((c) => c[1] === "reportExternalResult");
    expect(report?.[0]).toBe(result.vesselRef);
    expect(report?.[2]).toEqual({
      runId: "run-success",
      outcome: "success",
      report: "one concrete finding",
      code: 0,
    });
    expect(rpcCall.mock.calls.find((c) => c[1] === "reportExternalExit")).toBeUndefined();
    expect(
      api.inspectLaunch({ entityId: result.entityId, generationId: result.generationId })
    ).toMatchObject({
      state: "exited",
      completion: {
        source: "stream-result",
        outcome: "success",
        report: "one concrete finding",
      },
    });
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
        subagent: {
          runId: "run-1",
          task: "audit",
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
      generationId: prepared.profile.launchId,
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
      generationId: first.profile.launchId,
    });

    expect(revoked).not.toContain("agt_2");
    await api.release({
      entityId: second.entityId,
      generationId: second.profile.launchId,
    });
    expect(revoked).toContain("agt_2");
  });
});
