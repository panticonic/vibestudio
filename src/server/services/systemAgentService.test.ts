import { describe, expect, it, vi } from "vitest";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
import { createSystemAgentService } from "./systemAgentService.js";

const SNAPSHOT = `state:${"a".repeat(64)}`;
const AGENT_EV = "b".repeat(64);

function chromeCaller(userId = "alice"): VerifiedCaller {
  return {
    runtime: { kind: "app", id: "app:apps/shell:main" },
    subject: { userId },
  } as VerifiedCaller;
}

function fixture() {
  const createContext = vi.fn(async (_ctx, { contextId }: { contextId?: string }) => ({
    contextId: contextId!,
  }));
  const createEntity = vi.fn(
    async (
      _caller: VerifiedCaller,
      spec: { source: string; className?: string; key?: string; contextId?: string | null }
    ): Promise<RuntimeEntityHandle> => {
      const isAgent = spec.source === "workers/system-agent";
      const id = `do:${spec.source}:${spec.className}:${spec.key}`;
      return {
        id,
        targetId: id,
        kind: "do",
        source: {
          repoPath: spec.source,
          effectiveVersion: isAgent ? AGENT_EV : "c".repeat(64),
        },
        contextId: spec.contextId!,
        executionDigest: "d".repeat(64),
      };
    }
  );
  const callTarget = vi.fn(async () => ({ ok: true }));
  const startMissionSession = vi.fn();
  const definition = createSystemAgentService({
    workspaceId: "workspace-1",
    productSnapshotState: SNAPSHOT,
    runtime: {
      createContext,
      createEntity,
      resolveContext: vi.fn(async () => null),
    },
    conduitBlessings: {
      isBlessed: vi.fn(
        (identity: { repoPath: string; effectiveVersion: string }) =>
          identity.repoPath === "workers/system-agent" && identity.effectiveVersion === AGENT_EV
      ),
    } as never,
    startMissionSession,
    callTarget,
    hasAppCapability: (_callerId, capability) => capability === "panel-hosting",
  });
  return { definition, createContext, createEntity, callTarget, startMissionSession };
}

describe("systemAgent service", () => {
  it("derives one pinned, locked conversation from host-attested caller facts", async () => {
    const { definition, createContext, createEntity, callTarget, startMissionSession } = fixture();
    const result = (await definition.handler(
      { caller: chromeCaller("alice") },
      "resolveConversation",
      []
    )) as { channelId: string; entityId: string; contextId: string };

    expect(result.channelId).toMatch(/^system-agent-[0-9a-f]{32}$/);
    expect(result.contextId).toBe(`ctx-${result.channelId}`);
    expect(createContext).toHaveBeenCalledWith(
      { caller: chromeCaller("alice") },
      { contextId: result.contextId }
    );
    expect(createEntity).toHaveBeenNthCalledWith(
      1,
      chromeCaller("alice"),
      expect.objectContaining({
        source: "workers/pubsub-channel",
        ref: SNAPSHOT,
        contextId: result.contextId,
        key: result.channelId,
      })
    );
    expect(startMissionSession).toHaveBeenCalledWith({
      missionId: "msn_system_agent",
      sessionId: result.channelId,
      taskRef: "system-agent-conversation:alice",
      runId: expect.stringMatching(/^system-agent-[0-9a-f]{64}$/),
    });
    expect(createEntity).toHaveBeenNthCalledWith(
      2,
      chromeCaller("alice"),
      expect.objectContaining({
        source: "workers/system-agent",
        ref: SNAPSHOT,
        contextId: result.contextId,
        agentChannelId: result.channelId,
      })
    );
    expect(callTarget).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("workers/pubsub-channel"),
      "initializeLockedChannel",
      [
        result.contextId,
        expect.objectContaining({
          owner: "user:alice",
          membershipPolicy: {
            kind: "locked",
            participants: ["user:alice", expect.stringContaining("workers/system-agent")],
          },
        }),
      ]
    );
    expect(callTarget).toHaveBeenNthCalledWith(2, result.entityId, "attachChannel", [
      {
        channelId: result.channelId,
        contextId: result.contextId,
        replay: true,
      },
    ]);
  });

  it("rejects callers without a human subject or trusted chrome identity", async () => {
    const { definition } = fixture();
    await expect(
      definition.handler(
        { caller: { runtime: { kind: "server", id: "server" } } as VerifiedCaller },
        "resolveConversation",
        []
      )
    ).rejects.toThrow("authenticated human user");
    await expect(
      definition.handler(
        {
          caller: {
            runtime: { kind: "panel", id: "panel:untrusted" },
            subject: { userId: "alice" },
          } as VerifiedCaller,
        },
        "resolveConversation",
        []
      )
    ).rejects.toThrow("restricted to chrome");
  });
});
