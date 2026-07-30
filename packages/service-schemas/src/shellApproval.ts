/**
 * shellApproval service schema — trusted shell/mobile approval resolution and
 * approval queue rehydration.
 */

import { z } from "zod";
import type {
  ApprovalOperationDescriptor,
  ApprovalRequesterIdentity,
  DiffReviewEntry,
  PendingApproval,
  PendingMissionReviewApproval,
  PendingUnitBatchApproval,
  UnitBatchEntry,
} from "@vibestudio/shared/approvals";
import type { AuthorityRequirement, InvocationSnapshot } from "@vibestudio/rpc";
import { APPROVAL_DECISIONS } from "@vibestudio/shared/approvalContract";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/authorityDomains";
import type { AuthorityRowDiff } from "@vibestudio/shared/authority/authorityRowDiff";
import {
  UnitAuthorityRequestSchema,
  UserlandCapabilityDefinitionSchema,
} from "./build.js";
import { authorityRowSchema } from "./authority.js";
export { authorityRowSchema } from "./authority.js";
import { missionCharterSchema } from "./missions.js";

export const shellApprovalValuesSchema = z
  .record(z.string().min(1).max(128), z.string().max(4096))
  .describe(
    "Submitted field values keyed by field name (each key ≤128 chars, each value ≤4096 chars)."
  );

const approvalRequesterSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["panel", "app", "worker", "do", "extension", "system"]),
    category: z.enum([
      "panel",
      "workspace-app",
      "agent",
      "eval",
      "worker",
      "durable-object",
      "extension",
      "system",
      "internal-service",
      "unknown",
    ]),
    title: z.string().optional(),
    panel: z.object({ id: z.string(), title: z.string().optional() }).strict().optional(),
    sourcePath: z.string().optional(),
    repoPath: z.string(),
    effectiveVersion: z.string(),
    contextId: z.string().optional(),
    stableIdentityKey: z.string(),
    ephemeralInstanceKey: z.string(),
    eval: z
      .object({
        ownerId: z.string().optional(),
        subKey: z.string().optional(),
        runId: z.string().optional(),
        channelId: z.string().optional(),
      })
      .strict()
      .optional(),
    breadcrumbs: z.array(
      z
        .object({
          id: z.string(),
          kind: z.enum([
            "panel",
            "app",
            "worker",
            "do",
            "extension",
            "system",
            "session",
            "shell",
            "server",
          ]),
          category: z.enum([
            "panel",
            "workspace-app",
            "agent",
            "eval",
            "worker",
            "durable-object",
            "extension",
            "system",
            "internal-service",
            "unknown",
          ]),
          label: z.string().optional(),
          sourcePath: z.string().optional(),
        })
        .strict()
    ),
  })
  .strict() satisfies z.ZodType<ApprovalRequesterIdentity>;

const approvalOperationSchema = z
  .object({
    kind: z.enum([
      "browser",
      "credential",
      "filesystem",
      "git",
      "inspection",
      "network",
      "panel",
      "runtime",
      "worker-lifecycle",
      "workspace",
      "service-setup",
      "device-code",
      "unknown",
    ]),
    verb: z.string(),
    object: z
      .object({ type: z.string(), label: z.string(), value: z.string() })
      .strict()
      .optional(),
    groupKey: z.string().optional(),
  })
  .strict() satisfies z.ZodType<ApprovalOperationDescriptor>;

const diffReviewSchema = z
  .object({
    repoPath: z.string(),
    oldState: z.string(),
    newState: z.string().nullable(),
    diffStat: z
      .object({
        filesChanged: z.number(),
        insertions: z.number().optional(),
        deletions: z.number().optional(),
      })
      .strict(),
    changedFiles: z.array(
      z
        .object({
          path: z.string(),
          kind: z.enum(["added", "removed", "changed"]),
          oldHash: z.string().optional(),
          newHash: z.string().optional(),
          binary: z.boolean().optional(),
          tooLarge: z.boolean().optional(),
        })
        .strict()
    ),
    truncated: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<DiffReviewEntry>;

const pendingApprovalBaseShape = {
  approvalId: z.string(),
  callerId: z.string(),
  callerKind: z.enum(["panel", "app", "worker", "do", "extension", "system"]),
  repoPath: z.string(),
  effectiveVersion: z.string(),
  requestedAt: z.number(),
  callerTitle: z.string().optional(),
  requester: approvalRequesterSchema.optional(),
  operation: approvalOperationSchema.optional(),
  diffReview: z.array(diffReviewSchema).optional(),
};

export const authorityRowDiffSchema = z
  .object({
    added: z.array(authorityRowSchema),
    removed: z.array(authorityRowSchema),
    unchanged: z.array(authorityRowSchema),
    retiered: z.array(z.object({ before: authorityRowSchema, after: authorityRowSchema }).strict()),
  })
  .strict() satisfies z.ZodType<AuthorityRowDiff>;

const unitBatchEntrySchema = z
  .object({
    unitKind: z.enum(["extension", "app", "panel", "worker", "scheduled-job", "agent-heartbeat"]),
    unitName: z.string(),
    displayName: z.string(),
    version: z.string().nullable().optional(),
    target: z.enum(["electron", "react-native", "terminal"]).nullable().optional(),
    source: z
      .object({ kind: z.literal("workspace-repo"), repo: z.string(), ref: z.string() })
      .strict(),
    ev: z.string().nullable().optional(),
    capabilities: z.array(z.string()),
    authority: z
      .object({
        requests: z.array(UnitAuthorityRequestSchema).readonly(),
        provides: z.array(UserlandCapabilityDefinitionSchema).readonly(),
        previousProvides: z.array(UserlandCapabilityDefinitionSchema).readonly(),
        rows: z.array(authorityRowSchema),
        diff: authorityRowDiffSchema,
      })
      .strict()
      .optional(),
    dependencyEvs: z.record(z.string()).optional(),
    externalDeps: z.record(z.string()).optional(),
    integrity: z.string().nullable().optional(),
    provider: z
      .object({
        name: z.string(),
        activeEv: z.string().nullable(),
        activeBuildKey: z.string().nullable(),
        contractVersion: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
    commit: z
      .object({
        author: z.object({ name: z.string(), email: z.string() }).strict(),
        committer: z.object({ name: z.string(), email: z.string() }).strict(),
        message: z.string(),
        timestamp: z.number(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict() satisfies z.ZodType<UnitBatchEntry>;

export const pendingUnitBatchApprovalSchema = z
  .object({
    ...pendingApprovalBaseShape,
    kind: z.literal("unit-batch"),
    trigger: z.enum(["startup", "meta-change", "source-change", "management"]),
    title: z.string(),
    description: z.string(),
    units: z.array(unitBatchEntrySchema),
    configWrite: z
      .object({ repoPath: z.string(), summary: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict() satisfies z.ZodType<PendingUnitBatchApproval>;

export const pendingMissionReviewApprovalSchema = z
  .object({
    ...pendingApprovalBaseShape,
    kind: z.literal("mission-review"),
    missionId: z.string().min(1),
    revision: z.number().int().positive(),
    closureDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    reviewKind: z.enum(["draft", "revision", "out-of-charter"]),
    title: z.string().min(1),
    taskSummary: z.string().min(1),
    triggerSummary: z.string().min(1),
    authority: z
      .object({
        rows: z.array(authorityRowSchema),
        diff: authorityRowDiffSchema,
      })
      .strict(),
    toolkitDomains: z.array(
      z.enum(
        Object.keys(AUTHORITY_DOMAINS) as [
          keyof typeof AUTHORITY_DOMAINS,
          ...(keyof typeof AUTHORITY_DOMAINS)[],
        ]
      )
    ),
    networkSummary: z.string().min(1),
    lineageSummary: z.string().min(1),
    charter: missionCharterSchema,
    charterChanges: z.array(
      z
        .object({
          field: z.enum(["task", "schedule", "toolkit", "network", "data-flow", "model"]),
          before: z.string().optional(),
          after: z.string(),
          widening: z.boolean(),
        })
        .strict()
    ),
    blockedAt: z.number().optional(),
  })
  .strict() satisfies z.ZodType<PendingMissionReviewApproval>;

const audienceSchema = z
  .object({ url: z.string(), match: z.enum(["origin", "path-prefix", "exact"]) })
  .strict();
const credentialInjectionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("header"),
      name: z.string(),
      valueTemplate: z.string(),
      stripIncoming: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("query-param"), name: z.string() }).strict(),
  z
    .object({
      type: z.literal("basic-auth"),
      usernameTemplate: z.string(),
      passwordTemplate: z.string(),
      stripIncoming: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("oauth1-signature") }).strict(),
  z.object({ type: z.literal("cookie") }).strict(),
  z.object({ type: z.literal("aws-sigv4"), service: z.string(), region: z.string() }).strict(),
  z.object({ type: z.literal("ssh-key") }).strict(),
]);
const accountIdentitySchema = z
  .object({
    email: z.string().optional(),
    username: z.string().optional(),
    workspaceName: z.string().optional(),
    providerUserId: z.string(),
  })
  .strict();
const approvalDetailSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    format: z.enum(["plain", "markdown", "code", "tree"]).optional(),
  })
  .strict();
const authorityRequirementSchema: z.ZodType<AuthorityRequirement> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("capability"),
        principal: z.enum(["host", "user", "code", "session", "mission"]),
        capability: z.string(),
        codeOnly: z.literal(true).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("relationship"),
        name: z.enum([
          "workspace-member",
          "workspace-role",
          "entity-self",
          "entity-owner",
          "agent-binding",
          "code-source",
          "context-integrity",
          "closure-internal",
        ]),
        value: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("session"),
        audience: z.string().optional(),
        minVersion: z.string().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("all"), requirements: z.array(authorityRequirementSchema) })
      .strict(),
    z
      .object({ kind: z.literal("any"), requirements: z.array(authorityRequirementSchema) })
      .strict(),
  ])
);
export const invocationSnapshotSchema = z
  .object({
    v: z.literal(2),
    service: z.string(),
    method: z.string(),
    capability: z.string(),
    capabilityDefinitionDigest: z.string(),
    resourceType: z.string(),
    provider: z.string(),
    providerExecutionDigest: z.string(),
    targetRequirement: authorityRequirementSchema.optional(),
    targetCapability: z.string().optional(),
    resourceKey: z.string(),
    argsDigest: z.string(),
    preparedStateDigest: z.string(),
    callerPrincipal: z.string() as z.ZodType<InvocationSnapshot["callerPrincipal"]>,
    sessionId: z.string(),
    taskRef: z.string().optional(),
    agentBindingId: z.string().optional(),
    agentName: z.string().optional(),
    lineageClasses: z.array(z.string()).readonly().optional(),
    irreversible: z.boolean().optional(),
    agentScopeEligible: z.boolean().optional(),
    reviewedClosureSubject: z.string() as z.ZodType<
      InvocationSnapshot["reviewedClosureSubject"]
    >,
    snippetDigest: z.string(),
    codeLineage: z
      .object({
        class: z.enum(["internal", "external", "unknown"]),
        chain: z.array(z.string()).readonly(),
      })
      .strict(),
    contextLineage: z
      .object({
        class: z.enum(["internal", "external", "not-applicable"]),
        latchEpoch: z.number(),
        externalKeys: z.array(z.string()).readonly(),
      })
      .strict()
      .nullable(),
    initiatorChain: z.array(z.string()).readonly(),
    executionMode: z.enum(["interactive", "mission", "test"]).optional(),
    testPolicyId: z.string().optional(),
    at: z.number(),
  })
  .strict() satisfies z.ZodType<InvocationSnapshot>;
const approvalInputFieldSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.enum(["text", "secret"]),
    required: z.boolean(),
    description: z.string().optional(),
  })
  .strict();

export const pendingApprovalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("credential"),
      allowedDecisions: z.array(z.enum(["once", "session", "agent", "version", "deny"])),
      credentialId: z.string(),
      credentialLabel: z.string(),
      audience: z.array(audienceSchema),
      injection: credentialInjectionSchema,
      accountIdentity: accountIdentitySchema,
      scopes: z.array(z.string()),
      credentialUse: z.enum(["fetch", "git-http", "git-ssh"]).optional(),
      bindingLabel: z.string().optional(),
      gitOperation: z
        .object({
          action: z.enum(["read", "write"]),
          label: z.string(),
          remote: z.string(),
          service: z.string().optional(),
          force: z.boolean().optional(),
          overwrites: z
            .discriminatedUnion("relationship", [
              z
                .object({
                  relationship: z.literal("related"),
                  count: z.number().int().nonnegative(),
                  commits: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
                  truncated: z.boolean(),
                })
                .strict(),
              z
                .object({
                  relationship: z.literal("unrelated"),
                  count: z.null(),
                  commits: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
                  truncated: z.boolean(),
                })
                .strict(),
            ])
            .optional(),
        })
        .strict()
        .optional(),
      grantResource: z
        .object({
          bindingId: z.string(),
          resource: z.string(),
          action: z.enum(["read", "write", "use"]),
        })
        .strict()
        .optional(),
      oauthAuthorizeOrigin: z.string().optional(),
      oauthTokenOrigin: z.string().optional(),
      oauthUserinfoOrigin: z.string().optional(),
      oauthAudienceDomainMismatch: z.boolean().optional(),
      replacementCredentialLabel: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("capability"),
      capability: z.string(),
      severity: z.enum(["standard", "severe"]).optional(),
      grantResourceKey: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      resource: z
        .object({ type: z.string(), label: z.string(), value: z.string() })
        .strict()
        .optional(),
      resourceScope: z
        .union([
          z
            .object({ kind: z.literal("exact"), key: z.string(), label: z.string().optional() })
            .strict(),
          z.object({ kind: z.literal("origin"), origin: z.string() }).strict(),
          z.object({ kind: z.literal("domain"), domain: z.string() }).strict(),
          z.object({ kind: z.literal("network"), value: z.literal("*") }).strict(),
        ])
        .optional(),
      details: z.array(approvalDetailSchema).optional(),
      snapshot: invocationSnapshotSchema.optional(),
      cardType: z.enum(["permission.gated", "permission.outside", "confirm.critical"]).optional(),
      allowedDecisions: z.array(z.enum(APPROVAL_DECISIONS)).optional(),
      authorityRow: authorityRowSchema.optional(),
      operationSubstance: z
        .object({
          kind: z.enum(["change-set", "send", "deletion", "custom"]),
          summary: z.string(),
          detail: z.string().optional(),
          facts: z
            .array(
              z
                .object({
                  label: z.string(),
                  value: z.string(),
                })
                .strict()
            )
            .optional(),
          digest: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("browser-permission"),
      ownerUserId: z.string(),
      workspaceId: z.string(),
      environmentKey: z.string(),
      panelId: z.string(),
      origin: z.string().url(),
      topLevelUrl: z.string().url(),
      capabilities: z.array(z.enum(["camera", "microphone", "geolocation", "notifications"])),
      deviceLabel: z.string(),
    })
    .strict(),
  pendingUnitBatchApprovalSchema,
  pendingMissionReviewApprovalSchema,
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("client-config"),
      configId: z.string(),
      authorizeUrl: z.string(),
      tokenUrl: z.string(),
      title: z.string(),
      description: z.string().optional(),
      fields: z.array(approvalInputFieldSchema),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("credential-input"),
      title: z.string(),
      description: z.string().optional(),
      credentialLabel: z.string(),
      audience: z.array(audienceSchema),
      injection: credentialInjectionSchema,
      accountIdentity: accountIdentitySchema,
      scopes: z.array(z.string()),
      fields: z.array(approvalInputFieldSchema),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("secret-input"),
      title: z.string(),
      description: z.string().optional(),
      warning: z.string().optional(),
      details: z.array(approvalDetailSchema).optional(),
      fields: z.array(approvalInputFieldSchema),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("device-code"),
      credentialLabel: z.string(),
      userCode: z.string(),
      verificationUri: z.string(),
      verificationUriComplete: z.string().optional(),
      expiresAt: z.number(),
      oauthTokenOrigin: z.string(),
    })
    .strict(),
]) satisfies z.ZodType<PendingApproval>;

// Access descriptors shared across the shellApproval methods. Each call records
// a human's decision on a pending approval (resolving the queued request), so
// the resolution paths are writes; `listPending` is a pure read used to
// rehydrate the renderer's approval bar on mount. The service-level `policy`
// (shell/app/server) is the enforced caller gate; `access` carries sensitivity.
const RESOLVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const LIST_PENDING_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const shellApprovalMethods = defineServiceMethods({
  resolve: {
    capability: "approvals.decide",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Respond to a workspace request",
      action: "respond to a workspace request",
      description: "Allows {requesterKind} to respond to a workspace request.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Record the user's decision (once/session/version/deny/dismiss) on a pending approval, resolving its queued request.",
    args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "once"] }],
  },
  resolveMissionReview: {
    capability: "approvals.decide",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale: "G5: trusted approval plumbing resolving an exact queued mission closure",
    },
    presentation: {
      title: "Respond to an automation plan",
      action: "respond to an automation plan",
      description: "Allows {requesterKind} to respond to a queued automation plan.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Approve an exact pending mission closure with the selected new authority rows, or leave it unapproved.",
    args: z.tuple([
      z.string(),
      z.discriminatedUnion("decision", [
        z
          .object({
            decision: z.literal("approve"),
            selectedAuthorityKeys: z.array(z.string().min(1)),
          })
          .strict(),
        z.object({ decision: z.literal("dismiss") }).strict(),
      ]),
    ]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { decision: "dismiss" }] }],
  },
  resolveBootstrap: {
    capability: "approvals.decide",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Approve initial workspace access",
      action: "approve initial workspace access",
      description: "Allows {requesterKind} to approve initial workspace access.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval.",
    args: z.tuple([z.string(), z.enum(["once", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "deny"] }],
  },
  submitClientConfig: {
    capability: "protected-input.submit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Submit account-provider settings",
      action: "submit account-provider settings",
      description: "Allows {requesterKind} to submit account-provider settings.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
    description:
      "Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { clientId: "abc", clientSecret: "shh" }] }],
  },
  submitCredentialInput: {
    capability: "protected-input.submit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Submit account details",
      action: "submit account details",
      description: "Allows {requesterKind} to submit account details.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
    description:
      "Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { token: "secret-value" }] }],
  },
  submitSecretInput: {
    capability: "protected-input.submit",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Submit a protected value",
      action: "submit a protected value",
      description: "Allows {requesterKind} to submit a protected value.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
    description:
      "Submit the user-entered secret field values for a pending secret-input approval, fulfilling its feedback-form request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { value: "secret-value" }] }],
  },
  listPending: {
    capability: "approvals.read",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "View requests awaiting your decision",
      action: "view requests awaiting your decision",
      description: "Allows {requesterKind} to view requests awaiting your decision.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount.",
    args: z.tuple([]),
    returns: z.array(pendingApprovalSchema),
    access: LIST_PENDING_ACCESS,
  },
});
