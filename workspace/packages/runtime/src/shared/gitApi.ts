/**
 * Git interop client — the portable `git` namespace derived once in
 * `createHostedRuntime`. Previously this object literal was duplicated verbatim
 * in the panel and worker barrels; it now lives here so all targets share it.
 * `http` is the credential client's `gitHttp` (credentialed git-over-HTTP).
 */

import type { RpcCaller } from "@vibestudio/rpc";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { gitInteropMethods } from "@vibestudio/shared/serviceSchemas/gitInterop";
import type { GitUpstreamStatusRow } from "@vibestudio/shared/gitUpstream";
import type { CredentialClient } from "./credentials.js";

const GIT_BRIDGE_EXTENSION = "@workspace-extensions/git-bridge";

export interface GitRemoteSpec {
  name: string;
  url: string;
  branch?: string;
}

export interface GitUpstreamSpec {
  remote: string;
  branch?: string;
  autoPush?: boolean;
  credentialId?: string;
  authorEmail?: string;
  authorName?: string;
}

export interface GitUpstreamOperationOptions {
  remote?: string;
  branch?: string;
  credentialId?: string;
  authorEmail?: string;
  authorName?: string;
  autoPush?: boolean;
  force?: boolean;
  dryRun?: boolean;
  fetch?: boolean;
}

/** Options for publishing a workspace repo to a newly created remote repo. */
export interface GitPublishOptions extends Omit<GitUpstreamOperationOptions, "dryRun" | "fetch"> {
  provider?: string;
  /** Remote repo name (default: the workspace repo's leaf name). */
  name?: string;
  private?: boolean;
  description?: string;
}

export type { GitUpstreamState } from "@vibestudio/shared/gitUpstream";

export type GitUpstreamStatus = GitUpstreamStatusRow & { [key: string]: unknown };

export interface GitUpstreamOperationResult {
  repoPath?: string;
  status?: string;
  remote?: string;
  branch?: string;
  exported?: number;
  headCommit?: string | null;
  upstreamCommit?: string | null;
  message?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImportProjectRequest {
  path: string;
  remote: GitRemoteSpec;
  branch?: string;
  credentialId?: string;
}

export interface ImportedWorkspaceRepo {
  path: string;
  remote: GitRemoteSpec;
}

export interface CompleteWorkspaceDependenciesResult {
  imported: ImportedWorkspaceRepo[];
  skipped: Array<{ path: string; reason: "already-present" | "unsupported-path" }>;
  failed: Array<{ path: string; error: string }>;
}

export interface RuntimeGitApi {
  http: CredentialClient["gitHttp"];
  upstreamStatus(
    repoPath: string,
    options?: Pick<GitUpstreamOperationOptions, "remote" | "branch" | "credentialId" | "fetch">
  ): Promise<GitUpstreamStatus>;
  pushUpstream(
    repoPath: string,
    options?: GitUpstreamOperationOptions
  ): Promise<GitUpstreamOperationResult>;
  pullUpstream(
    repoPath: string,
    options?: GitUpstreamOperationOptions
  ): Promise<GitUpstreamOperationResult>;
  publishRepo(repoPath: string, options?: GitPublishOptions): Promise<GitUpstreamOperationResult>;
  configureUpstream(
    repoPath: string,
    upstream: GitUpstreamSpec
  ): Promise<Record<string, unknown> | undefined>;
  importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo>;
  completeWorkspaceDependencies(options?: {
    credentialId?: string;
  }): Promise<CompleteWorkspaceDependenciesResult>;
  setSharedRemote(
    repoPath: string,
    remote: GitRemoteSpec
  ): Promise<Record<string, unknown> | undefined>;
  removeSharedRemote(
    repoPath: string,
    remoteName: string
  ): Promise<Record<string, unknown> | undefined>;
}

function invokeGitBridge<T>(
  rpc: RpcCaller,
  method: "upstreamStatus" | "pushUpstream" | "pullUpstream" | "publishRepo",
  args: unknown[]
): Promise<T> {
  return rpc.call("main", "extensions.invoke", [GIT_BRIDGE_EXTENSION, method, args]) as Promise<T>;
}

export function createGitApi(rpc: RpcCaller, gitHttp: CredentialClient["gitHttp"]): RuntimeGitApi {
  const gitInterop = createTypedServiceClient(
    "gitInterop",
    gitInteropMethods,
    (svc, method, args) => rpc.call("main", `${svc}.${method}`, args)
  );
  return {
    http: gitHttp,
    upstreamStatus: async (repoPath, options = {}) => {
      const rows = await invokeGitBridge<GitUpstreamStatus[]>(rpc, "upstreamStatus", [
        [repoPath],
        options,
      ]);
      const row = rows[0];
      if (!row) {
        return { repoPath, autoPush: false, state: "local-only", aheadBy: 0, behindBy: 0 };
      }
      return row;
    },
    pushUpstream: (repoPath, options = {}) =>
      invokeGitBridge(rpc, "pushUpstream", [repoPath, options]),
    pullUpstream: (repoPath, options = {}) =>
      invokeGitBridge(rpc, "pullUpstream", [repoPath, options]),
    publishRepo: (repoPath, options = {}) =>
      invokeGitBridge(rpc, "publishRepo", [repoPath, options]),
    configureUpstream: (repoPath, upstream) => gitInterop.setUpstream(repoPath, upstream),
    importProject: (request) => gitInterop.importProject(request),
    completeWorkspaceDependencies: (options = {}) =>
      gitInterop.completeWorkspaceDependencies(options),
    setSharedRemote: (repoPath, remote) => gitInterop.setSharedRemote(repoPath, remote),
    removeSharedRemote: (repoPath, remoteName) =>
      gitInterop.removeSharedRemote(repoPath, remoteName),
  };
}
