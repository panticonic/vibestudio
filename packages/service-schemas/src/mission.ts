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
        evalNetwork: z.enum(["none", "declared-origins", "unrestricted"]),
        declaredOrigins: z.array(z.string()),
      })
      .strict(),
    model: z.object({ modelId: z.string().min(1), params: z.record(z.unknown()) }).strict(),
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
  .object({ capability: z.string().min(1), resource: AuthorityResourceScopeSchema })
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
    closureDigest: hex64,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    seeded: z.boolean().optional(),
    standingRestrictions: z.array(missionStandingRestrictionSchema).optional(),
  })
  .strict();

const USER_HOST: ServiceAuthorityPolicy = { principals: ["user", "host"] };
const HOST: ServiceAuthorityPolicy = { principals: ["host"] };

export const missionMethods = defineServiceMethods({
  list: {
    description: "List durable automation charters and their approval state.",
    args: z.tuple([]),
    returns: z.array(missionRecordSchema),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  get: {
    description: "Read one durable automation charter.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema.nullable(),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  createDraft: {
    description: "Create an inert mission draft; this grants and schedules nothing.",
    args: z.tuple([z.object({ name: z.string().min(1), charter: missionCharterSchema }).strict()]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "write" },
  },
  edit: {
    description: "Edit a mission; charter changes lapse its active authority.",
    args: z.tuple([
      z.string(),
      z
        .object({ name: z.string().min(1).optional(), charter: missionCharterSchema.optional() })
        .strict(),
    ]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "write" },
  },
  approve: {
    description: "Approve the exact current mission closure and its exposed permission rows.",
    args: z.tuple([
      z.string(),
      z.array(missionPermissionSchema),
      z.array(missionStandingRestrictionSchema).optional(),
    ]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "admin" },
  },
  pause: {
    description: "Pause an active mission without changing its charter.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "write" },
  },
  resume: {
    description: "Resume a paused mission only if its approved closure still matches.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "write" },
  },
  retire: {
    description: "Retire a mission permanently and revoke its standing allows.",
    args: z.tuple([z.string()]),
    returns: missionRecordSchema,
    authority: USER_HOST,
    access: { sensitivity: "destructive" },
  },
  startSession: {
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
    description: "Host-only lifecycle close for a mission session and run.",
    args: z.tuple([
      z.object({ sessionId: z.string(), runId: z.string(), outcome: z.string() }).strict(),
    ]),
    returns: z.void(),
    authority: HOST,
    access: { sensitivity: "write" },
  },
});
