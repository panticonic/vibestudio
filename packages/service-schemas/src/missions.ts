import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { AuthorityResourceScopeSchema } from "./build.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const missionTargetSchema = z
  .object({
    source: z.string().min(1).max(512),
    className: z.string().min(1).max(128),
    objectKey: z.string().min(1).max(512),
  })
  .strict();
const missionToolExposureSchema = z
  .object({
    services: z.array(z.string().min(1).max(256)).max(256),
    userlandServices: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            provider: z.string().min(1).max(512),
            providerEv: z.string().min(1).max(128),
            upgradePolicy: z.enum(["pinned", "follow-head"]),
          })
          .strict()
      )
      .max(64),
    workspaceServiceDiscovery: z.enum(["bound", "live-declarations"]),
    evalNetwork: z.enum(["none", "declared-origins", "unrestricted"]),
    declaredOrigins: z.array(z.string().max(2_048)).max(64),
  })
  .strict();
const missionAgentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string().min(1).max(24_000) }).strict(),
  z
    .object({
      kind: z.literal("eval"),
      code: z.string().min(1).max(96_000),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1_000)
        .optional(),
      reset: z.boolean().optional(),
    })
    .strict(),
]);
const missionExecutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("method"),
      target: missionTargetSchema,
      method: z.string().min(1).max(128),
      args: z.array(z.unknown()).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      target: missionTargetSchema,
      action: missionAgentActionSchema,
      conversation: z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("continue"),
            channelId: z.string().min(1),
            contextId: z.string().min(1),
          })
          .strict(),
        z.object({ mode: z.literal("fresh") }).strict(),
      ]),
      toolExposure: missionToolExposureSchema,
      declaredLineageClasses: z
        .array(z.enum(["none", "web", "email", "channel-external", "external"]))
        .min(1)
        .max(5),
    })
    .strict(),
]);

export const missionCharterSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    harness: z.object({ unit: z.string().min(1).max(512), ev: hex64 }).strict(),
    execution: missionExecutionSchema,
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z
        .object({
          kind: z.literal("schedule"),
          everyMs: z.number().int().min(60_000),
          anchorAt: z.number().int().nonnegative().optional(),
          jitterMs: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export const missionPermissionSchema = z
  .object({
    capability: z.string().min(1),
    resource: AuthorityResourceScopeSchema,
    tier: z.enum(["gated", "critical"]),
  })
  .strict();

export const missionStandingRestrictionSchema = z
  .object({ capability: z.string().min(1), resourceKey: z.string().min(1) })
  .strict();

export const missionRecordSchema = z
  .object({
    missionId: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int().positive(),
    charter: missionCharterSchema,
    owner: z.object({ userId: z.string().min(1), deviceId: z.string().min(1) }).strict(),
    state: z.enum(["draft", "active", "needs-reapproval", "paused", "retired"]),
    revisionDigest: hex64,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative().optional(),
    seeded: z.boolean().optional(),
    permissions: z.array(missionPermissionSchema),
    standingRestrictions: z.array(missionStandingRestrictionSchema),
    nextRunAt: z.number().int().nonnegative().optional(),
    lastRunAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const missionRunRecordSchema = z
  .object({
    runId: z.string().min(1),
    missionId: z.string().min(1),
    closureDigest: hex64,
    trigger: z.enum(["manual", "scheduled"]),
    status: z.enum(["starting", "running", "succeeded", "failed", "skipped"]),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    executorId: z.string().min(1).optional(),
    finalMessage: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const missionRunCursorSchema = z
  .object({
    startedAt: z.number().int().nonnegative(),
    runId: z.string().min(1),
  })
  .strict();

const missionOverviewCursorSchema = z
  .object({
    updatedAt: z.number().int().nonnegative(),
    missionId: z.string().min(1),
  })
  .strict();

const missionOverviewOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    cursor: missionOverviewCursorSchema.optional(),
    filter: z.enum(["all", "attention", "active", "paused", "drafts"]).optional(),
    query: z.string().max(200).optional(),
  })
  .strict();

const missionRunPageSchema = z
  .object({
    items: z.array(missionRunRecordSchema),
    nextCursor: missionRunCursorSchema.optional(),
  })
  .strict();

const missionOverviewSchema = z
  .object({
    generatedAt: z.number().int().nonnegative(),
    stats: z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        failedLast24Hours: z.number().int().nonnegative(),
        awaitingReview: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(
      z
        .object({
          automation: missionRecordSchema,
          recentRuns: z.array(missionRunRecordSchema),
          totalRuns: z.number().int().nonnegative(),
          activeRuns: z.number().int().nonnegative(),
          failedRunsSince: z.number().int().nonnegative(),
        })
        .strict()
    ),
    nextCursor: missionOverviewCursorSchema.optional(),
    attention: z.array(
      z
        .object({
          missionId: z.string().min(1),
          missionName: z.string().min(1),
          run: missionRunRecordSchema,
        })
        .strict()
    ),
  })
  .strict();

const createInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    charter: missionCharterSchema,
    permissions: z.array(missionPermissionSchema).max(256),
    standingRestrictions: z.array(missionStandingRestrictionSchema).max(256).optional(),
  })
  .strict();

const READERS: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "mission", "host"],
};
const USER_CODE_HOST: ServiceAuthorityPolicy = { principals: ["user", "code", "host"] };
const USER_SESSION_CODE_HOST: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "host"],
};
const AGENT_PROPOSAL: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session", "mission"],
};
const HOST_CODE: ServiceAuthorityPolicy = { principals: ["host", "code"] };
const HOST: ServiceAuthorityPolicy = { principals: ["host"] };

export const missionsMethods = defineServiceMethods({
  overview: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.read",
      rationale: "Authenticated users and their agents read a bounded automation and run summary",
    },
    description:
      "Page visible automations with bounded recent runs, global aggregate counts, server-side filtering, and recent failures.",
    args: z.tuple([missionOverviewOptionsSchema]),
    returns: missionOverviewSchema,
    authority: READERS,
    access: { sensitivity: "read" },
  },
  list: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.read",
      rationale: "Authenticated users and their agents read automation definitions and status",
    },
    description: "List durable automations and their current schedule state.",
    args: z.tuple([]),
    returns: z.array(missionRecordSchema),
    authority: READERS,
    access: { sensitivity: "read" },
  },
  get: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.read",
      rationale: "Authenticated users and their agents read one automation definition",
    },
    description: "Read one durable automation.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema.nullable(),
    authority: READERS,
    access: { sensitivity: "read" },
  },
  listRuns: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.read",
      rationale: "Authenticated users and their agents read the durable run ledger",
    },
    description: "Page through run history, conversation links, final messages, and errors.",
    args: z.tuple([
      z.string(),
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          cursor: missionRunCursorSchema.optional(),
        })
        .strict(),
    ]),
    returns: missionRunPageSchema,
    authority: READERS,
    access: { sensitivity: "read" },
  },
  getRun: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.read",
      rationale: "Authenticated users and their agents inspect one exact automation tick",
    },
    description: "Read one exact automation run with its conversation, result, and error.",
    args: z.tuple([z.string()]),
    returns: missionRunRecordSchema.nullable(),
    authority: READERS,
    access: { sensitivity: "read" },
    agentFacing: true,
  },
  proposeDraft: {
    capability: "missions.edit",
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "mission.create",
      rationale: "An inert automation draft grants nothing and schedules nothing",
    },
    description:
      "Propose an inert automation draft. Agents should use this method, then direct the user to Automations for review.",
    args: z.tuple([createInputSchema]),
    returns: missionRecordSchema,
    authority: AGENT_PROPOSAL,
    access: { sensitivity: "write" },
    agentFacing: true,
  },
  createDraft: {
    capability: "missions.edit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "identity",
      family: "mission.create",
      rationale: "Human-authored automation drafts remain inert until review",
    },
    presentation: {
      title: "Create an automation draft",
      action: "create an automation draft",
      description: "Allows {requesterKind} to create an automation draft.",
      group: "runtime",
      authorityCategory: { domain: "safety", verb: "manage" },
    },
    description: "Create an inert automation draft.",
    args: z.tuple([createInputSchema]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "write" },
    agentFacing: false,
  },
  edit: {
    capability: "missions.edit",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "mission.mutate",
      rationale: "Automation edits lapse the reviewed closure",
    },
    presentation: {
      title: "Change an automation",
      action: "change an automation",
      description: "Allows {requesterKind} to change an automation.",
      group: "runtime",
      authorityCategory: { domain: "safety", verb: "manage" },
    },
    description: "Edit an automation; behavior changes require review again.",
    args: z.tuple([
      z.string(),
      z
        .object({
          name: z.string().min(1).optional(),
          charter: missionCharterSchema.optional(),
          permissions: z.array(missionPermissionSchema).optional(),
          standingRestrictions: z.array(missionStandingRestrictionSchema).optional(),
        })
        .strict(),
    ]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" },
    agentFacing: true,
  },
  requestReview: {
    capability: "missions.review",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Opening an inert draft in the approval queue grants nothing by itself",
    },
    description: "Review and activate the exact automation closure.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "admin" },
    agentFacing: false,
  },
  runNow: {
    capability: "missions.run",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "A manual run executes the already reviewed closure",
    },
    presentation: {
      title: "Run an automation now",
      action: "run an automation now",
      description: "Starts one run of an already reviewed automation.",
      group: "runtime",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    description: "Start one manual run of an active automation.",
    args: z.tuple([z.string()]),
    returns: missionRunRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" },
    agentFacing: true,
  },
  pause: lifecycleMethod("Pause", "pause", "missions.pause"),
  resume: lifecycleMethod("Resume", "resume", "missions.pause"),
  retire: {
    capability: "missions.retire",
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "mission.retire",
      rationale: "Retirement permanently ends the automation identity",
    },
    presentation: {
      title: "Remove an automation",
      action: "remove an automation",
      description: "Allows {requesterKind} to remove an automation.",
      group: "runtime",
      authorityCategory: { domain: "safety", verb: "manage" },
    },
    description: "Retire an automation permanently.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "destructive" },
    agentFacing: true,
  },
  finishRun: {
    capability: "missions.run",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Only the executor recorded on the active run can terminalize it",
    },
    description: "Executor callback that records the terminal turn summary.",
    args: z.tuple([
      z
        .object({
          runId: z.string().min(1),
          outcome: z.enum(["succeeded", "failed"]),
          finalMessage: z.string().optional(),
          error: z.string().optional(),
        })
        .strict(),
    ]),
    returns: z.void(),
    authority: HOST_CODE,
    access: { sensitivity: "write" },
    agentFacing: false,
  },
  proposeAuthorityRevision: {
    capability: "reviewed-closure.propose-revision",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Host records an inert revision proposal after a denied operation",
    },
    description: "Record an inert authority revision proposal.",
    args: z.tuple([
      z
        .object({
          missionId: z.string().min(1),
          capability: z.string().min(1),
          resource: AuthorityResourceScopeSchema,
          tier: z.enum(["gated", "critical"]),
        })
        .strict(),
    ]),
    returns: missionRecordSchema,
    authority: HOST,
    access: { sensitivity: "write" },
    agentFacing: false,
  },
});

function lifecycleMethod(title: string, action: string, capability: string) {
  return {
    capability,
    tier: {
      tier: "gated" as const,
      session: "family" as const,
      residency: "grant-authority" as const,
      family: "mission.control",
      rationale: `${title} changes scheduling state without changing the reviewed closure`,
    },
    presentation: {
      title: `${title} an automation`,
      action: `${action} an automation`,
      description: `Allows {requesterKind} to ${action} an automation.`,
      group: "runtime" as const,
      authorityCategory: { domain: "safety" as const, verb: "manage" as const },
    },
    description: `${title} an automation without changing its reviewed charter.`,
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_SESSION_CODE_HOST,
    access: { sensitivity: "write" as const },
    agentFacing: true,
  };
}
