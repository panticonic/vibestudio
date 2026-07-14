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
  PendingUnitBatchApproval,
  UnitBatchEntry,
} from "@vibestudio/shared/approvals";
import { APPROVAL_DECISIONS } from "@vibestudio/shared/approvalContract";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

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
    executionDigest: z.string(),
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
      "userland",
      "external-agent",
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
  executionDigest: z.string(),
  requestedAt: z.number(),
  callerTitle: z.string().optional(),
  requester: approvalRequesterSchema.optional(),
  operation: approvalOperationSchema.optional(),
  diffReview: z.array(diffReviewSchema).optional(),
};

const unitBatchEntrySchema = z
  .object({
    unitKind: z.enum(["extension", "app", "scheduled-job", "agent-heartbeat"]),
    unitName: z.string(),
    displayName: z.string(),
    version: z.string().nullable().optional(),
    target: z.enum(["electron", "react-native", "terminal"]).nullable().optional(),
    source: z
      .object({ kind: z.literal("workspace-repo"), repo: z.string(), ref: z.string() })
      .strict(),
    sourceDigest: z.string().nullable().optional(),
    capabilities: z.array(z.string()),
    dependencySourceDigests: z.record(z.string()).optional(),
    externalDeps: z.record(z.string()).optional(),
    integrity: z.string().nullable().optional(),
    provider: z
      .object({
        name: z.string(),
        activeSourceDigest: z.string().nullable(),
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
    format: z.enum(["plain", "markdown", "code"]).optional(),
  })
  .strict();
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
            .object({
              count: z.number(),
              commits: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
            })
            .strict()
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
    })
    .strict(),
  pendingUnitBatchApprovalSchema,
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
      kind: z.literal("userland"),
      issuer: z
        .object({
          kind: z.enum(["panel", "app", "worker", "do", "extension"]),
          id: z.string(),
          label: z.string().optional(),
        })
        .strict()
        .optional(),
      subject: z.object({ id: z.string(), label: z.string().optional() }).strict(),
      title: z.string(),
      summary: z.string().optional(),
      warning: z.string().optional(),
      details: z.array(approvalDetailSchema).optional(),
      positiveEvidence: z.array(approvalDetailSchema).optional(),
      severity: z.enum(["standard", "dangerous"]).optional(),
      defaultAction: z.enum(["allow", "deny"]).optional(),
      promptOptions: z.enum(["scoped", "choices"]),
      options: z.array(
        z
          .object({
            value: z.string(),
            label: z.string(),
            description: z.string().optional(),
            tone: z.enum(["primary", "danger", "neutral"]).optional(),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ...pendingApprovalBaseShape,
      kind: z.literal("external-agent"),
      entityId: z.string(),
      channelId: z.string(),
      capability: z.string(),
      operationName: z.string(),
      description: z.string().optional(),
      preview: z.string().optional(),
      requestId: z.string(),
      resolveToken: z.string(),
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
    description:
      "Record the user's decision (once/session/version/deny/dismiss) on a pending approval, resolving its queued request.",
    args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "once"] }],
  },
  blockCapability: {
    description:
      "Deny a pending capability request and remember that denial for this exact code version until revoked.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
  },
  resolveBootstrap: {
    description:
      "Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval.",
    args: z.tuple([z.string(), z.enum(["once", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "deny"] }],
  },
  resolveUserland: {
    description:
      "Resolve a pending userland approval by selecting one of the presented option values (or 'dismiss'); rejects if the choice was not offered to the user.",
    args: z.tuple([z.string(), z.union([z.string().min(1).max(40), z.literal("dismiss")])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "dismiss"] }],
  },
  resolveExternalAgent: {
    description:
      "Record the user's allow/deny verdict on a pending external-agent tool-use approval, resolving the relayed permission request.",
    args: z.tuple([z.string(), z.enum(["allow", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "allow"] }],
  },
  resolveExternalAgentByRequest: {
    description:
      "Record the user's allow/deny verdict on a pending external-agent approval matched by (channelId, requestId, resolveToken) rather than approvalId — the inline conversation card knows the requestId and opaque resolve token, not the internal approvalId. Records a real verdict (unlike the quiet settle-elsewhere path). Returns whether a matching pending approval was resolved.",
    args: z.tuple([
      z
        .object({
          channelId: z.string().min(1).max(200),
          requestId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9._:/-]+$/),
          resolveToken: z
            .string()
            .min(16)
            .max(200)
            .regex(/^[A-Za-z0-9._:/-]+$/),
        })
        .strict(),
      z.enum(["allow", "deny"]),
    ]),
    returns: z.object({ resolved: z.boolean() }),
    // Method-level gate: the inline approve/deny card lives in the chat panel, so
    // `panel` is admitted here (the service-level policy is shell/app/server for
    // the trusted approval bar). Resolution is scoped to
    // (channelId, requestId, resolveToken).
    authority: { principals: ["code", "user", "host"] },
    access: RESOLVE_ACCESS,
    examples: [
      {
        args: [
          { channelId: "channel-1", requestId: "req-1", resolveToken: "token-1234567890" },
          "allow",
        ],
      },
    ],
  },
  submitClientConfig: {
    description:
      "Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { clientId: "abc", clientSecret: "shh" }] }],
  },
  submitCredentialInput: {
    description:
      "Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { token: "secret-value" }] }],
  },
  submitSecretInput: {
    description:
      "Submit the user-entered secret field values for a pending secret-input approval, fulfilling its feedback-form request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { value: "secret-value" }] }],
  },
  listPending: {
    description:
      "List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount.",
    args: z.tuple([]),
    returns: z.array(pendingApprovalSchema),
    access: LIST_PENDING_ACCESS,
  },
});
