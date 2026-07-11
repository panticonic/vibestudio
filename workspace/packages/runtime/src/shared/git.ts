/**
 * Canonical external Git client for panel, worker, and eval runtimes.
 *
 * The public `git` namespace is the typed `gitInterop` service contract
 * without aliases, adapters, provider names, or target-specific behavior.
 * Provider selection and policy enforcement happen behind `gitInterop.*` on
 * the host.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import {
  gitInteropMethods,
  type GitInteropClient,
} from "@vibestudio/shared/serviceSchemas/gitInterop";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

export type GitClient = GitInteropClient;
export type {
  GitCompleteWorkspaceDependenciesOptions,
  GitCompleteWorkspaceDependenciesResult,
  GitImportedWorkspaceRepo,
  GitImportProjectRequest,
  GitOverwritePreview,
  GitPublishRepoInput,
  GitPublishRepoResult,
  GitPullUpstreamOptions,
  GitPullUpstreamResult,
  GitPushUpstreamOptions,
  GitPushUpstreamResult,
  GitRemote,
  GitSharedRemotes,
  GitUpstreamConfig,
  GitUpstreams,
  GitUpstreamState,
  GitUpstreamStatusOptions,
  GitUpstreamStatusRow,
} from "@vibestudio/shared/serviceSchemas/gitInterop";

export function createGitClient(rpc: RpcCaller): GitClient {
  return createTypedServiceClient("gitInterop", gitInteropMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );
}
