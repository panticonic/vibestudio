import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { AuthorityResourceScopeSchema } from "./build.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const eventField = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  .refine(
    (value) => value !== "__proto__" && value !== "prototype" && value !== "constructor",
    "reserved event field"
  );
const missionEventFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("field-equals"),
      path: z.array(eventField).nonempty(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
]);

export const missionCharterSchema = z
  .object({
    agentBindingId: z.string().min(1),
    taskSpec: z.string().min(1),
    harness: z.object({ unit: z.string().min(1), ev: hex64 }).strict(),
    skills: z.array(z.object({ path: z.string().min(1), contentHash: hex64 }).strict()),
    toolExposure: z
      .object({
        services: z.array(z.string().min(1)),
        userlandServices: z.array(
          z
            .object({
              name: z.string().min(1),
              provider: z.string().min(1),
              providerEv: z.string().min(1),
              upgradePolicy: z.enum(["pinned", "follow-head"]),
            })
            .strict()
        ),
        workspaceServiceDiscovery: z.enum(["bound", "live-declarations"]),
        evalNetwork: z.enum(["none", "declared-origins", "unrestricted"]),
        declaredOrigins: z.array(z.string()),
      })
      .strict(),
    model: z.object({ modelId: z.string().min(1), params: z.record(z.unknown()) }).strict(),
    declaredLineageClasses: z
      .array(z.enum(["none", "web", "email", "channel-external", "external"]))
      .min(1),
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z.object({ kind: z.literal("cron"), cron: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal("event"),
          event: z
            .object({
              source: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
              filter: missionEventFilterSchema,
            })
            .strict(),
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
    seeded: z.boolean().optional(),
    permissions: z.array(missionPermissionSchema),
    standingRestrictions: z.array(missionStandingRestrictionSchema),
  })
  .strict();

export const missionRunRecordSchema = z
  .object({
    runId: z.string().min(1),
    missionId: z.string().min(1),
    closureDigest: hex64,
    sessionId: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    outcome: z.string().optional(),
  })
  .strict();

// Workspace UI is code-origin. The method tier table marks these methods
// `codeOnly`, which admits trusted workspace panels while excluding eval/agent
// execution sessions. Gated mission mutations still require their mapped
// semantic capability.
const USER_CODE_HOST: ServiceAuthorityPolicy = { principals: ["user", "code", "host"] };
const HOST: ServiceAuthorityPolicy = { principals: ["host"] };

export const missionsMethods = defineServiceMethods({
  list: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "identity",
      family: "mission.read",
      rationale:
        "Human governance read; mission sessions cannot inspect or rewrite their own charter",
    },
    description: "List durable automation charters and their approval state.",
    args: z.tuple([]),
    returns: z.array(missionRecordSchema),
    authority: USER_CODE_HOST,
    access: { sensitivity: "read" },
  },
  get: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "identity",
      family: "mission.read",
      rationale:
        "Human governance read; mission sessions cannot inspect or rewrite their own charter",
    },
    description: "Read one durable automation charter.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema.nullable(),
    authority: USER_CODE_HOST,
    access: { sensitivity: "read" },
  },
  listRuns: {
    capability: "missions.read",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "identity",
      family: "mission.read",
      rationale: "Human governance read of the durable mission run timeline",
    },
    description: "List the durable run timeline for one visible mission.",
    args: z.tuple([z.string()]),
    returns: z.array(missionRunRecordSchema),
    authority: USER_CODE_HOST,
    access: { sensitivity: "read" },
  },
  createDraft: {
    capability: "missions.edit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "identity",
      family: "mission.create",
      rationale: "Mission authoring is a human governance surface; drafts remain inert",
    },
    presentation: {
      title: "Create an automation draft",
      action: "create an automation draft",
      description: "Allows {requesterKind} to create an automation draft.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Create an inert mission draft; this grants and schedules nothing.",
    args: z.tuple([
      z
        .object({
          name: z.string().min(1),
          charter: missionCharterSchema,
          permissions: z.array(missionPermissionSchema),
          standingRestrictions: z.array(missionStandingRestrictionSchema).optional(),
        })
        .strict(),
    ]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "write" },
  },
  edit: {
    capability: "missions.edit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "identity",
      family: "mission.mutate",
      rationale:
        "Mission charter edits lapse authority and are restricted to the governance surface",
    },
    presentation: {
      title: "Change an automation",
      action: "change an automation",
      description: "Allows {requesterKind} to change an automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Edit a mission; charter changes lapse its active authority.",
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
    authority: USER_CODE_HOST,
    access: { sensitivity: "write" },
  },
  requestReview: {
    capability: "missions.review",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale:
        "Opening an inert draft in the canonical review queue grants nothing; only that queue can ratify it",
    },
    description: "Open the canonical approval-queue review for an inert mission closure.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "admin" },
  },
  pause: {
    capability: "missions.pause",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Pausing automation is a human governance action",
    },
    presentation: {
      title: "Pause an automation",
      action: "pause an automation",
      description: "Allows {requesterKind} to pause an automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Pause an active mission without changing its charter.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "write" },
  },
  resume: {
    capability: "missions.pause",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Resuming automation is a human governance action",
    },
    presentation: {
      title: "Resume an automation",
      action: "resume an automation",
      description: "Allows {requesterKind} to resume an automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Resume a paused mission only if its approved closure still matches.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "write" },
  },
  retire: {
    capability: "missions.retire",
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.retire",
      rationale: "Retirement permanently ends the mission identity and revokes standing allows",
    },
    presentation: {
      title: "Remove an automation",
      action: "remove an automation",
      description: "Allows {requesterKind} to remove an automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Retire a mission permanently and revoke its standing allows.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_CODE_HOST,
    access: { sensitivity: "destructive" },
  },
  startSession: {
    capability: "missions.run",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.create",
      rationale: "Host-only trigger handoff for an already approved closure",
    },
    presentation: {
      title: "Start an automation run",
      action: "start an automation run",
      description: "Allows {requesterKind} to start an automation run.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Host-only trigger handoff that stamps an active mission onto a new session.",
    args: z.tuple([
      z
        .object({
          missionId: z.string(),
          sessionId: z.string(),
          taskRef: z.string(),
          runId: z.string(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        missionId: z.string(),
        closureDigest: hex64,
        harness: z.object({ unit: z.string(), ev: hex64 }).strict(),
      })
      .strict(),
    authority: HOST,
    access: { sensitivity: "write" },
  },
  finishSession: {
    capability: "missions.run",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale: "Host-only mission lifecycle closure",
    },
    presentation: {
      title: "Finish an automation run",
      action: "finish an automation run",
      description: "Allows {requesterKind} to finish an automation run.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Host-only lifecycle close for a mission session and run.",
    args: z.tuple([
      z.object({ sessionId: z.string(), runId: z.string(), outcome: z.string() }).strict(),
    ]),
    returns: z.void(),
    authority: HOST,
    access: { sensitivity: "write" },
  },
  proposeAuthorityRevision: {
    capability: "reviewed-closure.propose-revision",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "mission.control",
      rationale:
        "Host reports one denied request to the closure's cataloged source-document owner; the proposal itself grants nothing.",
    },
    description:
      "Record an inert source-document revision proposal after a reviewed closure denies an operation.",
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
