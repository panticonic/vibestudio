import * as fs from "fs";
import { randomUUID } from "node:crypto";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { PreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";
import {
  getDeclaredUpstreamForRepo,
  getDeclaredRemoteForRepo,
  getDeclaredRemotesForRepo,
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
  assertWorkspaceCreateTargetSafe,
  isSupportedImportRepoPath,
  resolveWorkspaceRepoPath,
} from "@vibestudio/workspace/pathPolicy";
import {
  gitInteropMethods,
  gitInteropProviderMethods,
  GIT_UPSTREAM_CAPABILITY,
  SHARED_GIT_REMOTE_CAPABILITY,
  type GitCompleteWorkspaceDependenciesOptions,
  type GitCompleteWorkspaceDependenciesResult,
  type GitDetachUpstreamOptions,
  type GitDetachUpstreamResult,
  type GitImportedWorkspaceRepo,
  type GitImportProjectRequest,
  type GitInteropProviderArgs,
  type GitInteropProviderMethod,
  type GitInteropProviderOperation,
  type GitInteropProviderResult,
} from "@vibestudio/service-schemas/gitInterop";
import type { DisposableGitRemoteManager } from "./disposableGitRemoteManager.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { deleteDynamicProperty } from "../../lintHelpers";
import { GitImportJournal, type GitImportJournalRecord } from "./gitImportJournal.js";

/**
 * Structural slice of the host's workspace source-tree scanner. Declared
 * locally so this service — a pure host policy/dispatch boundary (approvals,
 * egress clone, config writes) — carries NO dependency on the gad layer's
 * module layout.
 */
type WorkspaceTreeScannerLike = {
  getSourceTree(): Promise<{ children: WorkspaceTreeNode[] }>;
  invalidate(): void;
};

type GitInteropServiceDeps = {
  treeScanner: WorkspaceTreeScannerLike;
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  approvalQueue?: ApprovalQueue;
  onWorkspaceSourceChanged?: (
    ctx: ServiceContext,
    summary: string,
    importedRepoPath?: string
  ) => Promise<string | null | undefined>;
  workspaceConfigMutationWouldChange?: (mutate: WorkspaceConfigMutation) => Promise<boolean>;
  persistWorkspaceConfigMutation?: (input: {
    ctx: ServiceContext;
    mutate: WorkspaceConfigMutation;
    summary: string;
    operation: "push" | "import";
  }) => Promise<WorkspaceConfigMutationResult>;
  /** Provider-owned Git transport operations. Host owns policy and config writes. */
  invokeGitProvider?: <M extends GitInteropProviderMethod>(
    ctx: ServiceContext,
    method: M,
    args: GitInteropProviderArgs<M>
  ) => Promise<GitInteropProviderResult<M>>;
  disposableRemotes?: Pick<DisposableGitRemoteManager, "create" | "inspect" | "remove">;
  importJournal: GitImportJournal;
};

type WorkspaceConfigMutation = (currentConfig: WorkspaceConfig) => WorkspaceConfig;
type WorkspaceConfigMutationResult = { changed: boolean; nextConfig: WorkspaceConfig };

type WorkspaceTreeNode = {
  path: string;
  isUnit: boolean;
  children: WorkspaceTreeNode[];
};

export function createGitInteropService(deps: GitInteropServiceDeps): ServiceDefinition {
  return {
    name: "gitInterop",
    description: "External Git interop: declared remotes and remote project imports",
    authority: { principals: ["user", "code", "host"] },
    methods: gitInteropMethods,
    authorityPreparation: {
      "gitInterop.setSharedRemote": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        const remote = validateWorkspaceGitRemote(args[1] as WorkspaceGitRemoteConfig);
        return await prepareSharedRemotePermission(ctx, unitPath, "set", remote);
      },
      "gitInterop.removeSharedRemote": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        const remoteName = String(args[1]);
        const remote = getRemoteForApproval(requireWorkspaceConfig(deps), unitPath, remoteName);
        return await prepareSharedRemotePermission(ctx, unitPath, "remove", remote);
      },
      "gitInterop.setUpstream": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        const upstream = validateWorkspaceGitUpstream(args[1] as WorkspaceGitUpstreamConfig);
        return await prepareUpstreamPermission(ctx, unitPath, "set", upstream);
      },
      "gitInterop.removeUpstream": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        return await prepareUpstreamPermission(
          ctx,
          unitPath,
          "remove",
          getUpstreamForApproval(requireWorkspaceConfig(deps), unitPath)
        );
      },
      "gitInterop.setAutoPush": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        const existing = getUpstreamForApproval(requireWorkspaceConfig(deps), unitPath);
        if (!existing) throw new Error(`No upstream tracking is declared for ${unitPath}`);
        return await prepareUpstreamPermission(ctx, unitPath, "set", {
          remote: existing.remote,
          ...(existing.branch ? { branch: existing.branch } : {}),
          autoPush: Boolean(args[1]),
        });
      },
      "gitInterop.detachUpstream": async (ctx, args) => {
        const unitPath = resolvePermissionUnitPath(deps, args[0]);
        const config = requireWorkspaceConfig(deps);
        const existing = getUpstreamForApproval(config, unitPath);
        const options = args[1] as GitDetachUpstreamOptions | undefined;
        const selections = await prepareUpstreamPermission(ctx, unitPath, "remove", existing);
        if (options?.forgetRemote === true) {
          const remoteName = options.remote ?? existing?.remote ?? "origin";
          selections.push(
            ...(await prepareSharedRemotePermission(
              ctx,
              unitPath,
              "remove",
              getRemoteForApproval(config, unitPath, remoteName)
            ))
          );
        }
        return selections;
      },
    },
    handler: defineServiceHandler("gitInterop", gitInteropMethods, {
      setSharedRemote: async (ctx, [repoPath, remoteInput]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const normalizedRemote = validateWorkspaceGitRemote(remoteInput);

        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) =>
            setDeclaredRemoteInConfig(currentConfig, validRepoPath, normalizedRemote),
          summary: workspaceConfigRemoteSummary(validRepoPath, normalizedRemote, "set"),
          operation: "push",
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
          operation: "push",
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
          operation: "push",
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
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath),
          summary: workspaceConfigUpstreamSummary(validRepoPath, existing, "remove"),
          operation: "push",
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
          operation: "push",
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

      resetExportMarker: (ctx, args) =>
        invokeGitProviderOperation(deps, ctx, "resetExportMarker", args),
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
    operation: "push",
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

  const tree = await deps.treeScanner.getSourceTree();
  const existingUnits = collectWorkspaceUnitPaths(tree.children as WorkspaceTreeNode[]);
  const configuredRemotes = listConfiguredWorkspaceRemotes(deps.workspaceConfig);
  const result: GitCompleteWorkspaceDependenciesResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  for (const dependency of configuredRemotes) {
    if (!isSupportedImportRepoPath(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "unsupported-path" });
      continue;
    }
    if (existingUnits.has(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "already-present" });
      continue;
    }
    try {
      const imported = await importWorkspaceRepo(ctx, deps, {
        path: dependency.path,
        remote: dependency.remote,
        credentialId: options?.credentialId,
      });
      result.imported.push(imported);
      existingUnits.add(imported.path);
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
  const entries: Array<{ path: string; remote: WorkspaceGitRemoteConfig }> = [];
  for (const [section, units] of Object.entries(config.git?.remotes ?? {})) {
    for (const unitKey of Object.keys(units ?? {})) {
      const unitPath = normalizeWorkspaceRepoPath(unitKey ? `${section}/${unitKey}` : section);
      const remotes = getDeclaredRemotesForRepo(config, unitPath).sort((a, b) => {
        if (a.name === "origin") return -1;
        if (b.name === "origin") return 1;
        return a.name.localeCompare(b.name);
      });
      const cloneRemote = remotes[0];
      if (cloneRemote) {
        entries.push({
          path: unitPath,
          remote: {
            name: cloneRemote.name,
            url: cloneRemote.url,
            ...(cloneRemote.branch ? { branch: cloneRemote.branch } : {}),
          },
        });
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function collectWorkspaceUnitPaths(nodes: WorkspaceTreeNode[]): Set<string> {
  const units = new Set<string>();
  for (const node of nodes) {
    if (node.isUnit) units.add(node.path);
    for (const childPath of collectWorkspaceUnitPaths(node.children)) {
      units.add(childPath);
    }
  }
  return units;
}

async function importWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  request: GitImportProjectRequest
): Promise<GitImportedWorkspaceRepo> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.invokeGitProvider) throw new Error("Project import is unavailable");

  const { absolutePath, normalizedRepoPath } = resolveWorkspaceRepoPath(
    deps.workspacePath,
    request.path
  );
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  if (!isSupportedImportRepoPath(validRepoPath)) {
    throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
  }
  assertWorkspaceCreateTargetSafe(deps.workspacePath, absolutePath, "importProject");
  const journal = deps.importJournal;
  const callerKey = `${ctx.caller.runtime.kind}:${ctx.caller.runtime.id}`;
  const requestedRemote = validateWorkspaceGitRemote(request.remote);
  const active = journal.activeForRepo(validRepoPath);
  if (
    active &&
    (active.callerKey !== callerKey || !sameRequestedRemote(active.remote, requestedRemote))
  ) {
    throw new Error(
      `Import ${active.operationId} already owns ${validRepoPath} in phase ${active.phase}`
    );
  }
  if (!active && fs.existsSync(absolutePath))
    throw new Error(`Path already exists: ${request.path}`);
  // A resumed operation uses the branch sealed into its journal. Re-running
  // remote discovery would make recovery depend on mutable/unavailable network
  // state after preparation or commit.
  let normalizedRemote: WorkspaceGitRemoteConfig = active?.remote ?? requestedRemote;
  if (!normalizedRemote.branch) {
    // No branch declared: resolve the remote's ACTUAL default (ls-remote
    // symref HEAD) instead of assuming `main`, and bake it into the declared
    // config so every later clone/push/pull tracks the real branch.
    const discovered = await invokeConfiguredGitProvider(deps, ctx, "remoteDefaultBranch", [
      {
        url: normalizedRemote.url,
        ...(request.credentialId ? { credentialId: request.credentialId } : {}),
      },
    ]);
    if (!discovered.branch) {
      throw new Error(
        `Cannot import ${validRepoPath}: the remote has no concrete default branch. ` +
          `Create an initial branch upstream or name an existing branch explicitly.`
      );
    }
    normalizedRemote = { ...normalizedRemote, branch: discovered.branch };
  }
  if (!normalizedRemote.branch) throw new Error("Git import requires a concrete branch");
  const exactRemote = normalizedRemote as WorkspaceGitRemoteConfig & { branch: string };
  const mutateConfig: WorkspaceConfigMutation = (currentConfig) => {
    const withRemote = setDeclaredRemoteInConfig(currentConfig, validRepoPath, exactRemote);
    return setDeclaredUpstreamInConfig(withRemote, validRepoPath, {
      remote: exactRemote.name,
      branch: exactRemote.branch,
      autoPush: false,
      ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    });
  };

  await ensureWorkspaceConfigWritePermission(ctx, deps, validRepoPath, exactRemote, mutateConfig);
  const now = Date.now();
  let operation: GitImportJournalRecord = active ?? {
    version: 1,
    operationId: randomUUID(),
    phase: "requested",
    callerKey,
    repoPath: validRepoPath,
    remote: exactRemote,
    ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    requestedAt: now,
    updatedAt: now,
  };
  journal.put(operation);

  const save = (patch: Partial<GitImportJournalRecord>): void => {
    operation = { ...operation, ...patch, updatedAt: Date.now() };
    journal.put(operation);
  };

  if (!operation.prepared) {
    save({ phase: "preparing" });
    try {
      const prepared = await invokeConfiguredGitProvider(deps, ctx, "prepareImport", [
        {
          operationId: operation.operationId,
          repoPath: validRepoPath,
          remote: exactRemote,
          ...(request.credentialId ? { credentialId: request.credentialId } : {}),
        },
      ]);
      save({
        phase: "prepared",
        prepared: {
          gitCommitSha: prepared.gitCommitSha,
          stateHash: prepared.stateHash,
          changed: prepared.changed,
        },
      });
    } catch (error) {
      await invokeConfiguredGitProvider(deps, ctx, "abortImport", [
        { operationId: operation.operationId },
      ]).catch(() => undefined);
      save({ phase: "aborted", finalizationError: errorMessage(error) });
      throw new Error(
        `Import ${operation.operationId} of ${validRepoPath} failed during preparation: ${errorMessage(error)}`
      );
    }
  }

  if (!operation.config) {
    const priorRemote = declaredRemoteConfig(deps.workspaceConfig, validRepoPath, exactRemote.name);
    const priorUpstream = safeDeclaredUpstream(deps.workspaceConfig, validRepoPath);
    const writtenUpstream: WorkspaceGitUpstreamConfig & { branch: string } = {
      remote: exactRemote.name,
      branch: exactRemote.branch,
      autoPush: false,
      ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    };
    save({
      phase: "configuring",
      config: {
        priorRemote,
        priorUpstream,
        writtenRemote: exactRemote,
        writtenUpstream,
      },
    });
    try {
      await persistWorkspaceConfigMutation(ctx, deps, {
        mutate: (current) => {
          assertImportConfigPreimage(current, validRepoPath, exactRemote.name, {
            remote: priorRemote,
            upstream: priorUpstream,
          });
          return mutateConfig(current);
        },
        summary: workspaceConfigImportSummary(validRepoPath, exactRemote),
        operation: "import",
      });
      save({ phase: "committing" });
    } catch (error) {
      await invokeConfiguredGitProvider(deps, ctx, "abortImport", [
        { operationId: operation.operationId },
      ]).catch(() => undefined);
      save({ phase: "aborted", finalizationError: errorMessage(error) });
      throw error;
    }
  }

  if (
    operation.phase !== "committed" &&
    operation.phase !== "adopting" &&
    operation.phase !== "committed-incomplete"
  ) {
    assertImportConfigOwned(deps.workspaceConfig, operation);
    save({ phase: "committing" });
    try {
      const committed = await invokeConfiguredGitProvider(deps, ctx, "commitImport", [
        { operationId: operation.operationId },
      ]);
      if (committed.phase !== "committed" && committed.phase !== "complete") {
        throw new Error(`provider returned non-committed phase ${committed.phase}`);
      }
      save({ phase: "committed" });
    } catch (commitError) {
      save({ phase: "commit-outcome-unknown", finalizationError: errorMessage(commitError) });
      const status = await invokeConfiguredGitProvider(deps, ctx, "inspectImport", [
        { operationId: operation.operationId },
      ]).catch(() => null);
      if (status?.phase === "committed" || status?.phase === "complete") {
        save({ phase: "committed" });
      } else if (status?.phase === "prepared") {
        try {
          await compensateImportConfig(ctx, deps, operation);
          await invokeConfiguredGitProvider(deps, ctx, "abortImport", [
            { operationId: operation.operationId },
          ]);
          save({ phase: "aborted" });
        } catch (compensationError) {
          save({
            phase: "requires-repair",
            compensationError: errorMessage(compensationError),
          });
          throw new Error(
            `Import ${operation.operationId} did not commit, and compensation failed: ` +
              `${errorMessage(commitError)}; compensation: ${errorMessage(compensationError)}`
          );
        }
        throw new Error(
          `Import ${operation.operationId} did not commit: ${errorMessage(commitError)}; prior configuration was restored`
        );
      } else {
        save({ phase: "requires-repair" });
        throw new Error(
          `Import ${operation.operationId} has an unknown commit outcome and requires repair: ${errorMessage(commitError)}`
        );
      }
    }
  }

  save({ phase: "adopting" });
  try {
    const finalized = await invokeConfiguredGitProvider(deps, ctx, "finalizeImport", [
      { operationId: operation.operationId },
    ]);
    if (finalized.phase !== "complete") {
      throw new Error(finalized.error ?? `provider finalization is ${finalized.phase}`);
    }
    deps.treeScanner.invalidate();
    const adoptedContextId =
      (await notifyWorkspaceSourceChanged(
        ctx,
        deps,
        `Import workspace project ${validRepoPath}`,
        validRepoPath
      )) ?? null;
    save({ phase: "complete", adoptedContextId, finalizationError: undefined });
  } catch (error) {
    save({ phase: "committed-incomplete", finalizationError: errorMessage(error) });
    throw new Error(
      `Import ${operation.operationId} committed protected main but finalization is incomplete: ${errorMessage(error)}. Retry the same import to resume.`
    );
  }

  const prepared = operation.prepared;
  if (!prepared) {
    throw new Error(`Import ${operation.operationId} completed without a prepared source state`);
  }
  return {
    operationId: operation.operationId,
    phase: "complete",
    path: validRepoPath,
    remote: {
      name: exactRemote.name,
      urlIdentity: remoteUrlIdentity(exactRemote.url),
      branch: exactRemote.branch,
    },
    stateHash: prepared.stateHash,
    gitCommitSha: prepared.gitCommitSha,
    changed: prepared.changed,
    adoptedContextId: operation.adoptedContextId ?? null,
  };
}

async function ensureWorkspaceConfigWritePermission(
  ctx: ServiceContext,
  deps: Pick<
    GitInteropServiceDeps,
    "workspaceConfig" | "workspaceConfigMutationWouldChange" | "approvalQueue"
  >,
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  mutateConfig: WorkspaceConfigMutation
): Promise<void> {
  if (!(await configMutationWouldChange(deps, mutateConfig))) return;
  if (await hasPanelHostingAuthority(ctx)) return;
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
    executionDigest: identity.executionDigest,
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

async function prepareSharedRemotePermission(
  ctx: ServiceContext,
  unitPath: string,
  operation: "set" | "remove",
  remote: WorkspaceGitRemoteConfig | null
): Promise<PreparedAuthoritySelection[]> {
  if (await hasPanelHostingAuthority(ctx)) return [];
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do" &&
    ctx.caller.runtime.kind !== "extension"
  ) {
    throw new Error("Shared remote configuration is unavailable for this caller");
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
  return [
    {
      capability: SHARED_GIT_REMOTE_CAPABILITY,
      resourceKey: unitPath,
      challenge: {
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
      },
    },
  ];
}

async function prepareUpstreamPermission(
  ctx: ServiceContext,
  unitPath: string,
  operation: "set" | "remove",
  upstream: Pick<WorkspaceGitUpstreamConfig, "remote" | "branch" | "autoPush"> | null
): Promise<PreparedAuthoritySelection[]> {
  if (await hasPanelHostingAuthority(ctx)) return [];
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do" &&
    ctx.caller.runtime.kind !== "extension"
  ) {
    throw new Error("Upstream tracking configuration is unavailable for this caller");
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
  return [
    {
      capability: GIT_UPSTREAM_CAPABILITY,
      resourceKey: unitPath,
      challenge: {
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
      },
    },
  ];
}

function requireWorkspaceConfig(deps: GitInteropServiceDeps): WorkspaceConfig {
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  return deps.workspaceConfig;
}

function resolvePermissionUnitPath(deps: GitInteropServiceDeps, value: unknown): string {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (typeof value !== "string") throw new Error("Workspace unit path must be a string");
  const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, value);
  return normalizeWorkspaceRepoPath(normalizedRepoPath);
}

function getUpstreamForApproval(
  config: WorkspaceConfig,
  unitPath: string
): ReturnType<typeof getDeclaredUpstreamForRepo> {
  try {
    return getDeclaredUpstreamForRepo(config, unitPath);
  } catch {
    return null;
  }
}

async function persistWorkspaceConfigMutation(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "workspaceConfig" | "persistWorkspaceConfigMutation">,
  input: {
    mutate: WorkspaceConfigMutation;
    summary: string;
    operation: "push" | "import";
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
    operation: input.operation,
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

async function notifyWorkspaceSourceChanged(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "onWorkspaceSourceChanged">,
  summary: string,
  importedRepoPath?: string
): Promise<string | null | undefined> {
  return await deps.onWorkspaceSourceChanged?.(ctx, summary, importedRepoPath);
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

function sameRequestedRemote(
  active: WorkspaceGitRemoteConfig & { branch: string },
  requested: WorkspaceGitRemoteConfig
): boolean {
  return (
    active.name === requested.name &&
    normalizeRemoteUrl(active.url) === normalizeRemoteUrl(requested.url) &&
    (requested.branch === undefined || requested.branch === active.branch)
  );
}

function safeDeclaredUpstream(
  config: WorkspaceConfig,
  repoPath: string
): WorkspaceGitUpstreamConfig | null {
  const [section, ...rest] = normalizeWorkspaceRepoPath(repoPath).split("/");
  if (!section) return null;
  const value = config.git?.upstreams?.[section]?.[rest.join("/")];
  return value ? structuredClone(value) : null;
}

function declaredRemoteConfig(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string
): WorkspaceGitRemoteConfig | null {
  const [section, ...rest] = normalizeWorkspaceRepoPath(repoPath).split("/");
  if (!section) return null;
  const declaration = config.git?.remotes?.[section]?.[rest.join("/")]?.[remoteName];
  return declaration
    ? {
        name: remoteName,
        url: declaration.url,
        ...(declaration.branch ? { branch: declaration.branch } : {}),
      }
    : null;
}

function assertImportConfigPreimage(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string,
  expected: {
    remote: WorkspaceGitRemoteConfig | null;
    upstream: WorkspaceGitUpstreamConfig | null;
  }
): void {
  const currentRemote = declaredRemoteConfig(config, repoPath, remoteName);
  const currentUpstream = safeDeclaredUpstream(config, repoPath);
  if (
    !sameConfigValue(currentRemote, expected.remote) ||
    !sameConfigValue(currentUpstream, expected.upstream)
  ) {
    throw new Error(
      `Git import configuration preimage changed concurrently for ${repoPath}; no fields were overwritten`
    );
  }
}

function assertImportConfigOwned(config: WorkspaceConfig, operation: GitImportJournalRecord): void {
  if (!operation.config)
    throw new Error(`Git import ${operation.operationId} has no config journal`);
  const currentRemote = declaredRemoteConfig(
    config,
    operation.repoPath,
    operation.config.writtenRemote.name
  );
  const currentUpstream = safeDeclaredUpstream(config, operation.repoPath);
  if (
    !sameConfigValue(currentRemote, operation.config.writtenRemote) ||
    !sameConfigValue(currentUpstream, operation.config.writtenUpstream)
  ) {
    throw new Error(
      `Git import ${operation.operationId} no longer owns its configuration write for ${operation.repoPath}`
    );
  }
}

async function compensateImportConfig(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  operation: GitImportJournalRecord
): Promise<void> {
  const ownedConfig = operation.config;
  if (!ownedConfig) return;
  await persistWorkspaceConfigMutation(ctx, deps, {
    mutate: (current) => {
      assertImportConfigOwned(current, operation);
      let next = ownedConfig.priorRemote
        ? setDeclaredRemoteInConfig(current, operation.repoPath, ownedConfig.priorRemote)
        : removeDeclaredRemoteFromConfig(
            current,
            operation.repoPath,
            ownedConfig.writtenRemote.name
          );
      next = ownedConfig.priorUpstream
        ? setDeclaredUpstreamInConfig(next, operation.repoPath, ownedConfig.priorUpstream)
        : removeDeclaredUpstreamFromConfig(next, operation.repoPath);
      return next;
    },
    summary: `meta/vibestudio.yml restores the exact pre-import Git configuration for ${operation.repoPath}`,
    operation: "import",
  });
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteUrlIdentity(value: string): string {
  try {
    const parsed = new URL(normalizeRemoteUrl(value));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "redacted-remote";
  }
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
