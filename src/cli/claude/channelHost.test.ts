import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bridgeInstructions,
  BridgeTurnBatcher,
  channelNotificationMeta,
  CLAUDE_CHANNEL_READINESS,
  createSkillResources,
  deliverBridgePayload,
  OrderedHookIngestor,
  resolveBridgeConfig,
  skillNameFromUri,
  skillResourceUri,
  WORKSPACE_SKILL_ADDENDUM,
  type BridgeConfig,
} from "./channelHost.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "channel-host-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const LAUNCH_ENV = {
  VIBESTUDIO_ENTITY_ID: "ent-1",
  VIBESTUDIO_CONTEXT_ID: "ctx-1",
  VIBESTUDIO_CHANNEL_ID: "chan-1",
  VIBESTUDIO_VESSEL_REF: "do:workers/linked-agent:LinkedAgentWorker:linked:ent-1",
  VIBESTUDIO_LAUNCH_PROFILE: "/tmp/vibestudio-test-profile",
} as NodeJS.ProcessEnv;
const AGENT_CREDENTIAL = {
  schemaVersion: 1 as const,
  kind: "agent" as const,
  url: "https://workspace.example/",
  workspaceId: "workspace-1",
  workspaceName: "dev",
  serverId: `srv_${"S".repeat(24)}`,
  entityId: "ent-1",
  contextId: "ctx-1",
  agentId: `agt_${"A".repeat(24)}`,
  agentToken: `agent:agt_${"A".repeat(24)}:${"T".repeat(43)}`,
  signedInAt: 1,
};
const BRIDGE_ENVIRONMENT = { loadCredentials: () => AGENT_CREDENTIAL };

describe("Claude channel boundary", () => {
  it("keeps registration explicitly unconfirmed after MCP initialization", () => {
    expect(CLAUDE_CHANNEL_READINESS).toEqual({
      mcpTransport: "initialized",
      channelRegistration: "unconfirmed",
      reason: "claude-protocol-has-no-registration-ack",
    });
    expect(CLAUDE_CHANNEL_READINESS).not.toHaveProperty("ready");
  });

  it("projects only reviewed string identifiers into notification meta", () => {
    expect(
      channelNotificationMeta(
        {
          channel_id: "chan-1",
          seq: 42,
          from: "agent-1",
          from_handle: undefined,
          turn_id: "turn-1",
          mentions: ["alice"],
          "unsafe-key": "drop",
          structured: { stays: "durable" },
        },
        "message"
      )
    ).toEqual({
      channel_id: "chan-1",
      seq: "42",
      from: "agent-1",
      kind: "message",
      turn_id: "turn-1",
    });
  });

  it("acknowledges durable delivery only after MCP transport acceptance", async () => {
    const order: string[] = [];
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const delivery = deliverBridgePayload(
      {
        kind: "message",
        seq: 9,
        deliveryId: "delivery-9",
        bridgeSessionId: "bridge-session-1",
        attachmentGeneration: "generation-1",
        content: "hello",
        meta: { channel_id: "chan-1", seq: 100, mentions: ["alice"] },
      },
      {
        channelId: "chan-1",
        bridgeSessionId: "bridge-session-1",
        attachmentGeneration: "generation-1",
        batcher: new BridgeTurnBatcher("bridge-session-1"),
        mcp: {
          notifyChannel: async (_content, meta) => {
            order.push(`notify:${meta["seq"]}`);
            await accepted;
            order.push("accepted");
          },
          notifyPermission: async () => undefined,
        },
        callVessel: async (method, args) => {
          order.push(`${method}:${JSON.stringify(args)}`);
        },
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["notify:100"]);
    accept();
    await delivery;
    expect(order).toEqual([
      "notify:100",
      "accepted",
      'acceptDelivery:[{"bridgeSessionId":"bridge-session-1","attachmentGeneration":"generation-1","deliveryId":"delivery-9","batchId":"bridge-session-1:batch:1"}]',
    ]);
  });

  it("does not acknowledge when MCP transport acceptance fails", async () => {
    const calls: string[] = [];
    await expect(
      deliverBridgePayload(
        {
          kind: "prompt",
          seq: 4,
          deliveryId: "delivery-4",
          bridgeSessionId: "bridge-session-1",
          attachmentGeneration: "generation-1",
          content: "hello",
          meta: {},
        },
        {
          channelId: "chan-1",
          bridgeSessionId: "bridge-session-1",
          attachmentGeneration: "generation-1",
          batcher: new BridgeTurnBatcher("bridge-session-1"),
          mcp: {
            notifyChannel: async () => {
              throw new Error("stdout closed");
            },
            notifyPermission: async () => undefined,
          },
          callVessel: async (method) => {
            calls.push(method);
          },
        }
      )
    ).rejects.toThrow(/stdout closed/);
    expect(calls).toEqual([]);
  });

  it("groups transport-accepted messages at official busy-turn boundaries", () => {
    const batcher = new BridgeTurnBatcher("bridge-session-1");
    const first = batcher.assignDelivery();
    expect(batcher.assignDelivery()).toBe(first);

    const active = batcher.coordinatesForHook({
      hook: "PreToolUse",
      toolName: "Read",
      toolUseId: "tool-1",
      turnSource: "channel",
    });
    expect(active.batchId).toBe(first);
    active.commit();

    const next = batcher.assignDelivery();
    expect(next).not.toBe(first);
    const stop = batcher.coordinatesForHook({
      hook: "Stop",
      turnKey: "t1",
      turnSource: "channel",
    });
    expect(stop.batchId).toBe(first);
    stop.commit();

    const nextTurn = batcher.coordinatesForHook({
      hook: "Stop",
      turnKey: "t2",
      turnSource: "channel",
    });
    expect(nextTurn.batchId).toBe(next);
  });

  it("keeps local turns separate and reports an interrupted active channel batch", () => {
    const batcher = new BridgeTurnBatcher("bridge-session-1");
    const channelBatch = batcher.assignDelivery();
    batcher
      .coordinatesForHook({
        hook: "PreToolUse",
        toolName: "Read",
        toolUseId: "tool-1",
        turnSource: "channel",
      })
      .commit();
    const local = batcher.coordinatesForHook({
      hook: "UserPromptSubmit",
      promptText: "new prompt",
      turnKey: "t2",
    });
    expect(local).toMatchObject({ interruptedBatchId: channelBatch });
    local.commit();
    expect(
      batcher.coordinatesForHook({
        hook: "Stop",
        turnKey: "t2",
        turnSource: "local",
      }).batchId
    ).toBeUndefined();
  });

  it("serializes hook durability and poisons later hooks after an uncertain failure", async () => {
    const ingestor = new OrderedHookIngestor();
    const order: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = ingestor.enqueue(async () => {
      order.push("first:start");
      await barrier;
      order.push("first:done");
    });
    const second = ingestor.enqueue(async () => {
      order.push("second");
      throw new Error("durable receipt uncertain");
    });
    const third = ingestor.enqueue(async () => {
      order.push("third");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first:start"]);
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/durable receipt uncertain/);
    await expect(third).rejects.toThrow(/durable receipt uncertain/);
    expect(order).toEqual(["first:start", "first:done", "second"]);
    await ingestor.drain();
  });
});

describe("resolveBridgeConfig", () => {
  it("prefers the complete canonical launch-profile env", async () => {
    const config = await resolveBridgeConfig(
      { ...LAUNCH_ENV, VIBESTUDIO_LAUNCH_PROFILE: tmpRoot },
      BRIDGE_ENVIRONMENT
    );
    expect(config.mode).toBe("launched");
    expect(config.credentials).toBe(AGENT_CREDENTIAL);
    expect(config.vesselRef).toBe(LAUNCH_ENV["VIBESTUDIO_VESSEL_REF"]);
    expect(config.hookSocketPaths[0]).toBe(path.join(tmpRoot, "hook.sock"));
    expect(config.hookSocketPaths).toEqual([path.join(tmpRoot, "hook.sock")]);
  });

  it("does not consume ambient credentials or server routing", async () => {
    const config = await resolveBridgeConfig(
      {
        ...LAUNCH_ENV,
        VIBESTUDIO_AGENT_TOKEN: "must-not-be-read",
        VIBESTUDIO_SERVER_URL: "https://must-not-be-read.invalid",
      },
      BRIDGE_ENVIRONMENT
    );
    expect(JSON.stringify(config)).not.toMatch(/must-not-be-read/);
  });

  it("parses the subagent duty out of the launch env", async () => {
    const config = await resolveBridgeConfig(
      {
        ...LAUNCH_ENV,
        VIBESTUDIO_SUBAGENT_RUN_ID: "run-1",
        VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: "chan-parent",
        VIBESTUDIO_SUBAGENT_CONTRACT: "## Subagent Operating Contract\ncontract body",
      },
      BRIDGE_ENVIRONMENT
    );
    expect(config.subagent).toEqual({
      runId: "run-1",
      parentChannelId: "chan-parent",
      contract: "## Subagent Operating Contract\ncontract body",
    });
  });

  it("leaves subagent unset without the run-id env", async () => {
    const config = await resolveBridgeConfig(
      { ...LAUNCH_ENV, VIBESTUDIO_SUBAGENT_CONTRACT: "orphan contract" },
      BRIDGE_ENVIRONMENT
    );
    expect(config.subagent).toBeUndefined();
  });

  it("rejects a partial launch env loudly", async () => {
    await expect(
      resolveBridgeConfig({ VIBESTUDIO_CONTEXT_ID: "ctx-1" } as NodeJS.ProcessEnv)
    ).rejects.toThrow(/owner-provisioned/);
  });

  it("refuses unmanaged adoption because the bridge cannot contain its parent process", async () => {
    await expect(resolveBridgeConfig({})).rejects.toThrow(/owner-provisioned/);
  });
});

describe("bridgeInstructions", () => {
  const baseConfig: BridgeConfig = {
    mode: "launched",
    credentials: AGENT_CREDENTIAL,
    entityId: "ent-1",
    contextId: "ctx-1",
    channelId: "chan-1",
    vesselRef: LAUNCH_ENV["VIBESTUDIO_VESSEL_REF"]!,
    hookSocketPaths: [],
  };

  it("hedges on task duty for a plain linked session", () => {
    const text = bridgeInstructions(baseConfig);
    expect(text).toContain("If this is a task channel");
    expect(text).not.toContain("spawned as a SUBAGENT");
    // Discovery pointers are always present.
    expect(text).toContain("vibestudio-agent");
    expect(text).toContain("ordinary entity-scoped `vibestudio` CLI login");
    expect(text).toContain("public CLI operation authorized");
    expect(text).toContain("may begin sparse");
    expect(text).toContain("Native Edit/Write/Bash changes");
    expect(text).toContain("vibestudio fs");
    expect(text).not.toContain("full-power surface");
  });

  it("states the subagent duty definitively and embeds the contract", () => {
    const text = bridgeInstructions({
      ...baseConfig,
      subagent: {
        runId: "run-7",
        parentChannelId: "chan-parent",
        contract: "## Subagent Operating Contract\nOnly `complete` ends this subagent run.",
      },
    });
    expect(text).toContain("spawned as a SUBAGENT (run run-7)");
    expect(text).toContain("Only `complete` ends this subagent run.");
    expect(text).toContain("headless and supervised");
    expect(text).toContain("typed terminal result");
    expect(text).toContain("Do not print or imitate `complete({...})`");
    expect(text).not.toContain("If this is a task channel");
  });

  it("still states the duty when the contract env is missing", () => {
    const text = bridgeInstructions({
      ...baseConfig,
      subagent: { runId: "run-8", parentChannelId: "chan-parent", contract: "" },
    });
    expect(text).toContain("spawned as a SUBAGENT (run run-8)");
    expect(text).toContain("finish with a concise final report");
  });
});

describe("workspace skill resources", () => {
  it("maps the workspace skill catalog to MCP resource descriptors keyed by dirPath", async () => {
    const resources = createSkillResources(async (method, args) => {
      expect(method).toBe("workspace.listSkills");
      expect(args).toEqual([]);
      return [
        {
          name: "onboarding",
          description: "Get started",
          dirPath: "skills/onboarding",
          skillPath: "skills/onboarding/SKILL.md",
        },
        // Repo-local skill (post skills-upgrade): read key is the repo path.
        {
          name: "agentic-do",
          description: "Agent runtime work",
          dirPath: "packages/agentic-do",
          skillPath: "packages/agentic-do/SKILL.md",
        },
      ] as never;
    });
    await expect(resources.list()).resolves.toEqual([
      {
        uri: "vibestudio-skill://skills%2Fonboarding",
        name: "onboarding",
        description: "Workspace skill (skills/onboarding): Get started",
        mimeType: "text/markdown",
      },
      {
        uri: "vibestudio-skill://packages%2Fagentic-do",
        name: "agentic-do",
        description: "Workspace skill (packages/agentic-do): Agent runtime work",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("serves the linked-session addendum on the first read only", async () => {
    const resources = createSkillResources(async (method) => {
      expect(method).toBe("workspace.readSkill");
      return "# Skill body" as never;
    });
    const first = await resources.read("vibestudio-skill://subagents");
    const firstText = first.contents[0]!.text;
    expect(firstText.startsWith(WORKSPACE_SKILL_ADDENDUM)).toBe(true);
    expect(firstText).toContain("translate as you read");
    expect(firstText).toContain("ordinary");
    expect(firstText).toContain("without a human device identity");
    expect(firstText.endsWith("# Skill body")).toBe(true);

    // Second read (any skill): session already has the translation rules.
    const second = await resources.read("vibestudio-skill://system-testing");
    expect(second.contents[0]!.text).toBe("# Skill body");
  });

  it("refuses non-skill uris and round-trips encoded names", async () => {
    const resources = createSkillResources(async () => "unused" as never);
    await expect(resources.read("file:///etc/passwd")).rejects.toThrow(
      /not a workspace skill resource/
    );
    expect(skillNameFromUri(skillResourceUri("gad-context"))).toBe("gad-context");
    expect(skillNameFromUri("vibestudio-skill://")).toBeNull();
  });
});
