import { z } from "zod";
import { DURABLE_WORK_QUEUES } from "@vibestudio/shared/durableWork";
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { AuthorityResourceScopeSchema, UnitAuthorityManifestSchema } from "./build.js";
import {
  HeartbeatRegistryRowSchema,
  LifecycleKeySchema,
  LifecycleLeaseSchema,
  workspaceStateMethods,
} from "./workspaceState.js";

const hostOnly: ServiceAuthorityPolicy = { principals: ["host"] };
const internal = (
  sensitivity: "read" | "write" | "destructive",
  capability = "workspace.runtime-state.manage"
) => ({
  capability,
  authority: hostOnly,
  tier: {
    tier: "gated" as const,
    session: "family" as const,
    rationale: "Host-only control of authority-bearing product-builtin workspace state.",
  },
  access: { sensitivity },
});

const entityKindSchema = z.enum(["panel", "app", "worker", "do", "session", "shell", "server"]);
const entitySourceSchema = z
  // Inert sessions and preparing reservations have a source coordinate but no
  // executable image. Their empty effectiveVersion is an honest absence, not a
  // synthetic build identity; executable activations are checked together with
  // their sealed build tuple by WorkspaceDO.
  .object({ repoPath: z.string().min(1), effectiveVersion: z.string() })
  .strict();
const agentBindingSchema = z
  .object({
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
  })
  .strict();
const entityActivationSchema = z
  .object({
    kind: entityKindSchema,
    source: entitySourceSchema,
    activeBuildKey: z.string().min(1).optional(),
    activeExecutionDigest: z.string().min(1).optional(),
    activeAuthority: UnitAuthorityManifestSchema.optional(),
    contextId: z.string().min(1),
    className: z.string().min(1).optional(),
    key: z.string().min(1),
    stateArgs: z.unknown().optional(),
    agentBinding: agentBindingSchema.optional(),
    parentId: z.string().min(1).optional(),
    ownerUserId: z.string().min(1).optional(),
  })
  .strict();
const entityReservationSchema = entityActivationSchema.extend({
  lifecycleOwner: z
    .object({ contextId: z.string().min(1), entityId: z.string().min(1) })
    .strict()
    .optional(),
});
const entityRecordSchema = entityActivationSchema.extend({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["preparing", "active", "retired"]),
  retiredAt: z.number().int().nonnegative().optional(),
  cleanupComplete: z.boolean(),
  error: z.string().optional(),
});

const lifecycleEpochSchema = z
  .object({
    kind: z.enum(["planned", "crash", "server_restart"]),
    reason: z.string(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
const lifecycleOpStatusSchema = z.enum(["pending", "ready", "timed_out", "failed", "resumed"]);
const lifecycleOpInputSchema = z
  .object({
    epochId: z.string().min(1),
    key: LifecycleKeySchema,
    opKind: z.enum(["prepare", "resume"]),
    status: lifecycleOpStatusSchema,
    detail: z.unknown().optional(),
  })
  .strict();
const lifecycleLeaseResultSchema = LifecycleKeySchema.extend({
  detail: z.unknown().nullable(),
  createdAt: z.number().int().nonnegative(),
  refreshedAt: z.number().int().nonnegative(),
});
const lifecycleOpResultSchema = LifecycleKeySchema.extend({
  epochId: z.string().min(1),
  opKind: z.enum(["prepare", "resume"]),
  status: lifecycleOpStatusSchema,
  detail: z.unknown().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

const durableWorkQueueSchema = z.enum(DURABLE_WORK_QUEUES);
const durableWorkReadyHintSchema = z
  .object({
    owner: LifecycleKeySchema,
    queues: z.array(durableWorkQueueSchema).min(1),
  })
  .strict();

const testCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), key: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("prefix"), prefix: z.string() }).strict(),
]);
const testPolicySchema = z.discriminatedUnion("kind", [
  z.object({ policyId: z.string().min(1), kind: z.literal("orchestrator") }).strict(),
  z
    .object({
      policyId: z.string().min(1),
      kind: z.literal("case"),
      orchestratorPolicyId: z.string().min(1),
      case: z
        .object({
          testId: z.string().min(1),
          agent: z
            .object({
              model: z.string().min(1),
              approvalLevel: z.literal(2),
              fallback: z.union([
                z.literal("disabled"),
                z
                  .object({
                    model: z.string().min(1),
                    thinkingLevel: z.literal("low"),
                    on: z.tuple([z.literal("usage_limit_terminal")]).readonly(),
                    scope: z.literal("all-turns"),
                  })
                  .strict(),
              ]),
            })
            .strict(),
          authority: z.array(
            z
              .object({
                ruleId: z.string().min(1),
                capability: testCapabilitySchema,
                resource: AuthorityResourceScopeSchema,
                tier: z.enum(["gated", "critical"]),
                decision: z.enum(["once", "deny"]),
              })
              .strict()
          ),
          unexpectedPrompts: z.literal("fail"),
        })
        .strict(),
    })
    .strict(),
]);
const alarmSetInputSchema = LifecycleKeySchema.extend({
  wakeAt: z.number().int().nonnegative(),
  testPolicy: testPolicySchema.optional(),
  dispatchOwner: z.string().min(1).optional(),
  dispatchGeneration: z.number().int().positive().optional(),
});
const alarmClearInputSchema = LifecycleKeySchema.extend({
  dispatchOwner: z.string().min(1).optional(),
  dispatchGeneration: z.number().int().positive().optional(),
});
const alarmClaimSchema = LifecycleKeySchema.extend({
  wakeAt: z.number().int().nonnegative(),
  dispatchGeneration: z.number().int().positive(),
  testPolicy: testPolicySchema.optional(),
});

const recurringJobSchema = z
  .object({
    name: z.string().min(1),
    source: z.string().min(1),
    className: z.string().min(1),
    objectKey: z.string().min(1),
    method: z.string().min(1),
    argsJson: z.string(),
    intervalMs: z.number().int().positive(),
    atMinutes: z.number().int().min(0).max(1439).nullable().optional(),
    specHash: z.string().min(1),
    initialNextRunAt: z.number().int().nonnegative(),
    lastRunAt: z.number().int().nonnegative().nullable().optional(),
    nextRunAt: z.number().int().nonnegative().optional(),
    failCount: z.number().int().nonnegative().optional(),
    backoffUntil: z.number().int().nonnegative().nullable().optional(),
    lastStartedAt: z.number().int().nonnegative().nullable().optional(),
    lastSucceededAt: z.number().int().nonnegative().nullable().optional(),
    lastFailedAt: z.number().int().nonnegative().nullable().optional(),
    lastError: z.string().nullable().optional(),
    lastDurationMs: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

const contextEdgeKindSchema = z.enum(["lifecycle", "lineage"]);
const ownerEdgeSchema = z
  .object({
    contextId: z.string().min(1),
    kind: contextEdgeKindSchema,
    ownerEntityId: z.string().nullable(),
  })
  .strict();
const childEdgeSchema = z
  .object({
    ownerContextId: z.string().min(1),
    kind: contextEdgeKindSchema,
    ownerEntityId: z.string().nullable(),
  })
  .strict();

const rawWorkspaceStateEngineMethods = defineServiceMethods({
  entityActivate: {
    ...internal("write"),
    args: z.tuple([entityActivationSchema]),
    returns: entityRecordSchema,
  },
  entityReserve: {
    ...internal("write"),
    args: z.tuple([entityReservationSchema]),
    returns: entityRecordSchema,
  },
  entityAdvanceExecution: {
    ...internal("write"),
    args: z.tuple([entityActivationSchema]),
    returns: entityRecordSchema,
  },
  entityAdvanceExecutions: {
    ...internal("write"),
    args: z.tuple([z.array(entityActivationSchema)]),
    returns: z.array(entityRecordSchema),
  },
  entityRetire: {
    ...internal("destructive"),
    args: z.tuple([z.string().min(1)]),
    returns: entityRecordSchema.nullable(),
  },
  entityCleanupComplete: {
    ...internal("write"),
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
  },
  entityFindIncompleteCleanups: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(entityRecordSchema),
  },
  entityGc: {
    ...internal("destructive"),
    args: z.tuple([
      z
        .object({
          all: z.boolean().optional(),
          slotId: z.string().min(1).optional(),
          graceMs: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z.array(z.string()),
  },
  entityResolve: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: entityRecordSchema.nullable(),
  },
  entityResolveActive: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: entityRecordSchema.nullable(),
  },
  entityResolveContext: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: z.string().nullable(),
  },
  slotResolveByEntity: {
    ...workspaceStateMethods["slot.resolveByEntity"],
  },
  lifecycleLeaseUpsert: {
    ...internal("write"),
    args: z.tuple([LifecycleLeaseSchema]),
    returns: z.void(),
  },
  lifecycleLeaseClear: {
    ...internal("write"),
    args: z.tuple([LifecycleKeySchema]),
    returns: z.void(),
  },
  durableWorkOwnerRegister: {
    ...internal("write"),
    args: z.tuple([LifecycleKeySchema.extend({ queues: z.array(durableWorkQueueSchema).min(1) })]),
    returns: z.void(),
  },
  durableWorkOwnerList: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(durableWorkReadyHintSchema),
  },
  alarmSet: {
    ...internal("write"),
    args: z.tuple([alarmSetInputSchema]),
    returns: z.enum(["accepted", "stale"]),
  },
  alarmClear: {
    ...internal("write"),
    args: z.tuple([alarmClearInputSchema]),
    returns: z.enum(["accepted", "stale"]),
  },
  alarmNextWakeAt: {
    ...internal("read"),
    args: z.tuple([z.number().int().nonnegative(), z.array(LifecycleKeySchema).optional()]),
    returns: z.number().int().nonnegative().nullable(),
  },
  alarmAdoptWorker: {
    ...internal("write"),
    args: z.tuple([z.string().min(8).max(512)]),
    returns: z.object({ previousWorkerId: z.string().nullable() }).strict(),
  },
  alarmListScheduled: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(LifecycleKeySchema),
  },
  alarmClaimDue: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          now: z.number().int().nonnegative(),
          workerId: z.string().min(1),
          limit: z.number().int().min(1).max(1_000),
          exclude: z.array(LifecycleKeySchema).optional(),
        })
        .strict(),
    ]),
    returns: z.array(alarmClaimSchema),
  },
  recurringSync: {
    ...internal("write"),
    args: z.tuple([z.object({ jobs: z.array(recurringJobSchema) }).strict()]),
    returns: z.void(),
  },
  recurringDue: {
    ...internal("read"),
    args: z.tuple([z.number().int().nonnegative()]),
    returns: z.array(recurringJobSchema),
  },
  recurringMarkRun: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          name: z.string().min(1),
          lastRunAt: z.number().int().nonnegative(),
          nextRunAt: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    returns: z.void(),
  },
  recurringMarkSucceeded: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          name: z.string().min(1),
          finishedAt: z.number().int().nonnegative(),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    returns: z.void(),
  },
  recurringMarkFailed: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          name: z.string().min(1),
          failedAt: z.number().int().nonnegative(),
          nextRunAt: z.number().int().nonnegative(),
          failCount: z.number().int().positive(),
          error: z.string(),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    returns: z.void(),
  },
  recurringNextWakeAt: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.number().int().nonnegative().nullable(),
  },
  recurringList: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(recurringJobSchema),
  },
  heartbeatRegister: {
    ...internal("write"),
    args: z.tuple([HeartbeatRegistryRowSchema]),
    returns: z.void(),
  },
  heartbeatRemove: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          name: z.string().min(1),
          source: z.string().min(1).optional(),
          className: z.string().min(1).optional(),
          objectKey: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    returns: z.void(),
  },
  heartbeatList: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(HeartbeatRegistryRowSchema),
  },
  lifecycleListLeases: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(lifecycleLeaseResultSchema),
  },
  lifecycleOpenEpoch: {
    ...internal("write"),
    args: z.tuple([lifecycleEpochSchema]),
    returns: z.string().min(1),
  },
  lifecycleRecordOp: {
    ...internal("write"),
    args: z.tuple([lifecycleOpInputSchema]),
    returns: z.void(),
  },
  lifecycleListOps: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: z.array(lifecycleOpResultSchema),
  },
  lifecycleCompleteEpoch: {
    ...internal("write"),
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
  },
  lifecycleListResumeTargets: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(LifecycleKeySchema),
  },
  entityListActive: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(entityRecordSchema),
  },
  entityListActiveByKind: {
    ...internal("read"),
    args: z.tuple([entityKindSchema]),
    returns: z.array(entityRecordSchema),
  },
  entityListPreparing: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(entityRecordSchema),
  },
  entityListPreparingByKind: {
    ...internal("read"),
    args: z.tuple([entityKindSchema]),
    returns: z.array(entityRecordSchema),
  },
  entityListExecutionRoots: {
    ...internal("read", "workspace.runtime-state.inspect"),
    args: z.tuple([]),
    returns: z.array(entityRecordSchema),
  },
  entityListByContext: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: z.array(entityRecordSchema),
  },
  contextEdgeUpsert: {
    ...internal("write"),
    args: z.tuple([
      z
        .object({
          contextId: z.string().min(1),
          ownerContextId: z.string().min(1),
          kind: contextEdgeKindSchema,
          ownerEntityId: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    returns: z.void(),
  },
  contextEdgeListByOwner: {
    ...internal("read"),
    args: z.tuple([
      z
        .object({
          ownerContextId: z.string().min(1),
          kind: contextEdgeKindSchema.optional(),
        })
        .strict(),
    ]),
    returns: z.array(ownerEdgeSchema),
  },
  contextEdgeListByChild: {
    ...internal("read"),
    args: z.tuple([z.string().min(1)]),
    returns: z.array(childEdgeSchema),
  },
  contextEdgeDeleteByChild: {
    ...internal("write"),
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
  },
  panelTreeRootGroups: { ...workspaceStateMethods["panelTree.rootGroups"] },
  panelTreePage: { ...workspaceStateMethods["panelTree.page"] },
  panelTreePath: { ...workspaceStateMethods["panelTree.path"] },
  panelTreeDetail: { ...workspaceStateMethods["panelTree.detail"] },
  panelTreeSearch: { ...workspaceStateMethods["panelTree.search"] },
  slotCreate: { ...workspaceStateMethods["slot.create"] },
  slotCommitPreparedNavigation: {
    ...workspaceStateMethods["slot.commitPreparedNavigation"],
  },
  slotUpdateCurrentStateArgs: {
    ...workspaceStateMethods["slot.updateCurrentStateArgs"],
  },
  slotMove: { ...workspaceStateMethods["slot.move"] },
  slotClose: { ...workspaceStateMethods["slot.close"] },
  slotCloseOwnedRoots: { ...workspaceStateMethods["slot.closeOwnedRoots"] },
  slotCloseCleanupPage: { ...workspaceStateMethods["slot.closeCleanupPage"] },
  slotCloseCleanupAck: { ...workspaceStateMethods["slot.closeCleanupAck"] },
  slotGet: { ...workspaceStateMethods["slot.get"] },
  slotHistoryRelative: { ...workspaceStateMethods["slot.historyRelative"] },
  slotHistoryEntry: { ...workspaceStateMethods["slot.historyEntry"] },
  panelIndex: { ...workspaceStateMethods["panel.index"] },
  panelUpdateTitle: { ...workspaceStateMethods["panel.updateTitle"] },
  panelIncrementAccess: { ...workspaceStateMethods["panel.incrementAccess"] },
  entitySetDisplayTitle: {
    ...internal("write"),
    args: z.tuple([z.string().min(1), z.string().nullable()]),
    returns: z.void(),
  },
  entityListDisplayTitles: {
    ...internal("read"),
    args: z.tuple([]),
    returns: z.array(z.object({ id: z.string().min(1), title: z.string() }).strict()),
  },
  panelSearch: { ...workspaceStateMethods["panel.search"] },
  panelSourceUsage: { ...workspaceStateMethods["panel.sourceUsage"] },
  panelRebuildIndex: { ...workspaceStateMethods["panel.rebuildIndex"] },
});

export const workspaceStateEngineMethods = Object.fromEntries(
  Object.entries(rawWorkspaceStateEngineMethods).map(([name, schema]) => [
    name,
    {
      description:
        (schema as MethodSchema).description ??
        `Operate durable workspace runtime state: ${name
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()}.`,
      ...schema,
    },
  ])
) as unknown as typeof rawWorkspaceStateEngineMethods;
