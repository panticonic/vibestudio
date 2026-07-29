/**
 * Wire schema for external Git interop only.
 *
 * Workspace version control is GAD-native (`vcs.*`). This service exists for
 * deliberate Git boundary operations: configuring external remotes and
 * importing remote projects.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { vcsExternalSnapshotSchema } from "./vcs.js";

export const GIT_PUBLISH_CAPABILITY = "git.publish" as const;
export const GIT_PUBLISH_REPO_AUTHORITY_RESOLVER = "gitInterop.publishRepo.destination" as const;
export const GIT_TEMPLATE_CONTRIBUTION_AUTHORITY_RESOLVER =
  "gitInterop.pushTemplateContribution.destination" as const;
export const GIT_TEMPLATE_PUBLISH_AUTHORITY_RESOLVER =
  "gitInterop.publishTemplate.destination" as const;

// Access descriptors shared across the gitInterop method group. All four
// methods mutate workspace config (`meta/vibestudio.yml`) and/or reach the
// network/filesystem.
const SHARED_REMOTE_WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const SHARED_REMOTE_REMOVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const UPSTREAM_WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const UPSTREAM_REMOVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const IMPORT_PROJECT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const UPSTREAM_STATUS_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const UPSTREAM_OPERATION_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const gitTemplateContributionInputSchema = z
  .object({
    operationId: z.string().trim().min(1),
    nodeId: z.string().regex(/^t-[0-9a-f]+$/u),
    alias: z.string().trim().min(1),
    url: z.string().url(),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedMainEventId: z.string().trim().min(1),
    parts: z.array(z.object({ repoPath: z.string(), subdir: z.string() }).strict()).min(1),
    credential: z.string().trim().min(1).optional(),
  })
  .strict();
export type GitTemplateContributionInput = z.infer<typeof gitTemplateContributionInputSchema>;

export const gitTemplateContributionResultSchema = z
  .object({
    outcome: z.enum(["pushed", "already-at-remote", "nothing-to-suggest"]),
    operationId: z.string(),
    branch: z.string().nullable(),
    /** A forge-proven contribution URL. Generic Git transport has none. */
    url: z.string().url().optional(),
    headCommit: z.string().nullable(),
    commits: nonNegativeIntegerSchema,
    parts: z.array(z.string()),
  })
  .strict();

export const gitTemplatePublishInputSchema = z
  .object({
    operationId: z.string().trim().min(1),
    expectedMainEventId: z.string().trim().min(1),
    templateName: z.string().trim().min(1),
    version: z.string().regex(/^v?[0-9]+(?:\.[0-9]+){0,2}(?:[-.][A-Za-z0-9]+)*$/u),
    manifest: z.string().min(1),
    manifestDigest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u),
    parts: z.array(z.object({ repoPath: z.string(), subdir: z.string() }).strict()).min(1),
    credentialId: z.string().trim().min(1).optional(),
    destination: z
      .object({
        provider: z.string().trim().min(1),
        owner: z.string().trim().min(1),
        name: z.string().trim().min(1),
      })
      .strict(),
    creation: z
      .object({
        private: z.boolean().optional(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GitTemplatePublishInput = z.infer<typeof gitTemplatePublishInputSchema>;

export const gitTemplatePublishResultSchema = z
  .object({
    operationId: z.string(),
    destination: z
      .object({
        provider: z.string(),
        owner: z.string(),
        name: z.string(),
      })
      .strict(),
    created: z.boolean(),
    remoteUrl: z.string().url(),
    webUrl: z.string().url(),
    templateUrl: z.string(),
    ref: z.string().startsWith("refs/tags/"),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    snapshot: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u),
    parts: z.array(z.string()).min(1),
  })
  .strict();
export type GitTemplatePublishResult = z.infer<typeof gitTemplatePublishResultSchema>;

export const gitRemoteSchema = z
  .object({
    name: z.string().describe('Git remote name, e.g. "origin".'),
    url: z
      .string()
      .describe(
        "Durable HTTP(S) fetch/push URL without embedded credentials, query parameters, or fragments."
      ),
    branch: z
      .string()
      .optional()
      .describe("Default branch to track/clone; omit to use the remote's default."),
  })
  .strict();
export type GitRemote = z.infer<typeof gitRemoteSchema>;

export const gitUpstreamConfigSchema = z
  .object({
    remote: z.string().describe('Declared remote name, e.g. "origin".'),
    branch: z
      .string()
      .optional()
      .describe("Remote branch to track; defaults to the remote branch or main."),
    autoPush: z
      .boolean()
      .optional()
      .describe(
        "Whether future exports of already-published protected main may push upstream automatically; never publishes import candidates."
      ),
    credential: z
      .string()
      .optional()
      .describe(
        "Portable logical credential name resolved by the host for this workspace and remote URL; omit for anonymous Git HTTP."
      ),
    authorEmail: z.string().optional().describe("Exported git commit author email override."),
    authorName: z.string().optional().describe("Exported git commit author name override."),
  })
  .strict();
export type GitUpstreamConfig = z.infer<typeof gitUpstreamConfigSchema>;
const gitUpstreamWriteSchema = gitUpstreamConfigSchema;

const gitRemoteDeclarationSchema = z
  .object({
    url: z.string(),
    branch: z.string().optional(),
  })
  .strict();

export const gitSharedRemotesSchema = z.record(z.record(z.record(gitRemoteDeclarationSchema)));
export type GitSharedRemotes = z.infer<typeof gitSharedRemotesSchema>;

export const gitUpstreamsSchema = z.record(z.record(gitUpstreamConfigSchema));
export type GitUpstreams = z.infer<typeof gitUpstreamsSchema>;

export const gitImportProjectSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Workspace-relative target path for the imported repo; must sit under a supported import dir (e.g. "projects/<name>").'
      ),
    remote: gitRemoteSchema.describe("Remote to clone from and record as a shared remote."),
    credentialIdOverride: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Call-scoped concrete credential override; omit to use the configured logical binding, or use null for an anonymous clone."
      ),
  })
  .strict();
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitSemanticCandidateSchema = z
  .object({
    contextId: z.string().describe("Semantic context containing the external snapshot candidate."),
    eventId: z.string().describe("Committed candidate event created from the external snapshot."),
  })
  .strict();
export type GitSemanticCandidate = z.infer<typeof gitSemanticCandidateSchema>;

export const gitImportResultSchema = gitSemanticCandidateSchema
  .extend({
    changed: z.boolean(),
    semanticEvidence: z
      .object({
        applicationId: z.string().describe("Exact application committed by the import event."),
        workUnitId: z.string().describe("Exact import work unit owned by that application."),
        externalSnapshot: vcsExternalSnapshotSchema.describe(
          "Canonical external snapshot recorded on the import work unit."
        ),
      })
      .strict()
      .describe("Identity-joined evidence returned atomically by the canonical semantic import."),
  })
  .strict();
export type GitImportResult = z.infer<typeof gitImportResultSchema>;

export const gitImportedWorkspaceRepoSchema = z
  .object({
    path: z.string(),
    remote: gitRemoteSchema,
    candidate: gitImportResultSchema.describe(
      "Semantic candidate to compare and integrate before explicitly publishing protected main."
    ),
  })
  .strict();
export type GitImportedWorkspaceRepo = z.infer<typeof gitImportedWorkspaceRepoSchema>;

export const gitUpstreamStateSchema = z.enum([
  "in-sync",
  "ahead",
  "behind",
  "diverged",
  "integration-required",
  "auth-failed",
  "error",
  "exporting",
  "pushing",
  "local-only",
  // Declared in config but the checkout was never cloned/materialized —
  // distinct from `error` so status can name the exact fix-it command.
  "not-materialized",
  // A requested fetch failed (offline, DNS, transient network); local
  // ahead/behind counts are still reported from the last-known tracking ref.
  "fetch-failed",
  // The repo has no exportable commits yet — nothing exists to push.
  "empty",
]);
export type GitUpstreamState = z.infer<typeof gitUpstreamStateSchema>;

export const gitUpstreamRelationshipSchema = z.enum(["in-sync", "ahead", "behind", "diverged"]);
export type GitUpstreamRelationship = z.infer<typeof gitUpstreamRelationshipSchema>;

export const gitUpstreamStatusOptionsSchema = z
  .object({
    remote: z.string().optional(),
    branch: z.string().optional(),
    credentialIdOverride: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Call-scoped concrete credential override for this observation; omit to use the configured logical binding, or use null for anonymous Git HTTP."
      ),
  })
  .strict();
export type GitUpstreamStatusOptions = z.infer<typeof gitUpstreamStatusOptionsSchema>;

export const gitUpstreamStatusRowSchema = z
  .object({
    repoPath: z.string(),
    remote: z.string().optional(),
    branch: z.string().optional(),
    autoPush: z.boolean(),
    state: gitUpstreamStateSchema,
    relationship: gitUpstreamRelationshipSchema
      .optional()
      .describe("Relationship derived from the remote observation made by this call."),
    aheadBy: nonNegativeIntegerSchema.optional(),
    behindBy: nonNegativeIntegerSchema.optional(),
    remoteBranchExists: z
      .boolean()
      .optional()
      .describe(
        "Present after a successful remote observation; false means the configured branch is absent, not that the fetch failed."
      ),
    observedAt: nonNegativeIntegerSchema
      .optional()
      .describe("When this call successfully observed the declared remote."),
    error: z
      .string()
      .optional()
      .describe("Failure from this observation attempt; never a persisted prior failure."),
    lastSuccessfulObservationAt: nonNegativeIntegerSchema
      .optional()
      .describe("Historical telemetry from the most recent successful remote observation."),
    lastSuccessfulPushCommit: z
      .string()
      .optional()
      .describe("Historical telemetry from the most recent successful wire push."),
    lastSuccessfulPushAt: nonNegativeIntegerSchema
      .optional()
      .describe("Historical telemetry from the most recent successful wire push."),
    lastFailureReason: z
      .string()
      .optional()
      .describe("Historical telemetry from the most recent failed background operation."),
    candidate: gitSemanticCandidateSchema
      .optional()
      .describe("Unpublished external snapshot awaiting ordinary semantic VCS integration."),
    /** True when auto-push is on and the exported Git projection is ahead. */
    autoPushRequired: z.boolean().optional(),
    /** When the most recent background push/pull failure was recorded. */
    lastFailureAt: nonNegativeIntegerSchema.optional(),
    /** When the auto-push backoff will retry next, if a retry is scheduled. */
    nextRetryAt: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type GitUpstreamStatusRow = z.infer<typeof gitUpstreamStatusRowSchema>;

const gitOverwriteCommitSchema = z.object({ sha: z.string(), summary: z.string() }).strict();

export const gitOverwritePreviewSchema = z.discriminatedUnion("relationship", [
  z
    .object({
      relationship: z.literal("related"),
      count: nonNegativeIntegerSchema.describe(
        "Exact number of remote-only commits that the force update would replace."
      ),
      commits: z
        .array(gitOverwriteCommitSchema)
        .describe("Bounded examples of remote-only commits."),
      truncated: z.boolean().describe("Whether additional examples were omitted."),
    })
    .strict(),
  z
    .object({
      relationship: z.literal("unrelated"),
      count: z
        .null()
        .describe(
          "Always null because histories without a common ancestor have no relative count."
        ),
      commits: z.array(gitOverwriteCommitSchema).describe("Bounded examples from the remote tip."),
      truncated: z.boolean().describe("Whether additional examples were omitted."),
    })
    .strict(),
]);
export type GitOverwritePreview = z.infer<typeof gitOverwritePreviewSchema>;

export const gitPushUpstreamOptionsSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe(
        "Allow replacement of remote history after explicit approval; the result describes related or unrelated overwritten history."
      ),
    credentialIdOverride: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Host-resolved, call-scoped concrete credential; omitted by callers using the configured logical binding."
      ),
  })
  .strict();
export type GitPushUpstreamOptions = z.infer<typeof gitPushUpstreamOptionsSchema>;

const gitPushUpstreamResultBaseSchema = z
  .object({
    exported: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
    overwrites: gitOverwritePreviewSchema.optional(),
    /** Checkout paths whose local (untracked-by-gad) edits the export
     *  overwrote from the content store. Empty/absent when nothing was lost. */
    clobberedLocalEdits: z.array(z.string()).optional(),
  })
  .strict();

export const gitPushUpstreamResultSchema = z.discriminatedUnion("outcome", [
  gitPushUpstreamResultBaseSchema.extend({ outcome: z.literal("pushed") }).strict(),
  gitPushUpstreamResultBaseSchema.extend({ outcome: z.literal("already-at-remote") }).strict(),
  gitPushUpstreamResultBaseSchema.extend({ outcome: z.literal("remote-missing-created") }).strict(),
  gitPushUpstreamResultBaseSchema
    .extend({
      outcome: z.literal("remote-advanced"),
      remoteHead: z.string(),
      relationship: z.enum(["behind", "diverged", "unrelated"]),
      aheadBy: nonNegativeIntegerSchema.optional(),
      behindBy: nonNegativeIntegerSchema.optional(),
    })
    .strict(),
  gitPushUpstreamResultBaseSchema
    .extend({ outcome: z.literal("empty"), headCommit: z.null() })
    .strict(),
]);
export type GitPushUpstreamResult = z.infer<typeof gitPushUpstreamResultSchema>;

export const gitPullUpstreamOptionsSchema = z
  .object({
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Preview using an isolated temporary checkout; do not mutate the managed checkout, bridge state, semantic state, or remote."
      ),
    credentialIdOverride: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Host-resolved, call-scoped concrete credential; omitted by callers using the configured logical binding."
      ),
  })
  .strict();
export type GitPullUpstreamOptions = z.infer<typeof gitPullUpstreamOptionsSchema>;

export const gitPullUpstreamResultSchema = z
  .object({
    remote: z.string().describe("Observed declared remote name."),
    branch: z.string().describe("Observed declared remote branch."),
    observedCommit: z
      .string()
      .nullable()
      .describe("Exact observed remote branch head, or null when the branch is absent."),
    changed: z
      .boolean()
      .describe("Whether this pull authored a changed semantic snapshot candidate."),
    behindBy: nonNegativeIntegerSchema,
    aheadBy: nonNegativeIntegerSchema,
    remoteBranchExists: z
      .boolean()
      .describe(
        "False when the tracked remote branch does not exist yet; counts are 0/0 and a push may create it."
      ),
    incoming: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
    imported: gitImportResultSchema.optional(),
    /** Checkout paths whose local edits the pull/export overwrote. */
    clobberedLocalEdits: z.array(z.string()).optional(),
  })
  .strict();
export type GitPullUpstreamResult = z.infer<typeof gitPullUpstreamResultSchema>;

export const gitCommitMappingRowSchema = z
  .object({
    gitSha: z.string(),
    eventId: z.string().describe("Semantic event represented by this Git commit."),
    summary: z.string(),
  })
  .strict();
export type GitCommitMappingRow = z.infer<typeof gitCommitMappingRowSchema>;

export const gitCommitMappingOptionsSchema = z
  .object({
    limit: z.number().int().positive().max(1000).optional(),
  })
  .strict();
export type GitCommitMappingOptions = z.infer<typeof gitCommitMappingOptionsSchema>;

export const gitDetachUpstreamOptionsSchema = z
  .object({
    /** Also remove the declared remote config entry (default: keep it). */
    forgetRemote: z.boolean().optional(),
    /** Remote name to forget; defaults to the upstream's declared remote. */
    remote: z.string().optional(),
  })
  .strict();
export type GitDetachUpstreamOptions = z.infer<typeof gitDetachUpstreamOptionsSchema>;

export const gitDetachUpstreamResultSchema = z
  .object({
    upstreams: gitUpstreamsSchema,
    remotes: gitSharedRemotesSchema,
    removedRemote: z.string().nullable(),
  })
  .strict();
export type GitDetachUpstreamResult = z.infer<typeof gitDetachUpstreamResultSchema>;

export const gitRemoteDefaultBranchInputSchema = z
  .object({
    url: z.string(),
    credentialIdOverride: z.string().nullable().optional(),
  })
  .strict();
export type GitRemoteDefaultBranchInput = z.infer<typeof gitRemoteDefaultBranchInputSchema>;

export const gitPublishRepoInputSchema = z
  .object({
    repoPath: z.string(),
    provider: z.string().optional(),
    name: z.string().optional(),
    organization: z.string().optional(),
    private: z.boolean().optional(),
    description: z.string().optional(),
    remote: z.string().optional(),
    branch: z.string().optional(),
    credentialId: z.string().optional(),
    authorEmail: z.string().optional(),
    authorName: z.string().optional(),
    autoPush: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type GitPublishRepoInput = z.infer<typeof gitPublishRepoInputSchema>;

export const gitPublishRepoResultSchema = z
  .object({
    repoPath: z.string(),
    provider: z.string(),
    remote: z.string(),
    branch: z.string(),
    remoteUrl: z.string(),
    webUrl: z.string(),
    owner: z.string(),
    credentialId: z.string().optional(),
    credentialLogin: z.string().optional(),
    credentialTarget: z.string().optional(),
    credentialOwnerSource: z
      .enum(["explicit", "credential-target", "authenticated-user"])
      .optional(),
    exported: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
    pushed: z.boolean(),
  })
  .strict();
export type GitPublishRepoResult = z.infer<typeof gitPublishRepoResultSchema>;

export const gitInteropMethods = defineServiceMethods({
  setSharedRemote: {
    description:
      "Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/vibestudio.yml, syncing it into the repo's git config, and queueing immediate provider reconciliation; may prompt for capability approval. Durable URLs must be credential-free HTTP(S) URLs without query parameters or fragments.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the remote applies to."),
      gitRemoteSchema,
    ]),
    returns: gitSharedRemotesSchema,
    access: SHARED_REMOTE_WRITE_ACCESS,
    examples: [
      {
        args: [
          "projects/bgkit",
          { name: "origin", url: "https://github.com/werg/bgkit.git", branch: "main" },
        ],
      },
    ],
  },
  removeSharedRemote: {
    description:
      "Remove a named shared Git remote declaration for a workspace unit from meta/vibestudio.yml, sync the repo's git config, and queue immediate provider reconciliation; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the remote belongs to."),
      z.string().describe('Name of the remote to remove, e.g. "origin".'),
    ]),
    returns: gitSharedRemotesSchema,
    access: SHARED_REMOTE_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit", "origin"] }],
  },
  setUpstream: {
    description:
      "Declare or update upstream tracking for a workspace repo, persisting it to meta/vibestudio.yml and queueing immediate provider reconciliation; may prompt for capability approval. The config write does not wait for provider readiness or perform network egress. The optional credential is a portable logical name resolved by the host for this workspace and remote URL.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream applies to."),
      gitUpstreamWriteSchema,
    ]),
    returns: gitUpstreamsSchema,
    access: UPSTREAM_WRITE_ACCESS,
    examples: [
      {
        args: [
          "projects/bgkit",
          { remote: "origin", branch: "main", autoPush: false, credential: "github" },
        ],
      },
    ],
  },
  removeUpstream: {
    description:
      "Remove upstream tracking for a workspace repo from meta/vibestudio.yml, then queue immediate provider reconciliation; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream belongs to."),
    ]),
    returns: gitUpstreamsSchema,
    access: UPSTREAM_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit"] }],
  },
  detachUpstream: {
    description:
      "Atomically remove upstream tracking (and optionally the declared remote) for a workspace repo in one config write and one approval, then queue immediate provider reconciliation; may prompt for capability approval.",
    args: z.union([
      z.tuple([z.string().describe("Workspace-relative repo/unit path to detach.")]),
      z.tuple([
        z.string().describe("Workspace-relative repo/unit path to detach."),
        gitDetachUpstreamOptionsSchema,
      ]),
    ]),
    returns: gitDetachUpstreamResultSchema,
    access: UPSTREAM_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit", { forgetRemote: true }] }],
  },
  setAutoPush: {
    description:
      "Toggle optional outgoing Git push for future exports of already-published protected main, preserving the upstream's exact credential mode, persisting the change to meta/vibestudio.yml, and queueing immediate provider reconciliation; this never publishes import candidates and may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream belongs to."),
      z.boolean().describe("Whether auto-push should be enabled."),
    ]),
    returns: gitUpstreamsSchema,
    access: UPSTREAM_WRITE_ACCESS,
    examples: [{ args: ["projects/bgkit", true] }],
  },
  upstreamStatus: {
    description:
      "Observe the declared remote and return external Git upstream status for tracked repos, including integration-required candidate coordinates. Relationship, counts, remoteBranchExists, and observedAt describe only the observation made by this call and are absent when it fails. Arguments are positional: call `git.upstreamStatus([imported.path])`, not `git.upstreamStatus([[imported.path]])`. The configured gitInterop provider performs all Git/network work.",
    args: z.union([
      z.tuple([
        z
          .array(z.string())
          .describe("Workspace-relative repos to inspect; pass an empty array for every upstream."),
      ]),
      z.tuple([
        z
          .array(z.string())
          .describe("Workspace-relative repos to inspect; pass an empty array for every upstream."),
        gitUpstreamStatusOptionsSchema,
      ]),
    ]),
    returns: z.array(gitUpstreamStatusRowSchema),
    access: UPSTREAM_STATUS_ACCESS,
    examples: [{ args: [["projects/bgkit"]] }],
  },
  pushUpstream: {
    description:
      "Export protected main, observe the declared remote, and return a typed push outcome through the configured gitInterop provider; refuse while an external snapshot candidate requires semantic integration. A forced update returns bounded overwrite evidence: related history has an exact count, while unrelated history has count null because no relative commit count exists.",
    args: z.union([
      z.tuple([z.string().describe("Workspace-relative repo/unit path to push.")]),
      z.tuple([
        z.string().describe("Workspace-relative repo/unit path to push."),
        gitPushUpstreamOptionsSchema,
      ]),
    ]),
    returns: gitPushUpstreamResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/bgkit", { force: false }] }],
  },
  pullUpstream: {
    description:
      "Fetch a declared upstream and import its exact snapshot as a semantic candidate. With dryRun true, export and fetch only inside an isolated temporary checkout and mutate no managed Git, bridge, semantic, or remote state. A missing configured remote branch is reported explicitly as remoteBranchExists false with zero counts. Reconcile and publish an imported candidate only through vcs.compare, incremental vcs.integrate, vcs.commit, and vcs.push.",
    args: z.union([
      z.tuple([z.string().describe("Workspace-relative repo/unit path to pull.")]),
      z.tuple([
        z.string().describe("Workspace-relative repo/unit path to pull."),
        gitPullUpstreamOptionsSchema,
      ]),
    ]),
    returns: gitPullUpstreamResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/bgkit", { dryRun: true }] }],
  },
  publishRepo: {
    description:
      "Resolve exactly one GitHub credential (explicit credentialId, or the sole active GitHub credential; refuse ambiguity), resolve the destination owner from explicit organization, persisted credential target, or authenticated user, preflight live account and publish permissions, create a provider repository, configure tracking, export protected main, and push through the configured gitInterop provider.",
    args: z.tuple([gitPublishRepoInputSchema]),
    returns: gitPublishRepoResultSchema,
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], GIT_PUBLISH_CAPABILITY),
      resource: { kind: "literal", key: GIT_PUBLISH_CAPABILITY },
      prepared: {
        resolver: GIT_PUBLISH_REPO_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: GIT_PUBLISH_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], GIT_PUBLISH_CAPABILITY)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: [{ repoPath: "projects/bgkit", private: true }] }],
  },
  commitMapping: {
    description:
      "Return the semantic-event↔Git commit mapping for a repo's checkout, read from Vibestudio-Event trailers (newest first).",
    args: z.union([
      z.tuple([z.string().describe("Workspace-relative repo/unit path to inspect.")]),
      z.tuple([
        z.string().describe("Workspace-relative repo/unit path to inspect."),
        gitCommitMappingOptionsSchema,
      ]),
    ]),
    returns: z.array(gitCommitMappingRowSchema),
    access: UPSTREAM_STATUS_ACCESS,
    examples: [{ args: ["projects/bgkit", { limit: 50 }] }],
  },
  importProject: {
    description:
      "Clone an external Git project, record its remote/upstream config, and return the semantic candidate plus identity-joined evidence from the same atomic semantic import. The import does not publish protected main. The returned semanticEvidence includes the external snapshot source URI, revision, digest, and target repository IDs; the provenance tool can independently inspect the same returned IDs. Check the same repo with the positional call `git.upstreamStatus([imported.path])` to distinguish the unpublished integration-required candidate from protected main and outgoing Git publication, and report that same candidate event ID with the path and publication state. Use the ordinary VCS integration path when publication is intended.",
    args: z.tuple([gitImportProjectSchema]),
    returns: gitImportedWorkspaceRepoSchema,
    access: IMPORT_PROJECT_ACCESS,
    examples: [
      {
        args: [
          {
            path: "projects/bgkit",
            remote: {
              name: "origin",
              url: "https://github.com/werg/bgkit.git",
              branch: "vibestudio-bridge",
            },
          },
        ],
      },
    ],
  },
  pushTemplateContribution: {
    description:
      "Export selected repositories from one exact protected-main event and push one collision-safe template contribution branch through the configured gitInterop provider.",
    args: z.tuple([gitTemplateContributionInputSchema]),
    returns: gitTemplateContributionResultSchema,
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], GIT_PUBLISH_CAPABILITY),
      resource: { kind: "literal", key: GIT_PUBLISH_CAPABILITY },
      prepared: {
        resolver: GIT_TEMPLATE_CONTRIBUTION_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: GIT_PUBLISH_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], GIT_PUBLISH_CAPABILITY)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: UPSTREAM_OPERATION_ACCESS,
  },
  publishTemplate: {
    description:
      "Create a provider repository and publish selected repositories from one exact protected-main event with one generated portable template manifest and immutable version tag.",
    args: z.tuple([gitTemplatePublishInputSchema]),
    returns: gitTemplatePublishResultSchema,
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], GIT_PUBLISH_CAPABILITY),
      resource: { kind: "literal", key: GIT_PUBLISH_CAPABILITY },
      prepared: {
        resolver: GIT_TEMPLATE_PUBLISH_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: GIT_PUBLISH_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], GIT_PUBLISH_CAPABILITY)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: UPSTREAM_OPERATION_ACCESS,
  },
});
export type GitInteropMethods = typeof gitInteropMethods;
export type GitInteropClient = TypedServiceClient<GitInteropMethods>;

/**
 * Complete host-to-extension contract for the manifest-selected Git provider.
 * These methods are host-only and cannot be reached through generic extension
 * invocation.
 */
export const gitInteropProviderMethods = defineServiceMethods({
  upstreamStatus: gitInteropMethods.upstreamStatus,
  pushUpstream: gitInteropMethods.pushUpstream,
  pullUpstream: gitInteropMethods.pullUpstream,
  publishRepo: gitInteropMethods.publishRepo,
  commitMapping: gitInteropMethods.commitMapping,
  pushTemplateContribution: {
    description:
      "Export selected protected-main repositories as one commit per template subtree and push one collision-safe contribution branch after observing remote truth.",
    args: z.tuple([gitTemplateContributionInputSchema]),
    returns: gitTemplateContributionResultSchema,
  },
  publishTemplate: {
    description: "Create and publish one exact multi-repository template tree and version tag.",
    args: z.tuple([gitTemplatePublishInputSchema]),
    returns: gitTemplatePublishResultSchema,
  },
  cloneRepo: {
    description: "Clone one declared workspace dependency and return its semantic candidate.",
    args: z.tuple([
      z
        .object({
          repoPath: z.string(),
          credentialIdOverride: z.string().nullable().optional(),
        })
        .strict(),
    ]),
    returns: gitImportResultSchema,
  },
  remoteDefaultBranch: {
    description:
      "Ask a remote which branch its HEAD points at (ls-remote symref); null when the remote is empty.",
    args: z.tuple([gitRemoteDefaultBranchInputSchema]),
    returns: z.object({ branch: z.string().nullable() }).strict(),
  },
  reconcileUpstreams: {
    description:
      "Queue current-config reconciliation for repositories after protected main or Git tracking configuration changes.",
    args: z.tuple([
      z.array(
        z
          .object({
            repoPath: z.string(),
            credentialIdOverride: z.string().nullable().optional(),
          })
          .strict()
      ),
    ]),
    returns: z.object({ queued: nonNegativeIntegerSchema }).strict(),
  },
});
export type GitInteropProviderMethods = typeof gitInteropProviderMethods;
export type GitInteropProvider = TypedServiceClient<GitInteropProviderMethods>;
export type GitInteropProviderMethod = keyof GitInteropProviderMethods;
export type GitInteropProviderArgs<M extends GitInteropProviderMethod> = z.infer<
  GitInteropProviderMethods[M]["args"]
>;
export type GitInteropProviderResult<M extends GitInteropProviderMethod> = z.infer<
  GitInteropProviderMethods[M]["returns"]
>;

export const GIT_INTEROP_PROVIDER_METHOD_NAMES = Object.freeze(
  Object.keys(gitInteropProviderMethods) as GitInteropProviderMethod[]
);

export const GIT_INTEROP_PROVIDER_OPERATIONS = [
  "upstreamStatus",
  "pushUpstream",
  "pullUpstream",
  "publishRepo",
  "commitMapping",
  "pushTemplateContribution",
  "publishTemplate",
] as const satisfies readonly GitInteropProviderMethod[];
export type GitInteropProviderOperation = (typeof GIT_INTEROP_PROVIDER_OPERATIONS)[number];
