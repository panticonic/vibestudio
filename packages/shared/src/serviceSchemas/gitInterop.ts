/**
 * Wire schema for external Git interop only.
 *
 * Workspace version control is GAD-native (`vcs.*`). This service exists for
 * deliberate Git boundary operations: configuring external remotes and
 * importing remote projects.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

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

export const gitRemoteSchema = z.object({
  name: z.string().describe('Git remote name, e.g. "origin".'),
  url: z.string().describe("Remote fetch/push URL (https or git)."),
  branch: z
    .string()
    .optional()
    .describe("Default branch to track/clone; omit to use the remote's default."),
});
export type GitRemote = z.infer<typeof gitRemoteSchema>;

export const gitUpstreamConfigSchema = z.object({
  remote: z.string().describe('Declared remote name, e.g. "origin".'),
  branch: z
    .string()
    .optional()
    .describe("Remote branch to track; defaults to the remote branch or main."),
  autoPush: z.boolean().optional().describe("Whether protected-main advances auto-push upstream."),
  credentialId: z.string().optional().describe("Credential id used for credentialed git HTTP."),
  authorEmail: z.string().optional().describe("Exported git commit author email override."),
  authorName: z.string().optional().describe("Exported git commit author name override."),
});
export type GitUpstreamConfig = z.infer<typeof gitUpstreamConfigSchema>;

const gitRemoteDeclarationSchema = z.union([
  z.string(),
  z.object({
    url: z.string(),
    branch: z.string().nullable().optional(),
  }),
]);

export const gitSharedRemotesSchema = z.record(
  z.record(z.record(gitRemoteDeclarationSchema.nullable().optional()).optional()).optional()
);
export type GitSharedRemotes = z.infer<typeof gitSharedRemotesSchema>;

export const gitUpstreamsSchema = z.record(
  z.record(gitUpstreamConfigSchema.nullable().optional()).optional()
);
export type GitUpstreams = z.infer<typeof gitUpstreamsSchema>;

export const gitImportProjectSchema = z.object({
  path: z
    .string()
    .describe(
      'Workspace-relative target path for the imported repo; must sit under a supported import dir (e.g. "projects/<name>").'
    ),
  remote: gitRemoteSchema.describe("Remote to clone from and record as a shared remote."),
  branch: z
    .string()
    .optional()
    .describe("Branch to clone; overrides remote.branch when both are given."),
  credentialId: z
    .string()
    .optional()
    .describe("Credential to authenticate the clone via the egress proxy."),
});
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitCompleteWorkspaceDependenciesSchema = z.object({
  credentialId: z
    .string()
    .optional()
    .describe("Credential used to authenticate clones of the configured remotes."),
});
export type GitCompleteWorkspaceDependenciesOptions = z.infer<
  typeof gitCompleteWorkspaceDependenciesSchema
>;

export const gitImportedWorkspaceRepoSchema = z.object({
  path: z.string(),
  remote: gitRemoteSchema,
});
export type GitImportedWorkspaceRepo = z.infer<typeof gitImportedWorkspaceRepoSchema>;

export const gitCompleteWorkspaceDependenciesResultSchema = z.object({
  imported: z.array(gitImportedWorkspaceRepoSchema),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(["already-present", "unsupported-path"]),
    })
  ),
  failed: z.array(
    z.object({
      path: z.string(),
      error: z.string(),
    })
  ),
});
export type GitCompleteWorkspaceDependenciesResult = z.infer<
  typeof gitCompleteWorkspaceDependenciesResultSchema
>;

const gitUpstreamStatusStateSchema = z.enum([
  "in-sync",
  "ahead",
  "behind",
  "diverged",
  "auth-failed",
  "error",
  "exporting",
  "pushing",
  "local-only",
]);

const gitUpstreamStatusOptionsSchema = z.object({
  remote: z.string().optional(),
  branch: z.string().optional(),
  credentialId: z.string().optional(),
  fetch: z.boolean().optional(),
});

const gitUpstreamStatusRowSchema = z.object({
  repoPath: z.string(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  autoPush: z.boolean(),
  state: gitUpstreamStatusStateSchema,
  aheadBy: z.number(),
  behindBy: z.number(),
  lastPushedSha: z.string().optional(),
  lastPushedAt: z.number().optional(),
  lastError: z.string().optional(),
});

const gitOverwritePreviewSchema = z.object({
  count: z.number(),
  commits: z.array(z.object({ sha: z.string(), summary: z.string() })),
});

const gitPushUpstreamResultSchema = z.object({
  exported: z.number(),
  headCommit: z.string().nullable(),
  pushed: z.boolean(),
  status: gitUpstreamStatusStateSchema,
  overwrites: gitOverwritePreviewSchema.optional(),
});

const gitPullUpstreamResultSchema = z.object({
  behindBy: z.number(),
  aheadBy: z.number(),
  incoming: z.array(z.object({ sha: z.string(), summary: z.string() })),
  imported: z.object({ changed: z.boolean().optional(), stateHash: z.string().optional() }).optional(),
});

const gitPublishRepoSchema = z.object({
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
  force: z.boolean().optional(),
});

const gitPublishResultSchema = z.object({
  repoPath: z.string(),
  provider: z.string(),
  remoteUrl: z.string(),
  webUrl: z.string(),
  owner: z.string(),
  exported: z.number(),
  headCommit: z.string().nullable(),
  pushed: z.boolean(),
});

export const gitInteropMethods = defineServiceMethods({
  setSharedRemote: {
    description:
      "Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/vibestudio.yml and syncing it into the repo's git config; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the remote applies to."),
      gitRemoteSchema,
    ]),
    returns: gitSharedRemotesSchema.optional(),
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
    returns: gitSharedRemotesSchema.optional(),
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
    returns: gitUpstreamsSchema.optional(),
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
    returns: gitUpstreamsSchema.optional(),
    access: UPSTREAM_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit"] }],
  },
  setAutoPush: {
    description:
      "Toggle auto-push on an already declared upstream, persisting the change to meta/vibestudio.yml; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the upstream belongs to."),
      z.boolean().optional().describe("Whether auto-push should be enabled. Defaults to true."),
    ]),
    returns: gitUpstreamsSchema.optional(),
    access: UPSTREAM_WRITE_ACCESS,
    examples: [{ args: ["projects/bgkit", true] }],
  },
  upstreamStatus: {
    description:
      "Return external Git upstream status for tracked repos. The configured gitInterop provider performs any Git/network work.",
    args: z.tuple([
      z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      gitUpstreamStatusOptionsSchema.optional(),
    ]),
    returns: z.array(gitUpstreamStatusRowSchema),
    access: UPSTREAM_STATUS_ACCESS,
    examples: [{ args: [["projects/bgkit"], { fetch: true }] }],
  },
  pushUpstream: {
    description:
      "Export protected main and push it to the repo's declared upstream through the configured gitInterop provider.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path to push."),
      z.object({ force: z.boolean().optional() }).optional(),
    ]),
    returns: gitPushUpstreamResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/bgkit", { force: false }] }],
  },
  pullUpstream: {
    description:
      "Fetch/pull a declared upstream and import upstream changes into protected main through the configured gitInterop provider.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path to pull."),
      z.object({ dryRun: z.boolean().optional() }).optional(),
    ]),
    returns: gitPullUpstreamResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: ["projects/bgkit", { dryRun: true }] }],
  },
  publishRepo: {
    description:
      "Create a provider repository, configure tracking, export protected main, and push through the configured gitInterop provider.",
    args: z.tuple([gitPublishRepoSchema]),
    returns: gitPublishResultSchema,
    access: UPSTREAM_OPERATION_ACCESS,
    examples: [{ args: [{ repoPath: "projects/bgkit", private: true }] }],
  },
  importProject: {
    description:
      "Clone an external Git project into the workspace at the requested path and record its remote in meta/vibestudio.yml; clones over the network and may prompt for config-write approval.",
    args: z.tuple([gitImportProjectSchema]),
    returns: gitImportedWorkspaceRepoSchema,
    access: IMPORT_PROJECT_ACCESS,
    examples: [
      {
        args: [
          {
            path: "projects/bgkit",
            remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
            branch: "vibestudio-bridge",
          },
        ],
      },
    ],
  },
  completeWorkspaceDependencies: {
    description:
      "Clone every remote declared in meta/vibestudio.yml whose unit is not yet present in the workspace, skipping already-present or unsupported paths; returns per-unit imported/skipped/failed results.",
    args: z.union([z.tuple([]), z.tuple([gitCompleteWorkspaceDependenciesSchema.optional()])]),
    returns: gitCompleteWorkspaceDependenciesResultSchema,
    access: COMPLETE_DEPENDENCIES_ACCESS,
    examples: [{ args: [] }],
  },
});
export type GitInteropMethods = typeof gitInteropMethods;
