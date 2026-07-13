/**
 * Wire schema for external Git interop only.
 *
 * Workspace version control is GAD-native (`vcs.*`). This service exists for
 * deliberate Git boundary operations: configuring external remotes and
 * importing remote projects.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import {
  defineServiceMethods,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

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
const COMPLETE_DEPENDENCIES_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const UPSTREAM_STATUS_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const UPSTREAM_OPERATION_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const DISPOSABLE_REMOTE_WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const gitRemoteSchema = z
  .object({
    name: z.string().describe('Git remote name, e.g. "origin".'),
    url: z.string().describe("Remote fetch/push URL (https or git)."),
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
      .describe("Whether protected-main advances auto-push upstream."),
    credentialId: z.string().optional().describe("Credential id used for credentialed git HTTP."),
    authorEmail: z.string().optional().describe("Exported git commit author email override."),
    authorName: z.string().optional().describe("Exported git commit author name override."),
  })
  .strict();
export type GitUpstreamConfig = z.infer<typeof gitUpstreamConfigSchema>;

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
    credentialId: z
      .string()
      .optional()
      .describe("Credential to authenticate the clone via the egress proxy."),
  })
  .strict();
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitCompleteWorkspaceDependenciesSchema = z
  .object({
    credentialId: z
      .string()
      .optional()
      .describe("Credential used to authenticate clones of the configured remotes."),
  })
  .strict();
export type GitCompleteWorkspaceDependenciesOptions = z.infer<
  typeof gitCompleteWorkspaceDependenciesSchema
>;

export const gitImportedWorkspaceRepoSchema = z
  .object({
    path: z.string(),
    remote: gitRemoteSchema,
  })
  .strict();
export type GitImportedWorkspaceRepo = z.infer<typeof gitImportedWorkspaceRepoSchema>;

export const gitCompleteWorkspaceDependenciesResultSchema = z
  .object({
    imported: z.array(gitImportedWorkspaceRepoSchema),
    skipped: z.array(
      z
        .object({
          path: z.string(),
          reason: z.enum(["already-present", "unsupported-path"]),
        })
        .strict()
    ),
    failed: z.array(
      z
        .object({
          path: z.string(),
          error: z.string(),
        })
        .strict()
    ),
  })
  .strict();
export type GitCompleteWorkspaceDependenciesResult = z.infer<
  typeof gitCompleteWorkspaceDependenciesResultSchema
>;

export const gitUpstreamStateSchema = z.enum([
  "in-sync",
  "ahead",
  "behind",
  "diverged",
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

export const gitUpstreamStatusOptionsSchema = z
  .object({
    remote: z.string().optional(),
    branch: z.string().optional(),
    credentialId: z.string().optional(),
    fetch: z.boolean().optional(),
    ttlMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1000)
      .optional()
      .describe(
        "When fetch is true, reuse a successful fetch of the same remote target this many milliseconds before fetching again; 0 always fetches."
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
    aheadBy: nonNegativeIntegerSchema,
    behindBy: nonNegativeIntegerSchema,
    lastPushedSha: z.string().optional(),
    lastPushedAt: nonNegativeIntegerSchema.optional(),
    lastError: z.string().optional(),
    /** True when auto-push is on and unpushed commits are queued behind it. */
    pendingAutoPush: z.boolean().optional(),
    /** When the most recent background push/pull failure was recorded. */
    lastFailureAt: nonNegativeIntegerSchema.optional(),
    /** When the auto-push backoff will retry next, if a retry is scheduled. */
    nextRetryAt: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type GitUpstreamStatusRow = z.infer<typeof gitUpstreamStatusRowSchema>;

export const gitOverwritePreviewSchema = z
  .object({
    count: nonNegativeIntegerSchema,
    commits: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
  })
  .strict();
export type GitOverwritePreview = z.infer<typeof gitOverwritePreviewSchema>;

export const gitPushUpstreamOptionsSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();
export type GitPushUpstreamOptions = z.infer<typeof gitPushUpstreamOptionsSchema>;

export const gitPushUpstreamResultSchema = z
  .object({
    exported: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
    pushed: z.boolean(),
    status: gitUpstreamStateSchema,
    overwrites: gitOverwritePreviewSchema.optional(),
    /** Checkout paths whose local (untracked-by-gad) edits the export
     *  overwrote from the content store. Empty/absent when nothing was lost. */
    clobberedLocalEdits: z.array(z.string()).optional(),
  })
  .strict();
export type GitPushUpstreamResult = z.infer<typeof gitPushUpstreamResultSchema>;

export const gitPullUpstreamOptionsSchema = z
  .object({
    dryRun: z.boolean().optional(),
  })
  .strict();
export type GitPullUpstreamOptions = z.infer<typeof gitPullUpstreamOptionsSchema>;

export const gitImportResultSchema = z
  .object({
    stateHash: z.string(),
    changed: z.boolean(),
  })
  .strict();
export type GitImportResult = z.infer<typeof gitImportResultSchema>;

export const gitPullUpstreamResultSchema = z
  .object({
    behindBy: nonNegativeIntegerSchema,
    aheadBy: nonNegativeIntegerSchema,
    /** False when the tracked remote branch does not exist yet (nothing to
     *  pull; push to create it). Counts are 0/0 in that case, not fabricated. */
    remoteBranchExists: z.boolean(),
    incoming: z.array(z.object({ sha: z.string(), summary: z.string() }).strict()),
    imported: gitImportResultSchema.optional(),
    /** Checkout paths whose local edits the pull/export overwrote. */
    clobberedLocalEdits: z.array(z.string()).optional(),
  })
  .strict();
export type GitPullUpstreamResult = z.infer<typeof gitPullUpstreamResultSchema>;

export const gitResetExportMarkerResultSchema = z
  .object({
    repoPath: z.string(),
    /** True when a marker existed and was cleared. */
    cleared: z.boolean(),
  })
  .strict();
export type GitResetExportMarkerResult = z.infer<typeof gitResetExportMarkerResultSchema>;

export const gitCommitMappingRowSchema = z
  .object({
    gitSha: z.string(),
    gadState: z.string(),
    gadEvent: z.string(),
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
    credentialId: z.string().optional(),
  })
  .strict();
export type GitRemoteDefaultBranchInput = z.infer<typeof gitRemoteDefaultBranchInputSchema>;

export const gitPublishRepoInputSchema = z
  .object({
    repoPath: z.string(),
    provider: z.string().optional(),
    name: z.string().optional(),
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
    exported: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
    pushed: z.boolean(),
  })
  .strict();
export type GitPublishRepoResult = z.infer<typeof gitPublishRepoResultSchema>;

export const gitCreateDisposableRemoteOptionsSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe("Short display/repository name; defaults to workspace-test."),
    branch: z.string().optional().describe("Initial branch; defaults to main."),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .optional()
      .describe("Lifetime in milliseconds, capped at 24 hours."),
  })
  .strict();
export type GitCreateDisposableRemoteOptions = z.infer<
  typeof gitCreateDisposableRemoteOptionsSchema
>;

export const gitDisposableRemoteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    branch: z.string(),
    expiresAt: nonNegativeIntegerSchema,
  })
  .strict();
export type GitDisposableRemote = z.infer<typeof gitDisposableRemoteSchema>;

export const gitDisposableRemoteInspectionSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    branch: z.string(),
    commitCount: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
    expiresAt: nonNegativeIntegerSchema,
  })
  .strict();
export type GitDisposableRemoteInspection = z.infer<typeof gitDisposableRemoteInspectionSchema>;

export const gitPublishToDisposableRemoteResultSchema = z
  .object({
    repoPath: z.string(),
    branch: z.string(),
    exported: nonNegativeIntegerSchema,
    pushed: z.boolean(),
    commitCount: nonNegativeIntegerSchema,
    headCommit: z.string().nullable(),
  })
  .strict();
export type GitPublishToDisposableRemoteResult = z.infer<
  typeof gitPublishToDisposableRemoteResultSchema
>;

export const gitPushDisposableRemoteResultSchema = gitPublishToDisposableRemoteResultSchema;
export type GitPushDisposableRemoteResult = z.infer<typeof gitPushDisposableRemoteResultSchema>;

export const gitInteropMethods = defineServiceMethods({
  setSharedRemote: {
    description:
      "Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/vibestudio.yml and syncing it into the repo's git config; may prompt for capability approval.",
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
      "Remove a named shared Git remote declaration for a workspace unit from meta/vibestudio.yml and sync the repo's git config; may prompt for capability approval.",
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
      "Declare or update upstream tracking for a workspace repo, persisting it to meta/vibestudio.yml; may prompt for capability approval. No network egress happens here.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream applies to."),
      gitUpstreamConfigSchema,
    ]),
    returns: gitUpstreamsSchema,
    access: UPSTREAM_WRITE_ACCESS,
    examples: [
      {
        args: [
          "projects/bgkit",
          { remote: "origin", branch: "main", autoPush: false, credentialId: "github" },
        ],
      },
    ],
  },
  removeUpstream: {
    description:
      "Remove upstream tracking for a workspace repo from meta/vibestudio.yml; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream belongs to."),
    ]),
    returns: gitUpstreamsSchema,
    access: UPSTREAM_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit"] }],
  },
  detachUpstream: {
    description:
      "Atomically remove upstream tracking (and optionally the declared remote) for a workspace repo in one config write and one approval; may prompt for capability approval.",
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
      "Toggle auto-push on an already declared upstream, persisting the change to meta/vibestudio.yml; may prompt for capability approval.",
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
      "Return external Git upstream status for tracked repos. The configured gitInterop provider performs any Git/network work.",
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
    examples: [{ args: [["projects/bgkit"], { fetch: true }] }],
  },
  pushUpstream: {
    description:
      "Export protected main and push it to the repo's declared upstream through the configured gitInterop provider.",
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
      "Fetch/pull a declared upstream and import upstream changes into protected main through the configured gitInterop provider.",
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
      "Create a provider repository, configure tracking, export protected main, and push through the configured gitInterop provider.",
    args: z.tuple([gitPublishRepoInputSchema]),
    returns: gitPublishRepoResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: [{ repoPath: "projects/bgkit", private: true }] }],
  },
  createDisposableRemote: {
    description:
      "Create a short-lived, credential-free smart-HTTP Git remote managed by this workspace host. Prefer publishToDisposableRemote(repoPath) for one-call verification. For a persistent stepwise flow, create a remote, call pushDisposableRemote(repoPath, url, branch), then inspect or remove it.",
    args: z.union([z.tuple([]), z.tuple([gitCreateDisposableRemoteOptionsSchema])]),
    returns: gitDisposableRemoteSchema,
    access: DISPOSABLE_REMOTE_WRITE_ACCESS,
    examples: [{ args: [{ name: "publish-check", branch: "main" }] }],
  },
  publishToDisposableRemote: {
    description:
      "Export one workspace repo, push it to a fresh credential-free host-managed smart-HTTP remote, verify the received commit count, and clean the remote up. This is the one-call development/system-verification path and does not replace or mutate the repo's declared upstream.",
    args: z.union([
      z.tuple([z.string().describe("Workspace-relative repo/unit path to export and verify.")]),
      z.tuple([
        z.string().describe("Workspace-relative repo/unit path to export and verify."),
        z.object({ branch: z.string().optional() }).strict(),
      ]),
    ]),
    returns: gitPublishToDisposableRemoteResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/example"] }],
  },
  pushDisposableRemote: {
    description:
      "Export one workspace repo and push it to an existing host-managed disposable Git remote. The host verifies that the URL is an active disposable remote and returns the received commit count without removing it.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path to export."),
      z.string().describe("URL returned by createDisposableRemote."),
      z.string().describe("Branch returned by createDisposableRemote."),
    ]),
    returns: gitPushDisposableRemoteResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [
      {
        args: [
          "projects/example",
          "http://vibestudio.local/_disposable-git/<id>/publish-check.git",
          "main",
        ],
      },
    ],
  },
  inspectDisposableRemote: {
    description:
      "Verify a host-managed disposable Git remote and return its branch head and total received commit count.",
    args: z.tuple([z.string().describe("URL returned by createDisposableRemote.")]),
    returns: gitDisposableRemoteInspectionSchema,
    access: UPSTREAM_STATUS_ACCESS,
    examples: [{ args: ["http://vibestudio.local/_disposable-git/<id>/publish-check.git"] }],
  },
  removeDisposableRemote: {
    description: "Delete a host-managed disposable Git remote before its automatic expiry.",
    args: z.tuple([z.string().describe("URL returned by createDisposableRemote.")]),
    returns: z.object({ removed: z.boolean() }).strict(),
    access: DISPOSABLE_REMOTE_WRITE_ACCESS,
    examples: [{ args: ["http://vibestudio.local/_disposable-git/<id>/publish-check.git"] }],
  },
  resetExportMarker: {
    description:
      "Clear a repo's git-bridge export marker so the next export rebuilds from an empty checkout. Recovery command for a marker that no longer matches the repo log.",
    args: z.tuple([z.string().describe("Workspace-relative repo/unit path to reset.")]),
    returns: gitResetExportMarkerResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/bgkit"] }],
  },
  commitMapping: {
    description:
      "Return the gad↔git commit mapping for a repo's checkout, read from the GAD-State/GAD-Event trailers of exported commits (newest first).",
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
      "Clone an external Git project into the workspace at the requested path and record its remote and upstream in meta/vibestudio.yml; clones over the network and may prompt for config-write approval.",
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
  completeWorkspaceDependencies: {
    description:
      "Clone every remote declared in meta/vibestudio.yml whose unit is not yet present in the workspace, skipping already-present or unsupported paths; returns per-unit imported/skipped/failed results.",
    args: z.union([z.tuple([]), z.tuple([gitCompleteWorkspaceDependenciesSchema])]),
    returns: gitCompleteWorkspaceDependenciesResultSchema,
    access: COMPLETE_DEPENDENCIES_ACCESS,
    examples: [{ args: [] }],
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
  resetExportMarker: gitInteropMethods.resetExportMarker,
  commitMapping: gitInteropMethods.commitMapping,
  pushDisposableRemote: {
    description: "Export and push one repo to an explicit host-managed disposable remote URL.",
    args: z.tuple([
      z.object({ repoPath: z.string(), url: z.string(), branch: z.string() }).strict(),
    ]),
    returns: z
      .object({
        exported: nonNegativeIntegerSchema,
        pushed: z.boolean(),
        headCommit: z.string().nullable(),
      })
      .strict(),
  },
  cloneRepo: {
    description: "Clone one declared workspace dependency and import it into protected main.",
    args: z.tuple([z.object({ repoPath: z.string() }).strict()]),
    returns: gitImportResultSchema,
  },
  remoteDefaultBranch: {
    description:
      "Ask a remote which branch its HEAD points at (ls-remote symref); null when the remote is empty.",
    args: z.tuple([gitRemoteDefaultBranchInputSchema]),
    returns: z.object({ branch: z.string().nullable() }).strict(),
  },
  onMainAdvanced: {
    description: "Queue upstream processing after protected main advances.",
    args: z.tuple([z.array(z.string())]),
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
  "resetExportMarker",
  "commitMapping",
  "pushDisposableRemote",
] as const satisfies readonly GitInteropProviderMethod[];
export type GitInteropProviderOperation = (typeof GIT_INTEROP_PROVIDER_OPERATIONS)[number];
