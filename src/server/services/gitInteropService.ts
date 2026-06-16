import * as fs from "fs";
import { lstatSync } from "fs";
import * as fsPromises from "fs/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import YAML from "yaml";
import { GitClient } from "@natstack/git";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext, VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { WorkspaceTreeScanner } from "../gadVcs/workspaceTree.js";
import type { WorkspaceConfig, WorkspaceGitRemoteConfig } from "@natstack/shared/workspace/types";
import {
  getDeclaredRemoteForRepo,
  normalizeRemoteUrl,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  setDeclaredRemoteInConfig,
  syncDeclaredRemoteForRepo,
  validateWorkspaceGitRemote,
  validateWorkspaceGitRemoteName,
} from "@natstack/shared/workspace/remotes";
import { WORKSPACE_IMPORT_PARENT_DIRS } from "@natstack/shared/workspace/sourceDirs";
import { gitInteropMethods } from "@natstack/shared/serviceSchemas/gitInterop";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { EgressProxy } from "./egressProxy.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { deleteDynamicProperty } from "../../lintHelpers";

const SHARED_GIT_REMOTE_CAPABILITY = "workspace-shared-git-remote";
const PROJECT_IMPORT_CAPABILITY = "workspace-project-import";

type GitInteropServiceDeps = {
  treeScanner: WorkspaceTreeScanner;
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  egressProxy?: Pick<EgressProxy, "forwardGitHttp">;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
};

type WorkspaceTreeNode = {
  path: string;
  isUnit: boolean;
  children: WorkspaceTreeNode[];
};

type ImportWorkspaceRepoRequest = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
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
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig);
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
          const nextConfig = removeDeclaredRemoteFromConfig(
            deps.workspaceConfig,
            validRepoPath,
            remoteName
          );
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig);
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.remotes;
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
    for (const [unitKey, unitRemotes] of Object.entries(units ?? {})) {
      if (!unitRemotes) continue;
      const unitPath = normalizeWorkspaceRepoPath(`${section}/${unitKey}`);
      const remotes = Object.entries(unitRemotes)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, url]) => validateWorkspaceGitRemote({ name, url }))
        .sort((a, b) => {
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
  if (!deps.egressProxy) throw new Error("Project import is unavailable");

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
  const normalizedRemote = validateWorkspaceGitRemote(request.remote);

  await ensureImportProjectPermission(ctx, deps, validRepoPath, normalizedRemote);
  await mkdir(dirname(absolutePath), { recursive: true });
  try {
    const client = new GitClient(fsPromises, {
      http: createEgressGitHttpClient(deps.egressProxy, ctx.caller, request.credentialId),
    });
    await client.clone({ url: normalizedRemote.url, dir: absolutePath });
    const nextConfig = setDeclaredRemoteInConfig(
      deps.workspaceConfig,
      validRepoPath,
      normalizedRemote
    );
    await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig);
    await propagateSharedRemote(deps, validRepoPath);
    deps.treeScanner.invalidate();
    return { path: validRepoPath, remote: normalizedRemote };
  } catch (err) {
    await fsPromises.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function ensureImportProjectPermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "approvalQueue" | "grantStore">,
  unitPath: string,
  remote: WorkspaceGitRemoteConfig
): Promise<void> {
  if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new Error("Project import is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) throw new Error("Project import is unavailable");
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: PROJECT_IMPORT_CAPABILITY,
      dedupKey: null,
      resource: { type: "workspace-project", label: "Project path", value: unitPath },
      title: "Add project from Git",
      description:
        "Allow this code version to import a remote Git repository into workspace source.",
      details: [
        { label: "Project path", value: unitPath },
        { label: "Remote name", value: remote.name },
        { label: "Remote URL", value: displayRemoteUrl(remote.url) },
      ],
      deniedReason: "Project import denied",
    }
  );
  if (!authorization.allowed) throw new Error(authorization.reason ?? "Project import denied");
}

function isSupportedImportRepoPath(repoPath: string): boolean {
  const [parent, child] = repoPath.split("/");
  return !!child && (WORKSPACE_IMPORT_PARENT_DIRS as readonly string[]).includes(parent ?? "");
}

async function ensureSharedRemotePermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "approvalQueue" | "grantStore">,
  unitPath: string,
  operation: "set" | "remove",
  remote: WorkspaceGitRemoteConfig | null
): Promise<void> {
  if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
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
      title: operation === "set" ? "Configure Git remote" : "Remove Git remote",
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

async function persistWorkspaceConfigChange(
  workspacePath: string,
  currentConfig: WorkspaceConfig,
  nextConfig: WorkspaceConfig
): Promise<void> {
  const metaDir = join(workspacePath, "meta");
  const configPath = join(metaDir, "natstack.yml");
  const before = await readFile(configPath, "utf-8");
  const beforeParsed = YAML.parse(before) as Record<string, unknown>;
  const nextContent = YAML.stringify({ ...beforeParsed, ...nextConfig });
  if (before === nextContent) return;
  await writeFile(configPath, nextContent, "utf-8");
  mutateWorkspaceConfig(currentConfig, nextConfig);
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

function createEgressGitHttpClient(
  egressProxy: Pick<EgressProxy, "forwardGitHttp">,
  caller: VerifiedCaller,
  credentialId?: string
) {
  return {
    async request(request: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: Uint8Array | AsyncIterable<Uint8Array>;
    }) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const response = await egressProxy.forwardGitHttp({
        caller,
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers ?? {},
        body,
        credentialId,
      });
      return {
        url: response.url,
        method: response.method,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: (async function* () {
          yield response.body;
        })(),
      };
    },
  };
}

async function collectGitBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

function resolveWorkspaceRepoPath(
  workspacePath: string,
  repoPath: string
): {
  absolutePath: string;
  normalizedRepoPath: string;
} {
  const workspaceAbs = resolve(workspacePath);
  const absolutePath = resolve(workspaceAbs, repoPath);
  const rel = relative(workspaceAbs, absolutePath);
  if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Invalid workspace unit path: escapes workspace root");
  }
  return { absolutePath, normalizedRepoPath: rel || "." };
}

function assertWorkspaceCreateTargetSafe(
  workspacePath: string,
  absolutePath: string,
  operation: string
): void {
  let current = dirname(absolutePath);
  const workspaceAbs = resolve(workspacePath);
  while (current.length >= workspaceAbs.length) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to ${operation}: ancestor "${current}" is a symlink`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (current === workspaceAbs) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  try {
    const tStat = lstatSync(absolutePath);
    if (tStat.isSymbolicLink()) {
      throw new Error(`Refusing to ${operation}: target "${absolutePath}" is a symlink`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
