import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { missionMethods } from "@vibestudio/service-schemas/mission";
import { authorityRowKey } from "@vibestudio/shared/authority/authorityRowDiff";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type { MissionRecord } from "@vibestudio/shared/authority/mission";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { MissionRegistry } from "./missionRegistry.js";
import { missionReviewPresentation } from "./missionReviewPresentation.js";

export function createMissionService(deps: {
  registry: MissionRegistry;
  approvalQueue: ApprovalQueue;
  capabilityGrants: CapabilityGrantStore;
  describeCapability: CapabilityPresentationResolver;
  contextIntegrityReady: () => boolean;
}): ServiceDefinition {
  return {
    name: "mission",
    description: "Content-addressed charters for recurring and unattended agents",
    authority: { principals: ["user", "host"] },
    methods: missionMethods,
    handler: defineServiceHandler("mission", missionMethods, {
      list: (ctx) => {
        const userId = viewerUserId(ctx);
        return userId === null ? deps.registry.list() : deps.registry.listForUser(userId);
      },
      get: (ctx, [missionId]) => {
        const userId = viewerUserId(ctx);
        return userId === null
          ? deps.registry.get(missionId)
          : deps.registry.getForUser(missionId, userId);
      },
      listRuns: (ctx, [missionId]) => {
        const userId = viewerUserId(ctx);
        if (userId !== null) requireVisibleMission(deps.registry, missionId, userId);
        return deps.registry.listRuns(missionId);
      },
      createDraft: async (ctx, [input]) => {
        const owner = humanOwner(ctx);
        const mission = deps.registry.createDraft({ ...input, owner });
        return reviewMission(deps, mission, owner.userId);
      },
      edit: async (ctx, [missionId, input]) => {
        const owner = humanOwner(ctx);
        const mission = deps.registry.edit(missionId, {
          ...input,
          actingUserId: owner.userId,
          forkOwner: owner,
        });
        return reviewMission(deps, mission, owner.userId);
      },
      requestReview: (ctx, [missionId]) =>
        reviewMission(
          deps,
          requireVisibleMission(deps.registry, missionId, humanUserId(ctx)),
          humanUserId(ctx)
        ),
      pause: (ctx, [missionId]) => deps.registry.pause(missionId, humanUserId(ctx)),
      resume: (ctx, [missionId]) => deps.registry.resume(missionId, humanUserId(ctx)),
      retire: (ctx, [missionId]) => deps.registry.retire(missionId, humanUserId(ctx)),
      startSession: (_ctx, [input]) => deps.registry.startSession(input),
      finishSession: (_ctx, [input]) => {
        deps.registry.finishSession(input);
      },
    }),
  };
}

export async function reviewMission(
  deps: {
    registry: MissionRegistry;
    approvalQueue: ApprovalQueue;
    capabilityGrants: CapabilityGrantStore;
    describeCapability: CapabilityPresentationResolver;
    contextIntegrityReady: () => boolean;
  },
  mission: MissionRecord,
  requestedByUserId: string,
  options: {
    reviewKind?: "draft" | "revision" | "out-of-charter";
    blockedAt?: number;
    declinedRestriction?: { capability: string; resourceKey: string };
  } = {}
): Promise<MissionRecord> {
  if (mission.state !== "draft" && mission.state !== "needs-reapproval") {
    throw Object.assign(new Error("Only an inert mission closure can be reviewed"), {
      code: "EACCES",
    });
  }
  const previous = deps.registry.previousRevision(mission.missionId);
  const presentation = missionReviewPresentation({
    mission,
    previous,
    profileGrants: deps.capabilityGrants.listAgentAuthorityGrants(mission.charter.agentBindingId),
    describeCapability: deps.describeCapability,
    ...(options.reviewKind ? { reviewKind: options.reviewKind } : {}),
    ...(options.blockedAt === undefined ? {} : { blockedAt: options.blockedAt }),
  });
  const result = await deps.approvalQueue.requestMissionReview({
    kind: "mission-review",
    callerId: `mission:${mission.missionId}`,
    callerKind: "system",
    repoPath: mission.charter.harness.unit,
    effectiveVersion: mission.closureDigest,
    requestedByUserId,
    requesterCategory: "agent",
    operation: {
      kind: "runtime",
      verb: "review unattended mission",
      object: { type: "mission", label: "Mission", value: mission.name },
    },
    missionId: mission.missionId,
    revision: mission.revision,
    closureDigest: mission.closureDigest,
    ...presentation,
  });
  if (result.decision === "cancelled") {
    return deps.registry.get(mission.missionId) ?? mission;
  }
  if (result.decision === "dismiss") {
    if (options.reviewKind === "out-of-charter" && options.declinedRestriction) {
      return deps.registry.declinePermissionRevision({
        missionId: mission.missionId,
        ...options.declinedRestriction,
        decidedBy: result.decidedBy,
        contextIntegrityReady: deps.contextIntegrityReady(),
      });
    }
    return deps.registry.get(mission.missionId) ?? mission;
  }

  const latest = deps.registry.get(mission.missionId);
  if (
    !latest ||
    latest.revision !== mission.revision ||
    latest.closureDigest !== mission.closureDigest
  ) {
    throw Object.assign(new Error("Mission changed while its review was open"), {
      code: "EAGAIN",
    });
  }
  const optional = new Set(
    presentation.authority.diff.added.filter((row) => row.tier === "gated").map(authorityRowKey)
  );
  const selected = new Set(result.selectedAuthorityKeys);
  const permissions = latest.permissions.filter((permission) => {
    const key = authorityRowKey({
      capability: permission.capability,
      resourceScope: permission.resource,
    });
    return !optional.has(key) || selected.has(key);
  });
  return deps.registry.approve({
    missionId: latest.missionId,
    permissions,
    standingRestrictions: latest.standingRestrictions,
    decidedBy: result.decidedBy,
    contextIntegrityReady: deps.contextIntegrityReady(),
  });
}

function requireVisibleMission(
  registry: MissionRegistry,
  missionId: string,
  userId: string
): MissionRecord {
  const mission = registry.getForUser(missionId, userId);
  if (!mission) {
    throw Object.assign(new Error(`Unknown mission ${missionId}`), { code: "ENOENT" });
  }
  return mission;
}

function viewerUserId(ctx: Parameters<ServiceDefinition["handler"]>[0]): string | null {
  if (ctx.caller.hostOriginated === true) return null;
  return humanUserId(ctx);
}

function humanUserId(ctx: Parameters<ServiceDefinition["handler"]>[0]): string {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Mission changes require a human user"), { code: "EACCES" });
  }
  return userId;
}

function humanOwner(ctx: Parameters<ServiceDefinition["handler"]>[0]): {
  userId: string;
  deviceId: string;
} {
  return {
    userId: humanUserId(ctx),
    deviceId: ctx.caller.runtime.id,
  };
}
