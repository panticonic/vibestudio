import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";
import {
  getDeclaredUpstreamForRepo,
  getDeclaredRemoteForRepo,
  getDeclaredUpstreams,
  normalizeRemoteUrl,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  removeDeclaredUpstreamFromConfig,
  setDeclaredRemoteInConfig,
  setDeclaredUpstreamInConfig,
  syncDeclaredRemoteForRepo,
  validateWorkspaceGitRemote,
  validateWorkspaceGitRemoteName,
  validateWorkspaceGitUpstream,
} from "@vibestudio/workspace/remotes";
import {
  WORKSPACE_IMPORT_PARENT_DIRS,
  isSupportedImportRepoPath,
  resolveWorkspaceRepoPath,
} from "@vibestudio/workspace/pathPolicy";
import {
  gitInteropMethods,
  gitInteropProviderMethods,
  type GitCompleteWorkspaceDependenciesOptions,
  type GitCompleteWorkspaceDependenciesResult,
  type GitDetachUpstreamOptions,
  type GitDetachUpstreamResult,
  type GitImportedWorkspaceRepo,
  type GitImportResult,
  type GitImportProjectRequest,
  type GitInteropProviderArgs,
  type GitInteropProviderMethod,
  type GitInteropProviderOperation,
  type GitInteropProviderResult,
} from "@vibestudio/service-schemas/gitInterop";
import type { DisposableGitRemoteManager } from "./disposableGitRemoteManager.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { deleteDynamicProperty } from "../../lintHelpers";
import { isAuthorizedChrome } from "./chromeTrust.js";

const SHARED_GIT_REMOTE_CAPABILITY = "workspace-shared-git-remote";
const GIT_UPSTREAM_CAPABILITY = "workspace-git-upstream";

type GitInteropServiceDeps = {
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  workspaceConfigMutationWouldChange?: (mutate: WorkspaceConfigMutation) => Promise<boolean>;
  persistWorkspaceConfigMutation?: (input: {
    ctx: ServiceContext;
    mutate: WorkspaceConfigMutation;
    summary: string;
  }) => Promise<WorkspaceConfigMutationResult>;
  /** Provider-owned Git transport operations. Host owns policy and config writes. */
  invokeGitProvider?: <M extends GitInteropProviderMethod>(
    ctx: ServiceContext,
    method: M,
    args: GitInteropProviderArgs<M>
  ) => Promise<GitInteropProviderResult<M>>;
  disposableRemotes?: Pick<DisposableGitRemoteManager, "create" | "inspect" | "remove">;
};

type WorkspaceConfigMutation = (currentConfig: WorkspaceConfig) => WorkspaceConfig;
type WorkspaceConfigMutationResult = { changed: boolean; nextConfig: WorkspaceConfig };

export function createGitInteropService(deps: GitInteropServiceDeps): ServiceDefinition {
  return {
    name: "gitInterop",
    description: "External Git interop: declared remotes and remote project imports",
    policy: { allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"] },
    methods: gitInteropMethods,
    handler: defineServiceHandler("gitInterop", gitInteropMethods, {
      setSharedRemote: async (ctx, [repoPath, remoteInput]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const normalizedRemote = validateWorkspaceGitRemote(remoteInput);

        await ensureSharedRemotePermission(ctx, deps, validRepoPath, "set", normalizedRemote);
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) =>
            setDeclaredRemoteInConfig(currentConfig, validRepoPath, normalizedRemote),
          summary: workspaceConfigRemoteSummary(validRepoPath, normalizedRemote, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        return persisted.nextConfig.git?.remotes ?? {};
      },

      removeSharedRemote: async (ctx, [repoPath, remoteName]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const existing = getRemoteForApproval(deps.workspaceConfig, validRepoPath, remoteName);

        await ensureSharedRemotePermission(ctx, deps, validRepoPath, "remove", existing);
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            const withoutRemote = removeDeclaredRemoteFromConfig(
              currentConfig,
              validRepoPath,
              remoteName
            );
            let currentUpstream: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
            try {
              currentUpstream = getDeclaredUpstreamForRepo(currentConfig, validRepoPath);
            } catch {
              currentUpstream = null;
            }
            return currentUpstream?.remote === existing.name
              ? removeDeclaredUpstreamFromConfig(withoutRemote, validRepoPath)
              : withoutRemote;
          },
          summary: workspaceConfigRemoteSummary(validRepoPath, existing, "remove"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        return persisted.nextConfig.git?.remotes ?? {};
      },

      setUpstream: async (ctx, [repoPath, upstreamInput]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const normalizedUpstream = validateWorkspaceGitUpstream(upstreamInput);
        const remote = getDeclaredRemoteForRepo(
          deps.workspaceConfig,
          validRepoPath,
          normalizedUpstream.remote
        );
        if (!remote) {
          throw new Error(
            `Upstream remote "${normalizedUpstream.remote}" is not declared for ${validRepoPath}`
          );
        }

        await ensureUpstreamPermission(ctx, deps, validRepoPath, "set", normalizedUpstream);
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            if (
              !getDeclaredRemoteForRepo(currentConfig, validRepoPath, normalizedUpstream.remote)
            ) {
              throw new Error(
                `Upstream remote "${normalizedUpstream.remote}" is not declared for ${validRepoPath}`
              );
            }
            return setDeclaredUpstreamInConfig(currentConfig, validRepoPath, normalizedUpstream);
          },
          summary: workspaceConfigUpstreamSummary(validRepoPath, normalizedUpstream, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      removeUpstream: async (ctx, [repoPath]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        // Tolerate an unresolvable declaration (e.g. its remote was already
        // removed) — removal must stay possible to clear a broken entry.
        let existing: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
        try {
          existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
        } catch {
          existing = null;
        }
        await ensureUpstreamPermission(ctx, deps, validRepoPath, "remove", existing);
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath),
          summary: workspaceConfigUpstreamSummary(validRepoPath, existing, "remove"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      setAutoPush: async (ctx, [repoPath, enabled]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
        if (!existing) throw new Error(`No upstream tracking is declared for ${validRepoPath}`);
        const nextUpstream: WorkspaceGitUpstreamConfig = {
          remote: existing.remote,
          ...(existing.branch ? { branch: existing.branch } : {}),
          autoPush: enabled,
          ...(existing.credentialId ? { credentialId: existing.credentialId } : {}),
          ...(existing.authorEmail ? { authorEmail: existing.authorEmail } : {}),
          ...(existing.authorName ? { authorName: existing.authorName } : {}),
        };

        await ensureUpstreamPermission(ctx, deps, validRepoPath, "set", nextUpstream);
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            const currentUpstream = getDeclaredUpstreamForRepo(currentConfig, validRepoPath);
            if (!currentUpstream) {
              throw new Error(`No upstream tracking is declared for ${validRepoPath}`);
            }
            return setDeclaredUpstreamInConfig(currentConfig, validRepoPath, {
              remote: currentUpstream.remote,
              branch: currentUpstream.branch,
              autoPush: enabled,
              ...(currentUpstream.credentialId
                ? { credentialId: currentUpstream.credentialId }
                : {}),
              ...(currentUpstream.authorEmail ? { authorEmail: currentUpstream.authorEmail } : {}),
              ...(currentUpstream.authorName ? { authorName: currentUpstream.authorName } : {}),
            });
          },
          summary: workspaceConfigUpstreamSummary(validRepoPath, nextUpstream, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      upstreamStatus: (ctx, args) => invokeGitProviderOperation(deps, ctx, "upstreamStatus", args),
      pushUpstream: (ctx, args) => invokeGitProviderOperation(deps, ctx, "pushUpstream", args),
      pullUpstream: (ctx, args) => invokeGitProviderOperation(deps, ctx, "pullUpstream", args),
      publishRepo: (ctx, args) => invokeGitProviderOperation(deps, ctx, "publishRepo", args),

      createDisposableRemote: (ctx, [options]) => {
        if (!deps.disposableRemotes) {
          throw new Error("Disposable Git remotes are unavailable on this host");
        }
        return deps.disposableRemotes.create(options);
      },

      publishToDisposableRemote: async (ctx, [repoPath, options]) => {
        if (!deps.disposableRemotes) {
          throw new Error("Disposable Git remotes are unavailable on this host");
        }
        const remote = await deps.disposableRemotes.create({
          name: "publish-check",
          ...(options?.branch ? { branch: options.branch } : {}),
        });
        try {
          const pushed = (await invokeGitProviderOperation(deps, ctx, "pushDisposableRemote", [
            { repoPath, url: remote.url, branch: remote.branch },
          ])) as { exported: number; pushed: boolean; headCommit: string | null };
          const received = await deps.disposableRemotes.inspect(remote.url);
          return {
            repoPath: normalizeWorkspaceRepoPath(repoPath),
            branch: remote.branch,
            exported: pushed.exported,
            pushed: pushed.pushed,
            commitCount: received.commitCount,
            headCommit: received.headCommit,
          };
        } finally {
          await deps.disposableRemotes.remove(remote.url).catch(() => undefined);
        }
      },

      pushDisposableRemote: async (ctx, [repoPath, url, branch]) => {
        if (!deps.disposableRemotes) {
          throw new Error("Disposable Git remotes are unavailable on this host");
        }
        const remote = await deps.disposableRemotes.inspect(url);
        if (remote.branch !== branch) {
          throw new Error(
            `Disposable Git remote branch mismatch: requested ${branch}, remote uses ${remote.branch}`
          );
        }
        const validRepoPath = normalizeWorkspaceRepoPath(repoPath);
        const pushed = (await invokeGitProviderOperation(deps, ctx, "pushDisposableRemote", [
          { repoPath: validRepoPath, url: remote.url, branch: remote.branch },
        ])) as { exported: number; pushed: boolean; headCommit: string | null };
        const received = await deps.disposableRemotes.inspect(remote.url);
        return {
          repoPath: validRepoPath,
          branch: remote.branch,
          exported: pushed.exported,
          pushed: pushed.pushed,
          commitCount: received.commitCount,
          headCommit: received.headCommit,
        };
      },

      inspectDisposableRemote: (_ctx, [url]) => {
        if (!deps.disposableRemotes) {
          throw new Error("Disposable Git remotes are unavailable on this host");
        }
        return deps.disposableRemotes.inspect(url);
      },

      removeDisposableRemote: (_ctx, [url]) => {
        if (!deps.disposableRemotes) {
          throw new Error("Disposable Git remotes are unavailable on this host");
        }
        return deps.disposableRemotes.remove(url);
      },

      commitMapping: (ctx, args) => invokeGitProviderOperation(deps, ctx, "commitMapping", args),
      detachUpstream: (ctx, [repoPath, options]) => detachUpstream(ctx, deps, repoPath, options),
      importProject: (ctx, [request]) => importWorkspaceRepo(ctx, deps, request),
      completeWorkspaceDependencies: (ctx, [options]) =>
        completeWorkspaceDependencies(ctx, deps, options),
    }),
  };
}

async function invokeGitProviderOperation<M extends GitInteropProviderOperation>(
  deps: Pick<GitInteropServiceDeps, "invokeGitProvider">,
  ctx: ServiceContext,
  method: M,
  args: unknown[]
): Promise<GitInteropProviderResult<M>> {
  const contract = gitInteropProviderMethods[method];
  const parsedArgs = contract.args.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid gitInterop.${method} arguments: ${parsedArgs.error.message}`);
  }
  const result = await invokeConfiguredGitProvider(
    deps,
    ctx,
    method,
    parsedArgs.data as GitInteropProviderArgs<M>
  );
  return result;
}

async function invokeConfiguredGitProvider<M extends GitInteropProviderMethod>(
  deps: Pick<GitInteropServiceDeps, "invokeGitProvider">,
  ctx: ServiceContext,
  method: M,
  args: GitInteropProviderArgs<M>
): Promise<GitInteropProviderResult<M>> {
  if (!deps.invokeGitProvider) {
    throw new Error("Git upstream provider is unavailable");
  }
  const contract = gitInteropProviderMethods[method];
  const parsedArgs = contract.args.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid gitInterop.${method} provider arguments: ${parsedArgs.error.message}`);
  }
  const result = await deps.invokeGitProvider(
    ctx,
    method,
    parsedArgs.data as GitInteropProviderArgs<M>
  );
  const parsedResult = contract.returns.safeParse(result);
  if (!parsedResult.success) {
    throw new Error(`Invalid gitInterop.${method} provider result: ${parsedResult.error.message}`);
  }
  return parsedResult.data as GitInteropProviderResult<M>;
}

/**
 * Remove upstream tracking (and optionally the declared remote) in ONE config
 * persist — never the two-call remove-upstream-then-remove-remote sequence
 * whose second half can be denied, leaving half-detached config reported as
 * success.
 */
async function detachUpstream(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  repoPath: string,
  options: GitDetachUpstreamOptions | undefined
): Promise<GitDetachUpstreamResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  let existing: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
  try {
    existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
  } catch {
    existing = null;
  }
  const forgetRemote = options?.forgetRemote === true;
  const remoteName = forgetRemote ? (options?.remote ?? existing?.remote ?? "origin") : null;

  await ensureUpstreamPermission(ctx, deps, validRepoPath, "remove", existing);
  if (forgetRemote && remoteName) {
    const remoteForApproval = getRemoteForApproval(deps.workspaceConfig, validRepoPath, remoteName);
    await ensureSharedRemotePermission(ctx, deps, validRepoPath, "remove", remoteForApproval);
  }
  const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
    mutate: (currentConfig) => {
      const withoutUpstream = removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath);
      return forgetRemote && remoteName
        ? removeDeclaredRemoteFromConfig(withoutUpstream, validRepoPath, remoteName)
        : withoutUpstream;
    },
    summary:
      workspaceConfigUpstreamSummary(validRepoPath, existing, "remove") +
      (forgetRemote && remoteName ? ` and removes remote ${remoteName}` : ""),
  });
  await propagateSharedRemote(deps, validRepoPath);
  return {
    upstreams: persisted.nextConfig.git?.upstreams ?? {},
    remotes: persisted.nextConfig.git?.remotes ?? {},
    removedRemote: forgetRemote ? remoteName : null,
  };
}

async function completeWorkspaceDependencies(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  options: GitCompleteWorkspaceDependenciesOptions | undefined
): Promise<GitCompleteWorkspaceDependenciesResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");

  const configuredRemotes = listConfiguredWorkspaceRemotes(deps.workspaceConfig);
  const result: GitCompleteWorkspaceDependenciesResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  const supported = configuredRemotes.filter((dependency) =>
    isSupportedImportRepoPath(dependency.path)
  );
  const statusRows =
    deps.invokeGitProvider && supported.length > 0
      ? await invokeConfiguredGitProvider(deps, ctx, "upstreamStatus", [
          supported.map((dependency) => dependency.path),
        ])
      : [];
  const statusByRepo = new Map(statusRows.map((row) => [row.repoPath, row]));

  for (const dependency of configuredRemotes) {
    if (!isSupportedImportRepoPath(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "unsupported-path" });
      continue;
    }
    const status = statusByRepo.get(dependency.path);
    if (!status) {
      result.failed.push({
        path: dependency.path,
        error: "Git provider did not report checkout materialization state",
      });
      continue;
    }
    if (status.state !== "not-materialized") {
      result.skipped.push({ path: dependency.path, reason: "already-materialized" });
      continue;
    }
    try {
      const imported = await importWorkspaceRepo(ctx, deps, {
        path: dependency.path,
        remote: dependency.remote,
        credentialId: options?.credentialId,
      });
      result.imported.push(imported);
    } catch (err) {
      result.failed.push({
        path: dependency.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

function listConfiguredWorkspaceRemotes(config: WorkspaceConfig): Array<{
  path: string;
  remote: WorkspaceGitRemoteConfig;
}> {
  return getDeclaredUpstreams(config).map((upstream) => {
    const remote = getDeclaredRemoteForRepo(config, upstream.repoPath, upstream.remote);
    if (!remote) {
      throw new Error(`Upstream remote "${upstream.remote}" disappeared for ${upstream.repoPath}`);
    }
    return {
      path: upstream.repoPath,
      remote: {
        name: remote.name,
        url: remote.url,
        ...(remote.branch ? { branch: remote.branch } : {}),
      },
    };
  });
}

async function importWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  request: GitImportProjectRequest
): Promise<GitImportedWorkspaceRepo> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.invokeGitProvider) throw new Error("Project import is unavailable");

  const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, request.path);
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  if (!isSupportedImportRepoPath(validRepoPath)) {
    throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
  }
  let normalizedRemote = validateWorkspaceGitRemote(request.remote);
  if (!normalizedRemote.branch) {
    // No branch declared: resolve the remote's ACTUAL default (ls-remote
    // symref HEAD) instead of assuming `main`, and bake it into the declared
    // config so every later clone/push/pull tracks the real branch.
    const discovered = await invokeConfiguredGitProvider(deps, ctx, "remoteDefaultBranch", [
      {
        url: normalizedRemote.url,
        ...(request.credentialId ? { credentialId: request.credentialId } : {}),
      },
    ]).catch(() => ({ branch: null }));
    if (discovered.branch) {
      normalizedRemote = { ...normalizedRemote, branch: discovered.branch };
    }
  }
  const mutateConfig: WorkspaceConfigMutation = (currentConfig) => {
    const withRemote = setDeclaredRemoteInConfig(currentConfig, validRepoPath, normalizedRemote);
    return setDeclaredUpstreamInConfig(withRemote, validRepoPath, {
      remote: normalizedRemote.name,
      branch: normalizedRemote.branch,
      autoPush: false,
      ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    });
  };

  await ensureWorkspaceConfigWritePermission(
    ctx,
    deps,
    validRepoPath,
    normalizedRemote,
    mutateConfig
  );
  const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
    mutate: mutateConfig,
    summary: workspaceConfigImportSummary(validRepoPath, normalizedRemote),
  });
  let candidate: GitImportResult;
  try {
    candidate = await invokeConfiguredGitProvider(deps, ctx, "cloneRepo", [
      { repoPath: validRepoPath },
    ]);
  } catch (err) {
    // Never leave a phantom declaration behind a failed clone: roll the
    // remote/upstream config back (when this call wrote it) and say exactly
    // what happened and how to retry.
    let rolledBack = false;
    if (persisted.changed) {
      try {
        await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) =>
            removeDeclaredRemoteFromConfig(
              removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath),
              validRepoPath,
              normalizedRemote.name
            ),
          summary: `meta/vibestudio.yml rolls back failed import of ${validRepoPath}`,
        });
        rolledBack = true;
      } catch {
        // The error below reports that the declaration survived. There is no
        // source-tree notification: config persistence already publishes its
        // own semantic mutation, while Git checkout bytes live in host state.
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Import of ${validRepoPath} failed during clone: ${detail}. ` +
        (rolledBack || !persisted.changed
          ? `Nothing was persisted — re-run the same import command to retry.`
          : `The remote/upstream declaration WAS persisted but could not be rolled back; ` +
            `\`vibestudio vcs git status\` will show it as not-materialized — re-run the same ` +
            `import command to finish, or \`vibestudio vcs git disable --repo ${validRepoPath} ` +
            `--forget-remote\` to remove it.`)
    );
  }
  return { path: validRepoPath, remote: normalizedRemote, candidate };
}

async function ensureWorkspaceConfigWritePermission(
  ctx: ServiceContext,
  deps: Pick<
    GitInteropServiceDeps,
    "workspaceConfig" | "workspaceConfigMutationWouldChange" | "approvalQueue" | "hasAppCapability"
  >,
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  mutateConfig: WorkspaceConfigMutation
): Promise<void> {
  if (!(await configMutationWouldChange(deps, mutateConfig))) return;
  if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do" &&
    ctx.caller.runtime.kind !== "extension"
  ) {
    throw new Error("Workspace config edit is unavailable for this caller");
  }
  const identity = ctx.caller.code;
  if (!identity) throw new Error("Workspace config edit requires a verified code identity");
  if (!deps.approvalQueue) throw new Error("Workspace config edit is unavailable");

  const decision = await deps.approvalQueue.request({
    kind: "unit-batch",
    callerId: ctx.caller.runtime.id,
    callerKind: ctx.caller.runtime.kind,
    ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    dedupKey: `git-import-config:${unitPath}:${remote.name}:${remote.url}:${remote.branch ?? ""}`,
    trigger: "meta-change",
    title: "Import external Git project",
    description: "This import adds an external Git project declaration to workspace config.",
    units: [],
    configWrite: {
      repoPath: "meta",
      summary: workspaceConfigImportSummary(unitPath, remote),
    },
  });
  if (decision === "deny") throw new Error("Workspace config edit denied");
}

async function ensureSharedRemotePermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "approvalQueue" | "grantStore" | "hasAppCapability">,
  unitPath: string,
  operation: "set" | "remove",
  remote: WorkspaceGitRemoteConfig | null
): Promise<void> {
  if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do" &&
    ctx.caller.runtime.kind !== "extension"
  ) {
    throw new Error("Shared remote configuration is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) {
    throw new Error("Shared remote configuration is unavailable");
  }
  const details = [
    {
      label: "Operation",
      value: operation === "set" ? "Add or update shared remote" : "Remove shared remote",
    },
    { label: "Workspace unit", value: unitPath },
  ];
  if (remote) {
    details.push({ label: "Remote name", value: remote.name });
    if (remote.url) details.push({ label: "Remote URL", value: displayRemoteUrl(remote.url) });
    if (remote.branch) details.push({ label: "Branch", value: remote.branch });
  }
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: SHARED_GIT_REMOTE_CAPABILITY,
      dedupKey: null,
      resource: { type: "git-remote", label: "Workspace unit", value: unitPath },
      operation: {
        kind: "git",
        verb: operation === "set" ? "Configure shared remote" : "Remove shared remote",
        object: { type: "git-remote", label: "Workspace unit", value: unitPath },
      },
      title:
        operation === "set"
          ? `Configure Git remote for ${unitPath}`
          : `Remove Git remote for ${unitPath}`,
      description:
        "Allow this code version to change the external Git remote shared by workspace contexts.",
      details,
      deniedReason: "Shared remote configuration denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Shared remote configuration denied");
  }
}

async function ensureUpstreamPermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "approvalQueue" | "grantStore" | "hasAppCapability">,
  unitPath: string,
  operation: "set" | "remove",
  upstream: Pick<WorkspaceGitUpstreamConfig, "remote" | "branch" | "autoPush"> | null
): Promise<void> {
  if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do" &&
    ctx.caller.runtime.kind !== "extension"
  ) {
    throw new Error("Upstream tracking configuration is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) {
    throw new Error("Upstream tracking configuration is unavailable");
  }
  const details = [
    {
      label: "Operation",
      value: operation === "set" ? "Track external Git remote" : "Remove upstream tracking",
    },
    { label: "Workspace unit", value: unitPath },
  ];
  if (upstream) {
    details.push({ label: "Remote", value: upstream.remote });
    if (upstream.branch) details.push({ label: "Branch", value: upstream.branch });
    details.push({ label: "Auto-push", value: upstream.autoPush ? "on" : "off" });
  }
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: GIT_UPSTREAM_CAPABILITY,
      dedupKey: null,
      resource: { type: "git-upstream", label: "Workspace unit", value: unitPath },
      operation: {
        kind: "git",
        verb: operation === "set" ? "Track external Git remote" : "Remove upstream tracking",
        object: { type: "git-upstream", label: "Workspace unit", value: unitPath },
      },
      title:
        operation === "set"
          ? `Track ${unitPath} on an external Git remote`
          : `Stop tracking ${unitPath} on an external Git remote`,
      description:
        "Allow this code version to change upstream tracking. No egress happens on approval; pushing prompts separately.",
      details,
      deniedReason: "Upstream tracking configuration denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Upstream tracking configuration denied");
  }
}

async function persistWorkspaceConfigMutation(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "workspaceConfig" | "persistWorkspaceConfigMutation">,
  input: {
    mutate: WorkspaceConfigMutation;
    summary: string;
  }
): Promise<WorkspaceConfigMutationResult> {
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.persistWorkspaceConfigMutation) {
    throw new Error("Workspace config persistence is unavailable");
  }
  const result = await deps.persistWorkspaceConfigMutation({
    ctx,
    mutate: input.mutate,
    summary: input.summary,
  });
  mutateWorkspaceConfig(deps.workspaceConfig, result.nextConfig);
  return result;
}

async function configMutationWouldChange(
  deps: Pick<GitInteropServiceDeps, "workspaceConfig" | "workspaceConfigMutationWouldChange">,
  mutate: WorkspaceConfigMutation
): Promise<boolean> {
  if (deps.workspaceConfigMutationWouldChange) {
    return await deps.workspaceConfigMutationWouldChange(mutate);
  }
  if (!deps.workspaceConfig) return true;
  const nextConfig = mutate(deps.workspaceConfig);
  return JSON.stringify(deps.workspaceConfig) !== JSON.stringify(nextConfig);
}

async function propagateSharedRemote(
  deps: Pick<GitInteropServiceDeps, "workspacePath" | "workspaceConfig">,
  repoPath: string
): Promise<void> {
  if (!deps.workspacePath || !deps.workspaceConfig) return;
  await syncDeclaredRemoteForRepo({
    config: deps.workspaceConfig,
    workspaceRoot: deps.workspacePath,
    repoPath,
  });
}

function mutateWorkspaceConfig(target: WorkspaceConfig, next: WorkspaceConfig): void {
  for (const key of Object.keys(target) as Array<keyof WorkspaceConfig>) {
    deleteDynamicProperty(target, key);
  }
  Object.assign(target, next);
}

function getRemoteForApproval(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string
): WorkspaceGitRemoteConfig {
  const normalizedRemoteName = validateWorkspaceGitRemoteName(remoteName);
  const remote = getDeclaredRemoteForRepo(config, repoPath, remoteName);
  return remote ? { name: remote.name, url: remote.url } : { name: normalizedRemoteName, url: "" };
}

function displayRemoteUrl(value: string): string {
  return normalizeRemoteUrl(value).replace(/^https?:\/\//, "");
}

function workspaceConfigImportSummary(unitPath: string, remote: WorkspaceGitRemoteConfig): string {
  const branch = remote.branch ? ` on ${remote.branch}` : "";
  return `meta/vibestudio.yml records ${remote.name}=${displayRemoteUrl(remote.url)} for ${unitPath}${branch}`;
}

function workspaceConfigRemoteSummary(
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  operation: "set" | "remove"
): string {
  if (operation === "remove") {
    return `meta/vibestudio.yml removes ${remote.name} for ${unitPath}`;
  }
  return workspaceConfigImportSummary(unitPath, remote);
}

function workspaceConfigUpstreamSummary(
  unitPath: string,
  upstream: Pick<WorkspaceGitUpstreamConfig, "remote" | "branch" | "autoPush"> | null,
  operation: "set" | "remove"
): string {
  if (operation === "remove") {
    return `meta/vibestudio.yml removes upstream tracking for ${unitPath}`;
  }
  const branch = upstream?.branch ? ` ${upstream.branch}` : "";
  const autoPush = upstream?.autoPush ? "auto-push on" : "auto-push off";
  return `meta/vibestudio.yml tracks ${unitPath} on ${upstream?.remote ?? "origin"}${branch} (${autoPush})`;
}
