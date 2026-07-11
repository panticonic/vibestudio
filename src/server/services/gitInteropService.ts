import * as fs from "fs";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/shared/workspace/types";
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
} from "@vibestudio/shared/workspace/remotes";
import {
  WORKSPACE_IMPORT_PARENT_DIRS,
  assertWorkspaceCreateTargetSafe,
  isSupportedImportRepoPath,
  resolveWorkspaceRepoPath,
} from "@vibestudio/shared/workspace/pathPolicy";
import { gitInteropMethods } from "@vibestudio/shared/serviceSchemas/gitInterop";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { deleteDynamicProperty } from "../../lintHelpers";
import { isAuthorizedChrome } from "./chromeTrust.js";

const SHARED_GIT_REMOTE_CAPABILITY = "workspace-shared-git-remote";
const GIT_UPSTREAM_CAPABILITY = "workspace-git-upstream";

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
  grantStore?: CapabilityGrantStore;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  onWorkspaceSourceChanged?: (ctx: ServiceContext, summary: string) => Promise<void>;
  workspaceConfigWouldChange?: (nextConfig: WorkspaceConfig) => Promise<boolean>;
  persistWorkspaceConfig?: (input: {
    ctx: ServiceContext;
    nextConfig: WorkspaceConfig;
    summary: string;
    operation: "push" | "import";
  }) => Promise<boolean>;
  /** Provider-owned clone/import operation. Host owns only policy + config writes. */
  cloneRepo?: (ctx: ServiceContext, repoPath: string) => Promise<void>;
  /** Provider-owned upstream Git engine operations. */
  invokeGitProvider?: <T>(ctx: ServiceContext, method: string, args: unknown[]) => Promise<T>;
};

type WorkspaceTreeNode = {
  path: string;
  isUnit: boolean;
  children: WorkspaceTreeNode[];
};

type ImportWorkspaceRepoRequest = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
  branch?: string;
  credentialId?: string;
};

type ImportedWorkspaceRepo = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
};

type CompleteWorkspaceDependenciesResult = {
  imported: ImportedWorkspaceRepo[];
  skipped: Array<{
    path: string;
    reason: "already-present" | "unsupported-path";
  }>;
  failed: Array<{
    path: string;
    error: string;
  }>;
};

export function createGitInteropService(deps: GitInteropServiceDeps): ServiceDefinition {
  return {
    name: "gitInterop",
    description: "External Git interop: declared remotes and remote project imports",
    policy: { allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"] },
    methods: gitInteropMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "setSharedRemote": {
          const [repoPath, remoteInput] = args as [string, WorkspaceGitRemoteConfig];
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
          const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
          const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
          const normalizedRemote = validateWorkspaceGitRemote(remoteInput);

          await ensureSharedRemotePermission(ctx, deps, validRepoPath, "set", normalizedRemote);
          const nextConfig = setDeclaredRemoteInConfig(
            deps.workspaceConfig,
            validRepoPath,
            normalizedRemote
          );
          await persistWorkspaceConfigChange(ctx, deps, {
            nextConfig,
            summary: workspaceConfigRemoteSummary(validRepoPath, normalizedRemote, "set"),
            operation: "push",
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.remotes;
        }

        case "removeSharedRemote": {
          const [repoPath, remoteName] = args as [string, string];
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
          const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
          const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
          const existing = getRemoteForApproval(deps.workspaceConfig, validRepoPath, remoteName);

          await ensureSharedRemotePermission(ctx, deps, validRepoPath, "remove", existing);
          const withoutRemote = removeDeclaredRemoteFromConfig(
            deps.workspaceConfig,
            validRepoPath,
            remoteName
          );
          const existingUpstream = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
          const nextConfig =
            existingUpstream?.remote === existing.name
              ? removeDeclaredUpstreamFromConfig(withoutRemote, validRepoPath)
              : withoutRemote;
          await persistWorkspaceConfigChange(ctx, deps, {
            nextConfig,
            summary: workspaceConfigRemoteSummary(validRepoPath, existing, "remove"),
            operation: "push",
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.remotes;
        }

        case "setUpstream": {
          const [repoPath, upstreamInput] = args as [string, WorkspaceGitUpstreamConfig];
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
          const nextConfig = setDeclaredUpstreamInConfig(
            deps.workspaceConfig,
            validRepoPath,
            normalizedUpstream
          );
          await persistWorkspaceConfigChange(ctx, deps, {
            nextConfig,
            summary: workspaceConfigUpstreamSummary(validRepoPath, normalizedUpstream, "set"),
            operation: "push",
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.upstreams;
        }

        case "removeUpstream": {
          const [repoPath] = args as [string];
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
          const nextConfig = removeDeclaredUpstreamFromConfig(deps.workspaceConfig, validRepoPath);
          await persistWorkspaceConfigChange(ctx, deps, {
            nextConfig,
            summary: workspaceConfigUpstreamSummary(validRepoPath, existing, "remove"),
            operation: "push",
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.upstreams;
        }

        case "setAutoPush": {
          const [repoPath, enabledInput] = args as [string, boolean | undefined];
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
          const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
          const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
          const existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
          if (!existing) throw new Error(`No upstream tracking is declared for ${validRepoPath}`);
          const enabled = enabledInput !== false;
          const nextUpstream: WorkspaceGitUpstreamConfig = {
            remote: existing.remote,
            ...(existing.branch ? { branch: existing.branch } : {}),
            autoPush: enabled,
            ...(existing.credentialId ? { credentialId: existing.credentialId } : {}),
            ...(existing.authorEmail ? { authorEmail: existing.authorEmail } : {}),
            ...(existing.authorName ? { authorName: existing.authorName } : {}),
          };

          await ensureUpstreamPermission(ctx, deps, validRepoPath, "set", nextUpstream);
          const nextConfig = setDeclaredUpstreamInConfig(
            deps.workspaceConfig,
            validRepoPath,
            nextUpstream
          );
          await persistWorkspaceConfigChange(ctx, deps, {
            nextConfig,
            summary: workspaceConfigUpstreamSummary(validRepoPath, nextUpstream, "set"),
            operation: "push",
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.upstreams;
        }

        case "upstreamStatus": {
          return invokeGitProvider(deps, ctx, "upstreamStatus", args);
        }

        case "pushUpstream": {
          return invokeGitProvider(deps, ctx, "pushUpstream", args);
        }

        case "pullUpstream": {
          return invokeGitProvider(deps, ctx, "pullUpstream", args);
        }

        case "publishRepo": {
          return invokeGitProvider(deps, ctx, "publishRepo", args);
        }

        case "importProject": {
          const [request] = args as [ImportWorkspaceRepoRequest];
          return importWorkspaceRepo(ctx, deps, request);
        }

        case "completeWorkspaceDependencies": {
          const [options] = args as [{ credentialId?: string } | undefined];
          return completeWorkspaceDependencies(ctx, deps, options);
        }

        default:
          throw new Error(`Unknown gitInterop method: ${method}`);
      }
    },
  };
}

async function invokeGitProvider<T>(
  deps: Pick<GitInteropServiceDeps, "invokeGitProvider">,
  ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<T> {
  if (!deps.invokeGitProvider) {
    throw new Error("Git upstream provider is unavailable");
  }
  return deps.invokeGitProvider<T>(ctx, method, args);
}

async function completeWorkspaceDependencies(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  options: { credentialId?: string } | undefined
): Promise<CompleteWorkspaceDependenciesResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");

  const tree = await deps.treeScanner.getSourceTree();
  const existingUnits = collectWorkspaceUnitPaths(tree.children as WorkspaceTreeNode[]);
  const configuredRemotes = listConfiguredWorkspaceRemotes(deps.workspaceConfig);
  const result: CompleteWorkspaceDependenciesResult = {
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
      if (cloneRemote) entries.push({ path: unitPath, remote: cloneRemote });
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
  request: ImportWorkspaceRepoRequest
): Promise<ImportedWorkspaceRepo> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.cloneRepo) throw new Error("Project import is unavailable");

  const { absolutePath, normalizedRepoPath } = resolveWorkspaceRepoPath(
    deps.workspacePath,
    request.path
  );
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  if (!isSupportedImportRepoPath(validRepoPath)) {
    throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
  }
  if (fs.existsSync(absolutePath)) throw new Error(`Path already exists: ${request.path}`);
  assertWorkspaceCreateTargetSafe(deps.workspacePath, absolutePath, "importProject");
  const normalizedRemote = validateWorkspaceGitRemote({
    ...request.remote,
    branch: request.branch ?? request.remote.branch,
  });
  const withRemote = setDeclaredRemoteInConfig(
    deps.workspaceConfig,
    validRepoPath,
    normalizedRemote
  );
  const nextConfig = setDeclaredUpstreamInConfig(withRemote, validRepoPath, {
    remote: normalizedRemote.name,
    branch: normalizedRemote.branch,
    autoPush: false,
    ...(request.credentialId ? { credentialId: request.credentialId } : {}),
  });

  await ensureWorkspaceConfigWritePermission(
    ctx,
    deps,
    validRepoPath,
    normalizedRemote,
    nextConfig
  );
  const configChanged = await persistWorkspaceConfigChange(ctx, deps, {
    nextConfig,
    summary: workspaceConfigImportSummary(validRepoPath, normalizedRemote),
    operation: "import",
  });
  try {
    await deps.cloneRepo(ctx, validRepoPath);
  } catch (err) {
    if (configChanged) {
      await notifyWorkspaceSourceChanged(ctx, deps, `Record Git remote for ${validRepoPath}`);
    }
    throw err;
  }
  deps.treeScanner.invalidate();
  await notifyWorkspaceSourceChanged(ctx, deps, `Import workspace project ${validRepoPath}`);
  return { path: validRepoPath, remote: normalizedRemote };
}

async function ensureWorkspaceConfigWritePermission(
  ctx: ServiceContext,
  deps: Pick<
    GitInteropServiceDeps,
    "workspaceConfig" | "workspaceConfigWouldChange" | "approvalQueue" | "hasAppCapability"
  >,
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  nextConfig: WorkspaceConfig
): Promise<void> {
  if (!(await configWouldChange(deps, nextConfig))) return;
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

async function persistWorkspaceConfigChange(
  ctx: ServiceContext,
  deps: Pick<
    GitInteropServiceDeps,
    "workspaceConfig" | "workspaceConfigWouldChange" | "persistWorkspaceConfig"
  >,
  input: {
    nextConfig: WorkspaceConfig;
    summary: string;
    operation: "push" | "import";
  }
): Promise<boolean> {
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!(await configWouldChange(deps, input.nextConfig))) return false;
  if (!deps.persistWorkspaceConfig) {
    throw new Error("Workspace config persistence is unavailable");
  }
  const changed = await deps.persistWorkspaceConfig({
    ctx,
    nextConfig: input.nextConfig,
    summary: input.summary,
    operation: input.operation,
  });
  if (!changed) return false;
  mutateWorkspaceConfig(deps.workspaceConfig, input.nextConfig);
  return true;
}

async function configWouldChange(
  deps: Pick<GitInteropServiceDeps, "workspaceConfig" | "workspaceConfigWouldChange">,
  nextConfig: WorkspaceConfig
): Promise<boolean> {
  if (deps.workspaceConfigWouldChange) return await deps.workspaceConfigWouldChange(nextConfig);
  if (!deps.workspaceConfig) return true;
  return JSON.stringify(deps.workspaceConfig) !== JSON.stringify(nextConfig);
}

async function notifyWorkspaceSourceChanged(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "onWorkspaceSourceChanged">,
  summary: string
): Promise<void> {
  await deps.onWorkspaceSourceChanged?.(ctx, summary);
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
