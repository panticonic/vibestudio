import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PROVIDER_CREDENTIAL_SETUPS, DEFAULT_MODEL } from "@workspace/agentic-do";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
} from "@workspace/agentic-protocol";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";

import { AiChatWorker } from "./ai-chat-worker.js";

class TestableAiChatWorker extends AiChatWorker {
  // Tests invoke onMethodCall directly (not through the relay) to exercise the
  // standard-agent-method logic; present as the server caller so the channel-delivery
  // gate (assertChannelDeliveryCaller) admits them.
  protected override get rpcCallerKind(): string | null {
    return "server";
  }
  readonly blobs = new Map<string, string>();
  readonly published: Array<{ participantId: string; event: unknown; opts?: unknown }> = [];
  readonly driverHandleIncoming = vi.fn(async () => undefined);
  readonly driverWake = vi.fn(async () => undefined);
  readonly fakeDriver = {
    handleIncoming: this.driverHandleIncoming,
    wake: this.driverWake,
    abortChannel: vi.fn(),
    dropLoop: vi.fn(),
    deliverEffectOutcome: vi.fn(async () => undefined),
    scheduleResumeAtReset: vi.fn(async () => ({ scheduled: true })),
    getDebugState: vi.fn(async () => ({})),
    foldCache: { delete: vi.fn() },
  };
  subscribeEnvelope: ChannelReplayEnvelope = {
    mode: "initial",
    logEvents: [],
    snapshots: [],
    ready: { totalCount: 0, envelopeCount: 0 },
  };
  workspaceAgentsMd: unknown = "WORKSPACE AGENTS";
  workspaceSkills: unknown = [
    {
      name: "onboarding",
      description: "Onboarding skill",
      dirPath: "/skills/onboarding",
    },
  ];

  readonly rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
    if (target === "main" && method === "workspace.getAgentsMd") {
      return this.workspaceAgentsMd;
    }
    if (target === "main" && method === "workspace.listSkills") {
      return this.workspaceSkills;
    }
    if (target === "main" && method === "blobstore.putText") {
      const value = String(args[0] ?? "");
      const digest = `blob-${this.blobs.size + 1}`;
      this.blobs.set(digest, value);
      return { digest, size: value.length };
    }
    throw new Error(`unexpected rpc ${target}.${method}`);
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
      callDeferred: async (...args: unknown[]) => ({
        status: "completed" as const,
        result: await this.rpcCall(...(args as [string, string, unknown[]])),
      }),
    } as never;
  }

  protected override get driver(): never {
    return this.fakeDriver as never;
  }

  protected override createChannelClient() {
    return {
      publishAgenticEvent: async (participantId: string, event: unknown, opts?: unknown) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
      subscribe: async () => ({
        ok: true,
        channelConfig: undefined,
        envelope: this.subscribeEnvelope,
      }),
      unsubscribe: async () => undefined,
      getParticipants: async () => [],
    } as never;
  }

  credentialSetup(providerId: string) {
    return this.getModelCredentialSetupProps(providerId);
  }

  seedSubscriptionConfig(channelId: string, config: Record<string, unknown>) {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      JSON.stringify(config),
      `participant:${channelId}`
    );
  }

  async materializedPrompt(channelId: string): Promise<string> {
    await this.ensurePromptArtifacts(channelId);
    const digest = this.getStateValue(`agent:promptHash:${channelId}`);
    if (!digest) throw new Error("missing prompt digest");
    const value = this.blobs.get(digest);
    if (value === undefined) throw new Error(`missing prompt blob ${digest}`);
    return value;
  }

  promptResourceCallCount(method: "workspace.getAgentsMd" | "workspace.listSkills") {
    return this.rpcCall.mock.calls.filter((call) => call[0] === "main" && call[1] === method)
      .length;
  }
}

async function makeWorker() {
  const { instance } = await createTestDO(TestableAiChatWorker, { __objectKey: "agent-1" });
  return instance as TestableAiChatWorker;
}

describe("AiChatWorker", () => {
  it("inherits the base agent schema version so base-table migrations run", () => {
    expect(TestableAiChatWorker.schemaVersion).toBe(AiChatWorker.schemaVersion);
  });

  it("exposes the shared provider connect presets to the credential flow", async () => {
    const worker = await makeWorker();
    for (const providerId of Object.keys(PROVIDER_CREDENTIAL_SETUPS)) {
      expect(worker.credentialSetup(providerId)).toEqual(
        PROVIDER_CREDENTIAL_SETUPS[providerId]
      );
    }
    expect(worker.credentialSetup("nope")).toBeNull();
  });

  it("ingests subscription replay and wakes the loop after subscribing", async () => {
    const worker = await makeWorker();
    worker.subscribeEnvelope = {
      mode: "initial",
      logEvents: [
        {
          id: 1,
          messageId: "msg-1",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          senderId: "user-1",
          senderMetadata: { type: "panel", name: "User" },
          ts: Date.parse("2026-06-17T12:00:00.000Z"),
          payload: {
            kind: "message.completed",
            actor: { kind: "panel", id: "user-1", displayName: "User" },
            causality: { messageId: "msg-1" },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "user",
              blocks: [{ type: "text", content: "hello" }],
              outcome: "completed",
            },
            createdAt: "2026-06-17T12:00:00.000Z",
          },
        },
      ],
      snapshots: [],
      ready: { totalCount: 1, envelopeCount: 1 },
    };

    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1", replay: true });

    expect(worker.driverHandleIncoming).toHaveBeenCalledWith(
      "ch-1",
      expect.objectContaining({
        type: "command",
        command: expect.objectContaining({
          kind: "prompt",
          channelId: "ch-1",
          source: { envelopeId: "msg-1" },
        }),
      })
    );
    expect(worker.driverWake).toHaveBeenCalledWith("ch-1");
  });

  it("materializes workspace, skill, and subscription prompts into the model prompt artifact", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {
      systemPrompt: "CHANNEL CUSTOM",
      systemPromptMode: "append",
    });

    const prompt = await worker.materializedPrompt("ch-1");

    expect(prompt).toContain("NatStack is a local workspace");
    expect(prompt).toContain("WORKSPACE AGENTS");
    expect(prompt).toContain("onboarding");
    expect(prompt).toContain("CHANNEL CUSTOM");
    expect(prompt.indexOf("WORKSPACE AGENTS")).toBeLessThan(prompt.indexOf("onboarding"));
    expect(prompt.indexOf("onboarding")).toBeLessThan(prompt.indexOf("CHANNEL CUSTOM"));
  });

  it("honors a full replacement subscription prompt", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {
      systemPrompt: "CHANNEL ONLY",
      systemPromptMode: "replace",
    });

    await expect(worker.materializedPrompt("ch-1")).resolves.toBe("CHANNEL ONLY");
  });

  it("caches workspace prompt resources and refreshes them on request", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {});

    await worker.materializedPrompt("ch-1");
    await worker.materializedPrompt("ch-1");
    expect(worker.promptResourceCallCount("workspace.getAgentsMd")).toBe(1);
    expect(worker.promptResourceCallCount("workspace.listSkills")).toBe(1);

    worker.workspaceAgentsMd = "UPDATED WORKSPACE AGENTS";
    const refresh = await worker.onMethodCall("ch-1", "tc-refresh", "refreshPromptArtifacts", {});

    expect(refresh).toMatchObject({ result: { refreshed: true } });
    expect(worker.promptResourceCallCount("workspace.getAgentsMd")).toBe(2);
    expect(worker.promptResourceCallCount("workspace.listSkills")).toBe(2);
    await expect(worker.materializedPrompt("ch-1")).resolves.toContain("UPDATED WORKSPACE AGENTS");
  });

  it("publishes a diagnostic and fails closed when workspace prompt resources are malformed", async () => {
    const worker = await makeWorker();
    worker.seedSubscriptionConfig("ch-1", {});
    worker.workspaceSkills = { not: "a skill list" };

    await expect(worker.materializedPrompt("ch-1")).rejects.toThrow(
      "workspace.listSkills returned invalid resource shape"
    );

    expect(worker.published).toHaveLength(1);
    expect(worker.published[0]?.event).toMatchObject({
      kind: "message.completed",
      payload: {
        blocks: [
          expect.objectContaining({
            type: "diagnostic",
            metadata: expect.objectContaining({
              code: "prompt_artifact_load_failed",
              severity: "error",
              recoverable: true,
            }),
          }),
        ],
        outcome: "completed",
      },
    });

    await expect(worker.materializedPrompt("ch-1")).rejects.toThrow(
      "workspace.listSkills returned invalid resource shape"
    );
    expect(worker.published).toHaveLength(1);
  });

  it("persists live setting changes through the standard agent methods", async () => {
    const worker = await makeWorker();
    const before = await worker.onMethodCall("ch-1", "tc-1", "getAgentSettings", {});
    expect((before.result as { model: string }).model).toBe(DEFAULT_MODEL);
    expect((before.result as { modelStreamIdleTimeoutMs: number }).modelStreamIdleTimeoutMs).toBe(
      90_000
    );

    const switched = await worker.onMethodCall("ch-1", "tc-2", "setModel", {
      model: "anthropic:claude-sonnet-4-6",
    });
    expect((switched.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");

    // settings survive re-read (Ref-kind KV)
    const after = await worker.onMethodCall("ch-1", "tc-3", "getAgentSettings", {});
    expect((after.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");
    // config is per-AGENT, not per-channel: a sibling channel of the same agent sees the change
    const other = await worker.onMethodCall("ch-2", "tc-4", "getAgentSettings", {});
    expect((other.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");
  });

  it("validates standard method arguments", async () => {
    const worker = await makeWorker();
    expect((await worker.onMethodCall("ch-1", "tc-1", "setModel", {})).isError).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-2", "setThinkingLevel", { level: "extreme" }))
        .isError
    ).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-3", "setApprovalLevel", { level: 9 })).isError
    ).toBe(true);
    expect(
      (await worker.onMethodCall("ch-1", "tc-4", "setRespondPolicy", { policy: "sometimes" }))
        .isError
    ).toBe(true);
    expect((await worker.onMethodCall("ch-1", "tc-5", "unknownMethod", {})).isError).toBe(true);
  });

  it("applies respond policy with an allow-list", async () => {
    const worker = await makeWorker();
    const result = await worker.onMethodCall("ch-1", "tc-1", "setRespondPolicy", {
      policy: "from-participants",
      from: ["panel:alice", 42, "panel:bob"],
    });
    expect(result.result).toMatchObject({
      respondPolicy: "from-participants",
      respondFrom: ["panel:alice", "panel:bob"],
    });
  });
});
