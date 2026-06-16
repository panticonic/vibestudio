import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PROVIDER_CREDENTIAL_SETUPS, DEFAULT_MODEL } from "@workspace/agentic-do";

import { AiChatWorker } from "./ai-chat-worker.js";

class TestableAiChatWorker extends AiChatWorker {
  readonly blobs = new Map<string, string>();
  readonly published: Array<{ participantId: string; event: unknown; opts?: unknown }> = [];
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

  protected override createChannelClient() {
    return {
      publishAgenticEvent: async (participantId: string, event: unknown, opts?: unknown) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
      subscribe: async () => ({
        ok: true,
        channelConfig: undefined,
        envelope: { mode: "initial", logEvents: [], snapshots: [], ready: {} },
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

    const switched = await worker.onMethodCall("ch-1", "tc-2", "setModel", {
      model: "anthropic:claude-sonnet-4-6",
    });
    expect((switched.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");

    // settings survive re-read (Ref-kind KV)
    const after = await worker.onMethodCall("ch-1", "tc-3", "getAgentSettings", {});
    expect((after.result as { model: string }).model).toBe("anthropic:claude-sonnet-4-6");
    // other channels are unaffected
    const other = await worker.onMethodCall("ch-2", "tc-4", "getAgentSettings", {});
    expect((other.result as { model: string }).model).toBe(DEFAULT_MODEL);
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
