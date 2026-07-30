import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { AuthorityResourceScopeSchema } from "./build.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const bindingSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    providerEv: z.string().min(1),
    upgradePolicy: z.enum(["pinned", "follow-head"]),
  })
  .strict();
export const compiledExecutionExposureSchema = z
  .object({
    serviceMethods: z.array(z.string().min(1)),
    userlandServices: z.discriminatedUnion("discovery", [
      z.object({ discovery: z.literal("live-declarations"), bindings: z.tuple([]) }).strict(),
      z.object({ discovery: z.literal("bound"), bindings: z.array(bindingSchema) }).strict(),
    ]),
    network: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }).strict(),
      z.object({ mode: z.literal("unrestricted") }).strict(),
      z
        .object({ mode: z.literal("declared-origins"), origins: z.array(z.string().url()) })
        .strict(),
    ]),
  })
  .strict();
export const reviewedClosureBodySchema = z
  .object({
    subjectPrefix: z.string().min(1),
    exposure: compiledExecutionExposureSchema,
    harness: z.object({ unit: z.string().min(1), ev: hex64 }).strict(),
    grants: z.array(
      z
        .object({
          effect: z.enum(["allow", "deny"]),
          capability: z.string().min(1),
          resource: AuthorityResourceScopeSchema,
          tier: z.enum(["gated", "critical"]),
        })
        .strict()
    ),
    grantDependencies: z.array(
      z
        .object({
          subject: z.string().min(1),
          capability: z.string().min(1),
          resource: AuthorityResourceScopeSchema,
        })
        .strict()
    ),
    lineageClasses: z.array(z.string().min(1)),
    owner: z.string().min(1),
    issuer: z.string().min(1),
    sourceDocument: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        revision: z.number().int().positive(),
        digest: hex64,
      })
      .strict(),
  })
  .strict();
export const reviewedClosureRecordSchema = reviewedClosureBodySchema.extend({
  closureDigest: hex64,
  state: z.enum(["active", "suspended", "retired"]),
  activatedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const reviewedClosureActivationSchema = z
  .object({
    body: reviewedClosureBodySchema,
    closureDigest: hex64,
    presentation: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
        summary: z.string().min(1),
        detail: z.string().optional(),
        facts: z.array(z.object({ label: z.string(), value: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict();

const ACTIVATE = "reviewed-closure.activate";

export const reviewedClosureMethods = defineServiceMethods({
  activate: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale:
        "Kernel verifies and activates an exact compiled authority closure and atomically mints its standing grants.",
    },
    description: "Activate one digest-bound reviewed execution closure.",
    args: z.tuple([reviewedClosureActivationSchema]),
    returns: reviewedClosureRecordSchema,
    authority: {
      principals: ["code"],
      requirement: requirementForPrincipals(["code"], ACTIVATE),
      resource: { kind: "argument", index: 0, path: ["closureDigest"], prefix: "closure:" },
      prepared: {
        resolver: "reviewedClosure.activate.presentation",
        leaves: [
          {
            capability: ACTIVATE,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], ACTIVATE)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: { sensitivity: "admin" },
  },
  suspend: {
    capability: "reviewed-closure.suspend",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale: "Kernel suspension closes session admission and revokes standing allows.",
    },
    presentation: {
      title: "Pause reviewed automation",
      action: "pause reviewed automation",
      description: "Allows {requesterKind} to pause reviewed automation.",
      group: "runtime",
      authorityCategory: { domain: "safety", verb: "manage" },
    },
    description: "Suspend one active closure.",
    args: z.tuple([z.string().min(1)]),
    returns: reviewedClosureRecordSchema,
    authority: { principals: ["host", "code"] },
    access: { sensitivity: "write" },
  },
  retire: {
    capability: "reviewed-closure.retire",
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale: "Kernel retirement permanently revokes the closure and its standing grants.",
    },
    presentation: {
      title: "Retire reviewed automation",
      action: "retire reviewed automation",
      description: "Allows {requesterKind} to retire reviewed automation.",
      group: "runtime",
      authorityCategory: { domain: "safety", verb: "manage" },
    },
    description: "Permanently retire one closure.",
    args: z.tuple([z.string().min(1)]),
    returns: reviewedClosureRecordSchema,
    authority: { principals: ["host", "code"] },
    access: { sensitivity: "destructive" },
  },
  bindSession: {
    capability: "reviewed-closure.bind-session",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "reviewedClosure.session",
      rationale:
        "Kernel binds an execution session to one active digest-bound closure for hot-path enforcement.",
    },
    description: "Bind a session to one active reviewed closure.",
    args: z.tuple([
      z
        .object({
          subject: z.string().min(1),
          closureDigest: hex64,
          sessionId: z.string().min(1),
          taskRef: z.string().min(1),
        })
        .strict(),
    ]),
    returns: z.object({ subject: z.string(), closureDigest: hex64, harness: z.object({ unit: z.string(), ev: hex64 }) }),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  finishSession: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "reviewedClosure.session",
      rationale: "Kernel closes the exact reviewed-closure session binding.",
    },
    description: "Finish one active reviewed-closure session.",
    args: z.tuple([z.object({ sessionId: z.string().min(1) }).strict()]),
    returns: z.void(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
});
