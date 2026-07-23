import { createHash } from "node:crypto";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { systemAgentMethods } from "@vibestudio/service-schemas/systemAgent";
import type { RuntimeServiceInternal } from "./runtimeService.js";
import type { ConduitBlessingStore } from "./conduitBlessingStore.js";
import { isAuthorizedChrome } from "./chromeTrust.js";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";
const AGENT_SOURCE = "workers/system-agent";
const AGENT_CLASS = "SystemAgentWorker";

export interface SystemAgentServiceDeps {
  workspaceId: string;
  productSnapshotState: string | null;
  runtime: RuntimeServiceInternal;
  conduitBlessings: ConduitBlessingStore;
  startMissionSession(input: {
    missionId: string;
    sessionId: string;
    taskRef: string;
    runId: string;
  }): unknown;
  callTarget(targetId: string, method: string, args: unknown[]): Promise<unknown>;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}

export function createSystemAgentService(deps: SystemAgentServiceDeps): ServiceDefinition {
  const resolutions = new Map<string, Promise<unknown>>();

  function requireHumanChrome(caller: VerifiedCaller): string {
    const userId = caller.subject?.userId;
    if (!userId || userId === "system") {
      throw Object.assign(new Error("System Agent requires an authenticated human user"), {
        code: "EACCES",
      });
    }
    if (!isAuthorizedChrome(caller, { hasAppCapability: deps.hasAppCapability })) {
      throw Object.assign(
        new Error("System Agent conversation lifecycle is restricted to chrome"),
        {
          code: "EACCES",
        }
      );
    }
    return userId;
  }

  async function resolveConversation(caller: VerifiedCaller) {
    const userId = requireHumanChrome(caller);
    const productSnapshotState = deps.productSnapshotState;
    if (!productSnapshotState || !/^state:[0-9a-f]{64}$/u.test(productSnapshotState)) {
      throw new Error("System Agent is unavailable without an immutable product snapshot");
    }
    const ownerKey = createHash("sha256")
      .update(`${deps.workspaceId}\0${userId}\0${productSnapshotState}`)
      .digest("hex");
    return serializeByKey(resolutions, ownerKey, async () => {
      const suffix = ownerKey.slice(0, 32);
      const contextId = `ctx-system-agent-${suffix}`;
      const channelId = `system-agent-${suffix}`;
      const agentKey = `system-agent-${suffix}`;

      await deps.runtime.createContext({ caller }, { contextId });
      const channel = await deps.runtime.createEntity(caller, {
        kind: "do",
        source: CHANNEL_SOURCE,
        className: CHANNEL_CLASS,
        key: channelId,
        contextId,
        ref: productSnapshotState,
      });
      const agent = await deps.runtime.createEntity(caller, {
        kind: "do",
        source: AGENT_SOURCE,
        className: AGENT_CLASS,
        key: agentKey,
        contextId,
        ref: productSnapshotState,
        agentChannelId: channelId,
      });
      if (
        !deps.conduitBlessings.isBlessed({
          repoPath: AGENT_SOURCE,
          effectiveVersion: agent.source.effectiveVersion,
          ...(agent.executionDigest ? { executionDigest: agent.executionDigest } : {}),
        })
      ) {
        throw new Error("Resolved System Agent execution is not product-blessed");
      }
      deps.startMissionSession({
        missionId: "msn_system_agent",
        sessionId: channelId,
        taskRef: `system-agent-conversation:${userId}`,
        runId: `system-agent-${ownerKey}`,
      });
      await deps.callTarget(channel.targetId, "initializeLockedChannel", [
        contextId,
        {
          title: "System Agent",
          titleExplicit: true,
          origin: "system",
          owner: `user:${userId}`,
          policies: ["agentic.conversation.v1"],
          membershipPolicy: {
            kind: "locked",
            participants: [`user:${userId}`, agent.targetId],
          },
        },
      ]);
      await deps.callTarget(agent.targetId, "attachChannel", [
        {
          channelId,
          contextId,
          replay: true,
        },
      ]);
      return { channelId, entityId: agent.id, contextId };
    });
  }

  return {
    name: "systemAgent",
    description: "Product-owned per-user System Agent conversation lifecycle",
    authority: { principals: ["user", "code"] },
    methods: systemAgentMethods,
    handler: defineServiceHandler("systemAgent", systemAgentMethods, {
      resolveConversation: (ctx) => resolveConversation(ctx.caller),
    }),
  };
}
