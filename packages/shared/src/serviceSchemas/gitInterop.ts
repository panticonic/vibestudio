/**
 * Wire schema for external Git interop only.
 *
 * Workspace version control is GAD-native (`vcs.*`). This service exists for
 * deliberate Git boundary operations: configuring external remotes and
 * importing remote projects.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const gitRemoteSchema = z.object({
  name: z.string(),
  url: z.string(),
  branch: z.string().optional(),
});
export type GitRemote = z.infer<typeof gitRemoteSchema>;

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

export const gitImportProjectSchema = z.object({
  path: z.string(),
  remote: gitRemoteSchema,
  branch: z.string().optional(),
  credentialId: z.string().optional(),
});
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitCompleteWorkspaceDependenciesSchema = z.object({
  credentialId: z.string().optional(),
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

export const gitInteropMethods = defineServiceMethods({
  setSharedRemote: {
    args: z.tuple([z.string(), gitRemoteSchema]),
    returns: gitSharedRemotesSchema.optional(),
  },
  removeSharedRemote: {
    args: z.tuple([z.string(), z.string()]),
    returns: gitSharedRemotesSchema.optional(),
  },
  importProject: {
    args: z.tuple([gitImportProjectSchema]),
    returns: gitImportedWorkspaceRepoSchema,
  },
  completeWorkspaceDependencies: {
    args: z.union([z.tuple([]), z.tuple([gitCompleteWorkspaceDependenciesSchema.optional()])]),
    returns: gitCompleteWorkspaceDependenciesResultSchema,
  },
});
export type GitInteropMethods = typeof gitInteropMethods;
