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
  PendingUnitInstallReviewApproval,
  InstallReviewCharter,
} from "@vibestudio/shared/approvals";
import type {
  InstallReviewOrigin,
  InstallReviewPart,
  InstallReviewRow,
  TemplateInstallResolution,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { AuthorityRequirement, InvocationSnapshot } from "@vibestudio/rpc";
import { APPROVAL_DECISIONS } from "@vibestudio/shared/approvalContract";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/authorityDomains";
import { AUTHORITY_PROMPT_CARD_TYPES } from "@vibestudio/shared/authority/promptRegistry";
import type { AuthorityRowDiff } from "@vibestudio/shared/authority/authorityRowDiff";
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
    icon: z.string().min(1).max(256).optional(),
    iconSourcePath: z.string().optional(),
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
  lifecycle: z
    .object({
      state: z.enum(["preparing", "ready", "failed", "cancelled"]),
      diagnostics: z.array(z.string()).readonly().optional(),
      progress: z
        .object({
          label: z.string(),
          detail: z.string().optional(),
          completed: z.number().int().nonnegative().optional(),
          total: z.number().int().nonnegative().optional(),
          updatedAt: z.number(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  attention: z.enum(["interrupt", "queue"]).optional(),
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

const installRowBaseShape = {
  key: z.string().min(1),
  timing: z.enum(["on-add", "asks-when-needed", "asks-every-time", "behavioral"]),
  notability: z.enum(["headline", "everyday"]),
  selectable: z.boolean(),
  selectedByDefault: z.boolean(),
  change: z.enum(["added", "removed", "retiered"]).optional(),
};

const serviceBindingFactSchema = z
  .object({
    protocol: z.string().min(1),
    availability: z.enum(["required", "optional"]),
    serviceName: z.string().nullable(),
    providerUnit: z.string().nullable(),
    catalogDigest: z.string().nullable(),
  })
  .strict();

const installReviewRowSchema = z.union([
  z
    .object({
      ...installRowBaseShape,
      kind: z.literal("permission"),
      row: authorityRowSchema,
      binding: serviceBindingFactSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...installRowBaseShape,
      kind: z.literal("behavior"),
      fact: z.enum(["runs-in-background", "runs-on-schedule", "reachable-without-opening"]),
      timing: z.literal("behavioral"),
      notability: z.literal("headline"),
      selectable: z.literal(false),
      selectedByDefault: z.literal(false),
    })
    .strict(),
]) satisfies z.ZodType<InstallReviewRow>;

/**
 * Where bytes came from, at human scale (§7.6.3).
 *
 * No commit id and no content digest appears here, because none may appear on
 * any review surface: a 40-character hash is unreadable, and printing it implies
 * the user should check it against something they have no way to check.
 */
const installReviewOriginSchema = z
  .object({
    url: z.string().nullable(),
    originKey: z.string(),
    registrableDomain: z.string().nullable(),
    version: z.string().nullable(),
    selfName: z.string().optional(),
    isHostBuild: z.boolean(),
    isWorkspaceRoot: z.boolean().optional(),
    originStatus: z.enum(["unresolved", "multiple-template-contributors"]).optional(),
    firstEncounter: z.boolean(),
  })
  .strict() satisfies z.ZodType<InstallReviewOrigin>;

const installReviewPartSchema = z
  .object({
    identityKey: z.string().min(1),
    kind: z.enum(["panel", "worker", "app", "extension"]),
    label: z.enum(["Panel", "Agent", "Service", "Client App", "Extension"]),
    surfaces: z.array(
      z.object({ kind: z.enum(["durable-object", "service"]), name: z.string() }).strict()
    ),
    name: z.string(),
    displayName: z.string().min(1).optional(),
    icon: z.string().min(1).max(256).optional(),
    title: z.string(),
    purpose: z.string(),
    repoPath: z.string(),
    effectiveVersion: z.string(),
    version: z.string().nullable(),
    requiredUnitKeys: z.array(z.string()),
    runsInBackground: z.boolean(),
    target: z.enum(["electron", "react-native", "terminal"]).nullable().optional(),
    origin: installReviewOriginSchema,
    notableRows: z.array(installReviewRowSchema),
    everydayRows: z.array(installReviewRowSchema),
    change: z.enum(["added", "removed", "changed", "unchanged"]),
    section: z.enum(["template", "repair"]),
    originallyInstalledFrom: z.string().optional(),
  })
  .strict() satisfies z.ZodType<InstallReviewPart>;

const installReviewCharterSchema = z
  .object({
    kind: z.enum(["scheduled-job", "agent-heartbeat"]),
    name: z.string(),
    schedule: z.string(),
    purpose: z.string(),
    change: z.enum(["added", "removed", "changed"]),
  })
  .strict() satisfies z.ZodType<InstallReviewCharter>;

export const pendingUnitInstallReviewApprovalSchema = z
  .object({
    ...pendingApprovalBaseShape,
    kind: z.literal("unit-install-review"),
    mode: z.enum(["adopt-root", "install", "update", "remove", "part-changed"]),
    title: z.string(),
    description: z.string(),
    template: z
      .object({
        title: z.string(),
        purpose: z.string(),
        origin: installReviewOriginSchema,
        fromVersion: z.string().nullable(),
        toVersion: z.string().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    parts: z.array(installReviewPartSchema),
    summary: z
      .object({
        panels: z.number().int().nonnegative(),
        agents: z.number().int().nonnegative(),
        services: z.number().int().nonnegative(),
        clientApps: z.number().int().nonnegative(),
        extensions: z.number().int().nonnegative(),
      })
      .strict(),
    unchangedPartCount: z.number().int().nonnegative(),
    charters: z.array(installReviewCharterSchema).optional(),
    configWrite: z
      .object({ repoPath: z.string(), summary: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict() satisfies z.ZodType<PendingUnitInstallReviewApproval>;

/**
 * Accepting a review.
 *
 * Every part of the operation is always installed; `allowNow` decides only what
 * is pre-authorized. There is no "install a subset" result, because there is no
 * mechanism behind one (U5).
 */
const templateInstallAcceptanceSchema = z
  .object({
    decision: z.enum(["install", "update", "adopt-root"]),
    allowNow: z.array(
      z
        .object({
          identityKey: z.string().min(1),
          /** Absent means every install-clearable row for the part. */
          permissions: z.array(z.string()).optional(),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((resolution, ctx) => {
    const seen = new Set<string>();
    resolution.allowNow.forEach((allowed, index) => {
      if (seen.has(allowed.identityKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowNow", index, "identityKey"],
          message: "Install review acceptance repeats a part",
        });
      }
      seen.add(allowed.identityKey);
    });
  });

export const templateInstallResolutionSchema = z.union([
  templateInstallAcceptanceSchema,
  z.object({ decision: z.literal("cancel") }).strict(),
]) satisfies z.ZodType<TemplateInstallResolution>;

/**
 * What answering a review actually did (§7.2 result state).
 *
 * The card that asked the question is the only surface that knows a decision
 * was made, and until this existed it simply unmounted: an accepted install
 * ended in silence, and a failed one ended in whatever error string happened to
 * reach the client. `News added / Open News →` needs three things a client
 * cannot derive — what landed, what to offer opening, and what failed — so the
 * server states all three.
 *
 * Every claim here is scoped to what the server actually watched. A resolution
 * settles the decision; the operation that lands the parts runs after it, and
 * only a landing site that reports back turns `landing` from absent into a
 * fact. Absent means "not watched", never "fine" — which is why the heading for
 * that case is written in the present tense.
 */
export interface InstallReviewResolvedPart {
  identityKey: string;
  title: string;
  kind: InstallReviewPart["kind"];
  label: InstallReviewPart["label"];
  /**
   * What this decision pre-authorized for the part (U5).
   *
   * `asks-when-needed` is a real decision, not a failure: the part still
   * arrives and still runs, it simply holds no standing grant.
   */
  clearance: "allowed-now" | "asks-when-needed";
}

/** What a landing site observed, once the operation it owns has concluded. */
export interface InstallReviewLanding {
  /** Identity keys whose admission committed. Nothing else counts as landed. */
  landed: readonly string[];
  /** Parts that did not land, named, with a reason a person can read. */
  failed: readonly { identityKey: string; title: string; reason: string }[];
  /**
   * The workspace is provably untouched.
   *
   * Only ever set by a reporter that guarantees it. §8 requires cancel and
   * failure to leave no grants and no partial activation, but a *partial*
   * failure is not automatically a clean one, so this is never inferred from
   * an empty `landed` list.
   */
  workspaceUnchanged: boolean;
}

export interface InstallReviewResolution {
  approvalId: string;
  mode: PendingUnitInstallReviewApproval["mode"];
  decision: "accepted" | "cancelled";
  /** Ready to render, never blank, and never a claim beyond what was observed. */
  heading: string;
  /** One supporting line, when there is something true to add. */
  detail?: string;
  /** The template this decision was about, when it was about one. */
  subject?: string;
  parts: readonly InstallReviewResolvedPart[];
  /**
   * `Open News →`. Offered only for a part that can be opened and, where the
   * landing was watched, only for one that actually landed.
   */
  entryPoint?: { identityKey: string; repoPath: string; title: string; kind: "panel" | "app" };
  /** Absent when no landing site reported — the outcome is under way, not good. */
  landing?: InstallReviewLanding;
}

const installReviewResolvedPartSchema = z
  .object({
    identityKey: z.string().min(1),
    title: z.string(),
    kind: z.enum(["panel", "worker", "app", "extension"]),
    label: z.enum(["Panel", "Agent", "Service", "Client App", "Extension"]),
    clearance: z.enum(["allowed-now", "asks-when-needed"]),
  })
  .strict() satisfies z.ZodType<InstallReviewResolvedPart>;

export const installReviewResolutionSchema = z
  .object({
    approvalId: z.string().min(1),
    mode: z.enum(["adopt-root", "install", "update", "remove", "part-changed"]),
    decision: z.enum(["accepted", "cancelled"]),
    heading: z.string().min(1),
    detail: z.string().optional(),
    subject: z.string().optional(),
    parts: z.array(installReviewResolvedPartSchema),
    entryPoint: z
      .object({
        identityKey: z.string().min(1),
        repoPath: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(["panel", "app"]),
      })
      .strict()
      .optional(),
    landing: z
      .object({
        landed: z.array(z.string()),
        failed: z.array(
          z
            .object({
              identityKey: z.string().min(1),
              title: z.string(),
              reason: z.string(),
            })
            .strict()
        ),
        workspaceUnchanged: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<InstallReviewResolution>;

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
    taskAuthority: z.string().startsWith("task:").optional() as z.ZodType<
      InvocationSnapshot["taskAuthority"]
    >,
    agentBindingId: z.string().optional(),
    agentName: z.string().optional(),
    lineageClasses: z.array(z.string()).readonly().optional(),
    irreversible: z.boolean().optional(),
    agentScopeEligible: z.boolean().optional(),
    reviewedClosureSubject: z.string() as z.ZodType<InvocationSnapshot["reviewedClosureSubject"]>,
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
      cardType: z.enum(AUTHORITY_PROMPT_CARD_TYPES).optional(),
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
  pendingUnitInstallReviewApprovalSchema,
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

export const workspaceCreationReviewStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("preparing") }).strict(),
  z
    .object({
      status: z.literal("pending"),
      approvalId: z.string().min(1),
      partCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("not-required") }).strict(),
  z.object({ status: z.literal("resolved") }).strict(),
  z.object({ status: z.literal("unresolved") }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }).strict(),
]);

export type WorkspaceCreationReviewState = z.infer<typeof workspaceCreationReviewStateSchema>;

export const SHELL_APPROVAL_READ_AUTHORITY_RESOLVER = "shellApproval.presenter.read" as const;
export const SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER = "shellApproval.presenter.decide" as const;
export const SHELL_APPROVAL_INPUT_AUTHORITY_RESOLVER =
  "shellApproval.presenter.protected-input" as const;

function presenterAuthority(capability: string, resolver: string) {
  return {
    requirement: requirementForPrincipals(["user", "host", "code"], capability),
    resource: { kind: "literal" as const, key: capability },
    prepared: {
      resolver,
      leaves: [
        {
          capability,
          requirement: fixedPreparedAuthorityRequirement(
            requirementForPrincipals(["code"], capability)
          ),
          tier: "gated" as const,
        },
      ],
    },
  };
}

const approvalReadAuthority = presenterAuthority(
  "approvals.read",
  SHELL_APPROVAL_READ_AUTHORITY_RESOLVER
);
const approvalDecisionAuthority = presenterAuthority(
  "approvals.decide",
  SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER
);
const protectedInputAuthority = presenterAuthority(
  "protected-input.submit",
  SHELL_APPROVAL_INPUT_AUTHORITY_RESOLVER
);

export const shellApprovalMethods = defineServiceMethods({
  resolve: {
    capability: "approvals.decide",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
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
    authority: approvalDecisionAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "once"] }],
  },
  resolveMissionReview: {
    capability: "approvals.decide",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
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
    authority: approvalDecisionAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { decision: "dismiss" }] }],
  },
  /**
   * Accept an install review with exactly what the user selected.
   *
   * Every part the operation lands is admitted whatever this says; `allowNow`
   * decides only what standing clearance is minted. The server validates the
   * pending review, rejects any identity or row key absent from it, and rejects
   * any row whose policy is contextual or whose tier is critical — a client
   * cannot ask for more than it was offered (§8).
   */
  resolveInstallReview: {
    capability: "approvals.decide",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
    },
    presentation: {
      title: "Add or update parts of this workspace",
      action: "add or update parts of this workspace",
      description: "Allows {requesterKind} to answer a queued review of arriving parts.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Accept a pending install review, allowing the selected parts and permissions now, or cancel it.",
    args: z.tuple([z.string(), templateInstallResolutionSchema]),
    // The decision's own receipt (§7.2). The card that asked is the only surface
    // that knows the answer was given, so it is the one that has to be able to
    // say what happened — including that nothing did.
    returns: installReviewResolutionSchema,
    authority: approvalDecisionAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { decision: "cancel" }] }],
  },
  resolveBootstrap: {
    capability: "approvals.decide",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
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
      "Convergently resolve a snapshot of pending startup-app approvals. IDs already settled by an earlier partial attempt are reported as not pending so the remaining decisions can continue.",
    args: z.tuple([z.array(z.string().min(1)).min(1).max(256), z.enum(["once", "deny"])]),
    returns: z.array(
      z
        .object({
          approvalId: z.string(),
          status: z.enum(["resolved", "not-pending"]),
        })
        .strict()
    ),
    authority: approvalDecisionAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: [["approval-123"], "deny"] }],
  },
  submitClientConfig: {
    capability: "protected-input.submit",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
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
    authority: protectedInputAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { clientId: "abc", clientSecret: "shh" }] }],
  },
  submitCredentialInput: {
    capability: "protected-input.submit",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
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
    authority: protectedInputAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { token: "secret-value" }] }],
  },
  submitSecretInput: {
    capability: "protected-input.submit",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
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
    authority: protectedInputAuthority,
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { value: "secret-value" }] }],
  },
  listPending: {
    capability: "approvals.read",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.read leaf",
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
    authority: approvalReadAuthority,
    access: LIST_PENDING_ACCESS,
  },
  getWorkspaceCreationReviewState: {
    capability: "approvals.read",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.read leaf",
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
      "Return the host-owned preparation state for the workspace creation review without waiting for a human decision.",
    args: z.tuple([]),
    returns: workspaceCreationReviewStateSchema,
    authority: approvalReadAuthority,
    access: LIST_PENDING_ACCESS,
  },
});
