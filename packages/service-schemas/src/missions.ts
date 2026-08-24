import { z } from "zod";
import { defineReceiverServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const missionSubject = z.string().regex(/^mission:[^@]+@[0-9a-f]{64}$/u);
const stateRef = z.string().regex(/^state:[0-9a-f]{64}$/u) as z.ZodType<`state:${string}`>;
const authorityPlanRef = z
  .string()
  .regex(/^authority-plan:[0-9a-f]{64}$/u) as z.ZodType<`authority-plan:${string}`>;

const executionImageSchema = z
  .object({
    source: z.string().min(1).max(512),
    ref: stateRef,
    effectiveVersion: hex64,
    className: z.string().min(1).max(128),
    objectKey: z.string().min(1).max(512),
  })
  .strict();

const operationIntentSchema = z
  .object({
    service: z.string().min(1).max(256),
    method: z.string().min(1).max(256),
    args: z.array(z.unknown()).max(64).optional(),
    use: z.enum(["action", "conditional"]),
  })
  .strict();

const authorityPlanReferenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    digest: hex64,
    artifactRef: authorityPlanRef,
    compilerVersion: z.string().min(1).max(128),
    catalogDigest: hex64,
  })
  .strict();

const agentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string().min(1).max(24_000) }).strict(),
  z
    .object({
      kind: z.literal("eval"),
      code: z.string().min(1).max(96_000),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      reset: z.boolean().optional(),
    })
    .strict(),
]);

const executionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("method"),
      image: executionImageSchema,
      method: z.string().min(1).max(128),
      args: z.array(z.unknown()).max(64),
      operations: z.array(operationIntentSchema).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      image: executionImageSchema,
      action: agentActionSchema,
      conversation: z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("continue"),
            channelId: z.string().min(1),
            contextId: z.string().min(1),
            executorId: z.string().min(1),
          })
          .strict(),
        z.object({ mode: z.literal("fresh") }).strict(),
      ]),
      operations: z.array(operationIntentSchema).max(256),
    })
    .strict(),
]);

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      everyMs: z.number().int().min(60_000),
      anchorAt: z.number().int().nonnegative().optional(),
      jitterMs: z.number().int().nonnegative().optional(),
      untilAt: z.number().int().nonnegative().optional(),
      maxRuns: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().min(1).max(512),
      timezone: z.string().min(1).max(128),
      untilAt: z.number().int().nonnegative().optional(),
      maxRuns: z.number().int().positive().optional(),
    })
    .strict(),
]);

export const missionCharterSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    execution: executionSchema,
    trigger: triggerSchema,
  })
  .strict();

const authorityProjectionSchema = z
  .object({
    requestIds: z.array(z.string().min(1)),
    grantIds: z.array(z.string().min(1)),
    denialIds: z.array(z.string().min(1)),
  })
  .strict();

export const missionRecordSchema = z
  .object({
    schemaVersion: z.literal(3),
    missionId: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int().positive(),
    charter: missionCharterSchema,
    authorityPlan: authorityPlanReferenceSchema,
    owner: z.object({ userId: z.string().min(1) }).strict(),
    state: z.enum(["active", "paused", "completed", "retired"]),
    revisionDigest: hex64,
    authority: authorityProjectionSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    completionReason: z.enum(["until", "max-runs", "response"]).optional(),
    completionResponse: z.string().optional(),
    seeded: z.boolean().optional(),
    nextRunAt: z.number().int().nonnegative().optional(),
    lastRunAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const runFailureSchema = z
  .object({
    code: z.string().min(1),
    stage: z.string().min(1),
    message: z.string(),
    retry: z.enum(["automatic", "manual", "none"]),
    invocationId: z.string().optional(),
    acquisitionId: z.string().optional(),
    executorId: z.string().optional(),
    causalEventRef: z.string().optional(),
    detailsRef: z.string().optional(),
  })
  .strict();

const runEffectFailureSchema = z
  .object({
    invocationId: z.string().min(1),
    name: z.string().min(1),
    outcome: z.enum([
      "tool_error",
      "infrastructure_error",
      "cancelled",
      "stale_dispatch",
      "abandoned",
    ]),
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

export const missionRunRecordSchema = z
  .object({
    runId: z.string().min(1),
    missionId: z.string().min(1),
    missionSubject,
    revision: z.number().int().positive(),
    trigger: z.enum(["manual", "scheduled"]),
    phase: z.enum([
      "admitted",
      "execution-admitting",
      "context-preparing",
      "executor-preparing",
      "dispatching",
      "executing",
      "terminal",
    ]),
    outcome: z
      .enum(["succeeded", "completed-with-errors", "failed", "skipped", "interrupted", "cancelled"])
      .optional(),
    startedAt: z.number().int().nonnegative(),
    runNumber: z.number().int().positive().optional(),
    finishedAt: z.number().int().nonnegative().optional(),
    authoritySessionId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    executorId: z.string().min(1).optional(),
    finalMessage: z.string().optional(),
    completionResponse: z.string().optional(),
    failure: runFailureSchema.optional(),
    effectFailures: z.array(runEffectFailureSchema).max(256).optional(),
  })
  .strict();

const runCursorSchema = z
  .object({ startedAt: z.number().int().nonnegative(), runId: z.string() })
  .strict();
const overviewCursorSchema = z
  .object({ updatedAt: z.number().int().nonnegative(), missionId: z.string() })
  .strict();
const overviewOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    cursor: overviewCursorSchema.optional(),
    filter: z.enum(["all", "attention", "active", "paused", "completed"]).optional(),
    query: z.string().max(200).optional(),
    missionId: z.string().optional(),
  })
  .strict();
const runPageSchema = z
  .object({ items: z.array(missionRunRecordSchema), nextCursor: runCursorSchema.optional() })
  .strict();
const overviewSchema = z
  .object({
    generatedAt: z.number().int().nonnegative(),
    stats: z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        issueRunsLast24Hours: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(
      z
        .object({
          automation: missionRecordSchema,
          recentRuns: z.array(missionRunRecordSchema),
          totalRuns: z.number().int().nonnegative(),
          activeRuns: z.number().int().nonnegative(),
          issueRunsSince: z.number().int().nonnegative(),
        })
        .strict()
    ),
    nextCursor: overviewCursorSchema.optional(),
    attention: z.array(
      z
        .object({ missionId: z.string(), missionName: z.string(), run: missionRunRecordSchema })
        .strict()
    ),
  })
  .strict();

const createInputSchema = z
  .object({ name: z.string().min(1).max(200), charter: missionCharterSchema })
  .strict();
const READERS: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "mission", "host"],
};
const USER_SESSION_CODE_HOST: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "host"],
};
const AUTOMATION_AUTHORS: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "mission"],
};
const HOST_CODE: ServiceAuthorityPolicy = { principals: ["host", "code"] };

export const missionsMethods = defineReceiverServiceMethods({
  overview: read(
    "Page visible automations with bounded recent runs and failures.",
    z.tuple([overviewOptionsSchema]),
    overviewSchema
  ),
  list: read(
    "List durable automations and their schedule state.",
    z.tuple([]),
    z.array(missionRecordSchema)
  ),
  get: read("Read one durable automation.", z.tuple([z.string()]), missionRecordSchema.nullable()),
  listRuns: read(
    "Page through one automation's durable run ledger.",
    z.tuple([
      z.string(),
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          cursor: runCursorSchema.optional(),
        })
        .strict(),
    ]),
    runPageSchema
  ),
  getRun: {
    ...read(
      "Read one exact automation run.",
      z.tuple([z.string()]),
      missionRunRecordSchema.nullable()
    ),
    agentFacing: true,
  },
  launch: {
    capability: "missions.edit",
    tier: open(
      "mission.create",
      "Launch creates an active definition; authority is acquired through the ordinary authority service."
    ),
    description: "Idempotently compile, persist, and activate one automation revision.",
    args: z.tuple([createInputSchema]),
    returns: missionRecordSchema,
    authority: AUTOMATION_AUTHORS,
    access: { sensitivity: "write" },
    agentFacing: false,
  },
  edit: {
    capability: "missions.edit",
    tier: gated("mission.mutate", "Editing replaces the immutable automation revision."),
    presentation: presentation(
      "Change an automation",
      "change an automation",
      "Edit an automated task and install a new revision."
    ),
    description: "Install a new automation revision.",
    args: z.tuple([
      z.string(),
      z
        .object({ name: z.string().min(1).optional(), charter: missionCharterSchema.optional() })
        .strict(),
    ]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" },
    agentFacing: true,
  },
  runNow: {
    capability: "missions.run",
    tier: gated("mission.control", "A manual run admits one exact installed revision."),
    presentation: presentation(
      "Run an automation now",
      "run an automation now",
      "Starts one run of an installed automation."
    ),
    description: "Start one manual run.",
    args: z.tuple([z.string()]),
    returns: missionRunRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" },
    agentFacing: true,
  },
  pause: lifecycle("Pause", "pause", "missions.pause"),
  resume: lifecycle("Resume", "resume", "missions.pause"),
  retire: {
    capability: "missions.retire",
    tier: critical(
      "mission.retire",
      "Retirement ends the automation identity and its standing authority."
    ),
    presentation: presentation(
      "Remove an automation",
      "remove an automation",
      "Permanently remove an automated task."
    ),
    description: "Retire an automation permanently.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "destructive" },
    agentFacing: true,
  },
  finishRun: {
    capability: "missions.run",
    tier: openCode("mission.control", "Only the admitted executor terminalizes its run."),
    description: "Record an admitted executor's terminal result.",
    args: z.tuple([
      z
        .object({
          runId: z.string(),
          outcome: z.enum([
            "succeeded",
            "completed-with-errors",
            "failed",
            "interrupted",
            "cancelled",
          ]),
          finalMessage: z.string().optional(),
          completionResponse: z.string().optional(),
          failure: runFailureSchema.optional(),
          effectFailures: z.array(runEffectFailureSchema).max(256).optional(),
        })
        .strict(),
    ]),
    returns: z.void(),
    authority: HOST_CODE,
    access: { sensitivity: "write" },
    agentFacing: false,
  },
});

function read(description: string, args: z.ZodTypeAny, returns: z.ZodTypeAny) {
  return {
    capability: "missions.read",
    tier: open("mission.read", description),
    description,
    args,
    returns,
    authority: READERS,
    access: { sensitivity: "read" as const },
  };
}
function open(family: string, rationale: string) {
  return {
    tier: "open" as const,
    session: "family" as const,
    residency: "identity" as const,
    family,
    rationale,
  };
}
function openCode(family: string, rationale: string) {
  return {
    tier: "open" as const,
    session: "codeOnly" as const,
    residency: "grant-authority" as const,
    family,
    rationale,
  };
}
function gated(family: string, rationale: string) {
  return {
    tier: "gated" as const,
    session: "family" as const,
    residency: "grant-authority" as const,
    family,
    rationale,
  };
}
function critical(family: string, rationale: string) {
  return { ...gated(family, rationale), tier: "critical" as const };
}
function presentation(title: string, action: string, description: string) {
  return {
    title,
    action,
    description,
    group: "runtime" as const,
    authorityCategory: { domain: "safety" as const, verb: "manage" as const },
  };
}
function lifecycle(title: string, action: string, capability: string) {
  return {
    capability,
    tier: gated(
      "mission.control",
      `${title} changes admission eligibility without changing standing authority.`
    ),
    presentation: presentation(
      `${title} an automation`,
      `${action} an automation`,
      `${title} scheduling without changing its revision or authority.`
    ),
    description: `${title} scheduling without changing the revision.`,
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" as const },
    agentFacing: true,
  };
}
