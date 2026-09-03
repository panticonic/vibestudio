import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import type { AuthorityRow } from "@vibestudio/shared/authority/authorityRows";
import { AUTHORITY_DOMAINS, AUTHORITY_VERBS } from "@vibestudio/shared/authority/authorityDomains";
import { AUTHORITY_ACQUISITION_DECISIONS } from "@vibestudio/shared/approvalContract";
import { AUTHORITY_PROMPT_CARD_TYPES } from "@vibestudio/shared/authority/promptRegistry";

/** Shared authority wire primitives live with the authority service schema so
 * consumers do not create an initialization cycle between build and approval. */
export const AuthorityResourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), key: z.string() }).strict(),
  z.object({ kind: z.literal("prefix"), prefix: z.string() }).strict(),
  z.object({ kind: z.literal("origin"), origin: z.string() }).strict(),
  z.object({ kind: z.literal("domain"), domain: z.string() }).strict(),
  z.object({ kind: z.literal("network"), value: z.literal("*") }).strict(),
]);

export const authorityRowSchema = z
  .object({
    capability: z.string(),
    domain: z.enum(
      Object.keys(AUTHORITY_DOMAINS) as [
        keyof typeof AUTHORITY_DOMAINS,
        ...(keyof typeof AUTHORITY_DOMAINS)[],
      ]
    ),
    verb: z.enum(
      Object.keys(AUTHORITY_VERBS) as [
        keyof typeof AUTHORITY_VERBS,
        ...(keyof typeof AUTHORITY_VERBS)[],
      ]
    ),
    action: z.string(),
    resource: z.string(),
    resourceScope: AuthorityResourceScopeSchema,
    tier: z.enum(["gated", "critical"]),
    statement: z.enum(["declared", "allowed", "snapshot", "prospective"]),
    state: z.enum(["active", "suspended", "locked"]).optional(),
    provenance: z
      .object({
        source: z.enum(["manifest", "approval", "profile", "mission", "receiver"]),
        decidedAt: z.number().optional(),
        decidedBy: z.string().optional(),
        surface: z.string().optional(),
        lineageClasses: z.array(z.string()).readonly().optional(),
      })
      .strict(),
    // A degraded row for a capability with no reviewed presentation. It has to
    // cross the wire: the surfaces that render it are the ones that must show
    // it as unknown rather than quietly drop it.
    unrecognized: z.literal(true).optional(),
    flags: z
      .object({
        lineageTainted: z.boolean().optional(),
        irreversible: z.boolean().optional(),
        newInDiff: z.boolean().optional(),
        removedInDiff: z.boolean().optional(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<AuthorityRow>;

const EVERY_ORIGIN: ServiceAuthorityPolicy = {
  principals: ["host", "user", "code", "session", "mission"],
};

const leafSchema = z
  .object({
    capability: z.string(),
    resourceKey: z.string(),
    status: z.enum(["granted", "consumable-once", "acquirable", "denied"]),
    tier: z.enum(["open", "gated", "critical"]),
    failure: z
      .object({
        reasonCode: z.enum([
          "approval-required",
          "user-denied",
          "receiver-rejected",
          "fixed-code-not-requested",
          "invalid-session",
          "invalid-attestation",
          "receiver-undeclared",
          "attestation-required",
          "attestation-invalid",
          "eval-read-only",
        ]),
        reason: z.string(),
        capability: z.string().optional(),
        resourceKey: z.string().optional(),
        remediation: z
          .object({
            kind: z.enum([
              "request-user-approval",
              "update-installed-code-manifest",
              "declare-rpc-receiver",
              "use-admitted-principal",
              "satisfy-relationship",
              "refresh-session",
              "respect-denial",
              "use-writable-session",
              "retry-through-host",
            ]),
            message: z.string(),
            request: z
              .object({
                capability: z.string(),
                resource: z.object({ kind: z.literal("exact"), key: z.string() }).strict(),
                tier: z.enum(["gated", "critical"]),
              })
              .strict()
              .optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const authorityMethods = defineServiceMethods({
  listTaskRules: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "An authenticated workspace member may inspect the rules attached to a visible chat.",
    },
    description: "List the active reusable rules for one chat-bound agent task.",
    args: z.tuple([
      z.object({ contextId: z.string().min(1), channelId: z.string().min(1) }).strict(),
    ]),
    returns: z.array(
      z
        .object({
          id: z.string().min(1),
          capability: z.string().min(1),
          action: z.string().min(1),
          resource: z.string().min(1),
          decidedAt: z.number(),
        })
        .strict()
    ),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "read" },
  },
  resetTaskRules: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale: "Reset only removes authority attached to the named visible chat.",
    },
    description: "Revoke every reusable rule attached to one chat-bound agent task.",
    args: z.tuple([
      z.object({ contextId: z.string().min(1), channelId: z.string().min(1) }).strict(),
    ]),
    returns: z.object({ revokedGrantCount: z.number().int().nonnegative() }).strict(),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "write" },
  },
  awaitDecision: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "An acquisition owner may wait on its existing human-decision lifecycle; the wait grants nothing",
    },
    description: "Wait without a deadline for one acquisition owned by this session.",
    args: z.tuple([z.object({ acquisitionId: z.string().min(1) }).strict()]),
    returns: z
      .object({
        state: z.enum(["decided", "closed"]),
        decision: z.enum(AUTHORITY_ACQUISITION_DECISIONS).optional(),
      })
      .strict(),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "read" },
  },
  preflight: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "Pure authority inspection; it neither prompts, mints, consumes, nor invokes a handler",
    },
    description:
      "Dry-run a service method's complete authority contract without prompting or consuming authority.",
    args: z.tuple([
      z
        .object({
          service: z.string().min(1),
          method: z.string().min(1),
          args: z.array(z.unknown()),
        })
        .strict(),
    ]),
    returns: z
      .object({
        decision: z.enum(["allowed", "acquirable", "denied"]),
        leaves: z.array(leafSchema),
        severityPreview: z.enum(["routine", "sensitive", "critical"]).optional(),
        wouldPrompt: z
          .object({
            cardType: z.enum(AUTHORITY_PROMPT_CARD_TYPES),
            renderedAction: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "read" },
  },
  compileAuthorityPlan: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.compile",
      rationale:
        "Installed code asks the host to compile receiver-owned declarations; it cannot author capability rows.",
    },
    description: "Compile and publish one immutable content-addressed authority plan.",
    args: z.tuple([
      z
        .object({
          executionImageDigest: z.string().regex(/^[0-9a-f]{64}$/u),
          operations: z
            .array(
              z
                .object({
                  service: z.string().min(1),
                  method: z.string().min(1),
                  args: z.array(z.unknown()).optional(),
                  use: z.enum(["action", "conditional"]),
                })
                .strict()
            )
            .max(256),
        })
        .strict(),
    ]),
    returns: z
      .object({
        schemaVersion: z.literal(1),
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
        artifactRef: z.string().regex(/^authority-plan:[0-9a-f]{64}$/u),
        compilerVersion: z.string(),
        catalogDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  acquireForTarget: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.acquire",
      rationale:
        "Installed workflow code requests ordinary approval for an immutable host policy and attributed target principal.",
    },
    description:
      "Create or join durable authority requests for a target subject and immutable policy.",
    args: z.tuple([
      z
        .object({
          targetSubject: z.string().regex(/^mission:[^@]+@[0-9a-f]{64}$/u),
          authorityPlanDigest: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .strict(),
    ]),
    returns: z
      .object({
        requestIds: z.array(z.string()),
        grantIds: z.array(z.string()),
        denialIds: z.array(z.string()),
      })
      .strict(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  acquireForCurrentTask: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.acquire",
      rationale:
        "Installed agent code may pre-acquire predictable operations only for its host-attested current task authority.",
    },
    description:
      "Create or join durable pre-acquisition requests for the authenticated caller's current task.",
    args: z.tuple([
      z
        .object({
          authorityPlanDigest: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .strict(),
    ]),
    returns: z
      .object({
        requestIds: z.array(z.string()),
        grantIds: z.array(z.string()),
        denialIds: z.array(z.string()),
      })
      .strict(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  admitExecution: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.execution",
      rationale:
        "Installed workflow code asks the host to bind one authenticated executor to a registered authority subject.",
    },
    description: "Admit one exact mission executor and return its opaque call-binding nonce.",
    args: z.tuple([
      z
        .object({
          admissionKey: z.string().min(1),
          contextId: z.string().min(1),
          taskRef: z.string().min(1),
          mission: z
            .object({
              subject: z.string().regex(/^mission:[^@]+@[0-9a-f]{64}$/u),
              missionId: z.string().min(1),
              revision: z.number().int().positive(),
              revisionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
            })
            .strict(),
          executionImage: z
            .object({
              source: z.string().min(1),
              ref: z.string().regex(/^state:[0-9a-f]{64}$/u),
              effectiveVersion: z.string().regex(/^[0-9a-f]{64}$/u),
              className: z.string().min(1),
            })
            .strict(),
          authorityPlanDigest: z.string().regex(/^[0-9a-f]{64}$/u),
          executor: z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("agent-turn"),
                runtimeId: z.string().min(1),
                entityId: z.string().min(1),
                channelId: z.string().min(1),
                turnId: z.string().min(1),
              })
              .strict(),
            z
              .object({
                kind: z.literal("method"),
                runtimeId: z.string().min(1),
                invocationId: z.string().min(1),
                service: z.string().min(1),
                method: z.string().min(1),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
    returns: z.object({ authoritySessionId: z.string(), nonce: z.string() }).strict(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  finishExecution: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.execution",
      rationale: "The workflow owner closes the exact execution admission it created.",
    },
    description: "Terminalize one execution admission.",
    args: z.tuple([z.object({ authoritySessionId: z.string().min(1) }).strict()]),
    returns: z.void(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
  retireTarget: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "authority.execution",
      rationale:
        "Installed workflow code retires an owner-attributed target only after its admitted executions have closed.",
    },
    description:
      "Fence a retired target subject, cancel pending requests, and revoke its standing grants.",
    args: z.tuple([
      z.object({ targetSubject: z.string().regex(/^mission:[^@]+@[0-9a-f]{64}$/u) }).strict(),
    ]),
    returns: z
      .object({
        cancelledRequestCount: z.number().int().nonnegative(),
        revokedGrantCount: z.number().int().nonnegative(),
      })
      .strict(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
});
