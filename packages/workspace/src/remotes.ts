import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkspaceRepoPath as normalizeWorkspaceRepoPathByTaxonomy } from "@vibestudio/shared/runtime/entitySpec";
import type {
  GitConfig,
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitRemoteDeclaration,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";

const execFileAsync = promisify(execFile);

const SAFE_REMOTE_NAME = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requireMapping(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be a mapping`);
  return value;
}

export interface ResolvedWorkspaceGitRemote {
  repoPath: string;
  section: string;
  repoKey: string;
  name: string;
  url: string;
  branch?: string;
}

export interface SyncDeclaredRemoteResult {
  repoPath: string;
  applied: boolean;
  removedManaged: string[];
  remotes: ResolvedWorkspaceGitRemote[];
}

export interface ResolvedWorkspaceGitUpstream {
  repoPath: string;
  section: string;
  repoKey: string;
  remote: string;
  branch: string;
  autoPush: boolean;
  credentialId?: string;
  authorEmail?: string;
  authorName?: string;
}

export function normalizeWorkspaceRepoPath(repoPath: string): string {
  return normalizeWorkspaceRepoPathByTaxonomy(repoPath);
}

export function isDeclaredRemoteRepoPath(repoPath: string): boolean {
  try {
    normalizeWorkspaceRepoPath(repoPath);
    return true;
  } catch {
    return false;
  }
}

export function getDeclaredRemotesForRepo(
  config: WorkspaceConfig,
  repoPathInput: string
): ResolvedWorkspaceGitRemote[] {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const remotes = config.git?.remotes?.[section!]?.[repoKey] ?? {};
  return Object.entries(remotes)
    .map(([name, declaration]) =>
      validateWorkspaceGitRemoteEntry(repoPath, section!, repoKey, name, declaration)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getDeclaredRemoteForRepo(
  config: WorkspaceConfig,
  repoPathInput: string,
  name = "origin"
): ResolvedWorkspaceGitRemote | null {
  return (
    getDeclaredRemotesForRepo(config, repoPathInput).find((remote) => remote.name === name) ?? null
  );
}

export function validateWorkspaceGitRemote(
  remote: WorkspaceGitRemoteConfig
): WorkspaceGitRemoteConfig {
  if (!isRecord(remote)) {
    throw new Error("Remote declaration is required");
  }
  if (!hasOnlyKeys(remote, ["name", "url", "branch"])) {
    throw new Error("Remote declaration may contain only name, url, and branch");
  }
  if (typeof remote.name !== "string") throw new Error("Remote name must be a string");
  if (typeof remote.url !== "string") throw new Error("Remote URL must be a string");
  if (remote.branch !== undefined && typeof remote.branch !== "string") {
    throw new Error("Remote branch must be a string when present");
  }
  const name = validateWorkspaceGitRemoteName(remote.name);
  const url = normalizeRemoteUrl(remote.url);
  const branch =
    remote.branch === undefined ? undefined : validateWorkspaceGitRemoteBranch(remote.branch);
  return branch === undefined ? { name, url } : { name, url, branch };
}

export function validateWorkspaceGitRemoteName(nameInput: string): string {
  const name = nameInput.trim();
  if (!name || !SAFE_REMOTE_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid remote name: ${nameInput}`);
  }
  return name;
}

export function validateWorkspaceGitRemoteBranch(branchInput: string): string {
  const branch = branchInput.trim();
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s\0~^:?*[\\]/.test(branch)
  ) {
    throw new Error(`Invalid remote branch: ${branchInput}`);
  }
  return branch;
}

export function validateWorkspaceGitUpstream(
  upstream: WorkspaceGitUpstreamConfig
): WorkspaceGitUpstreamConfig {
  if (!isRecord(upstream)) {
    throw new Error("Upstream declaration is required");
  }
  if (
    !hasOnlyKeys(upstream, [
      "remote",
      "branch",
      "autoPush",
      "credentialId",
      "authorEmail",
      "authorName",
    ])
  ) {
    throw new Error(
      "Upstream declaration may contain only remote, branch, autoPush, credentialId, authorEmail, and authorName"
    );
  }
  if (typeof upstream.remote !== "string") throw new Error("Upstream remote must be a string");
  if (upstream.branch !== undefined && typeof upstream.branch !== "string") {
    throw new Error("Upstream branch must be a string when present");
  }
  if (upstream.autoPush !== undefined && typeof upstream.autoPush !== "boolean") {
    throw new Error("Upstream autoPush must be a boolean when present");
  }
  const remote = validateWorkspaceGitRemoteName(upstream.remote);
  const branch =
    upstream.branch === undefined ? undefined : validateWorkspaceGitRemoteBranch(upstream.branch);
  const autoPush = upstream.autoPush;
  const credentialId = normalizeOptionalNonEmpty("credentialId", upstream.credentialId);
  const authorEmail = normalizeOptionalNonEmpty("authorEmail", upstream.authorEmail);
  const authorName = normalizeOptionalNonEmpty("authorName", upstream.authorName);
  return {
    remote,
    ...(branch !== undefined ? { branch } : {}),
    ...(autoPush !== undefined ? { autoPush } : {}),
    ...(credentialId !== undefined ? { credentialId } : {}),
    ...(authorEmail !== undefined ? { authorEmail } : {}),
    ...(authorName !== undefined ? { authorName } : {}),
  };
}

function normalizeOptionalNonEmpty(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${label}: expected a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid ${label}: empty value`);
  return normalized;
}

export function getDeclaredUpstreamForRepo(
  config: WorkspaceConfig,
  repoPathInput: string
): ResolvedWorkspaceGitUpstream | null {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const declaration = config.git?.upstreams?.[section!]?.[repoKey];
  if (declaration === undefined) return null;
  const upstream = validateWorkspaceGitUpstream(declaration);
  const remote = getDeclaredRemoteForRepo(config, repoPath, upstream.remote);
  if (!remote) {
    throw new Error(`Upstream remote "${upstream.remote}" is not declared for ${repoPath}`);
  }
  return {
    repoPath,
    section: section!,
    repoKey,
    remote: upstream.remote,
    branch: upstream.branch ?? remote.branch ?? "main",
    autoPush: upstream.autoPush ?? false,
    ...(upstream.credentialId !== undefined ? { credentialId: upstream.credentialId } : {}),
    ...(upstream.authorEmail !== undefined ? { authorEmail: upstream.authorEmail } : {}),
    ...(upstream.authorName !== undefined ? { authorName: upstream.authorName } : {}),
  };
}

export function getDeclaredUpstreams(config: WorkspaceConfig): ResolvedWorkspaceGitUpstream[] {
  const entries: ResolvedWorkspaceGitUpstream[] = [];
  for (const [section, repos] of Object.entries(config.git?.upstreams ?? {})) {
    for (const repoKey of Object.keys(repos)) {
      const repoPath = normalizeWorkspaceRepoPath(repoKey ? `${section}/${repoKey}` : section);
      const upstream = getDeclaredUpstreamForRepo(config, repoPath);
      if (upstream) entries.push(upstream);
    }
  }
  return entries.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

export interface DeclaredUpstreamListing {
  repoPath: string;
  upstream: ResolvedWorkspaceGitUpstream | null;
  /** Set when the declaration exists but does not resolve (e.g. its remote was removed). */
  error?: string;
}

/**
 * Tolerant variant of {@link getDeclaredUpstreams}: one unresolvable
 * declaration (say, an upstream whose remote was deleted) yields an `error`
 * entry instead of failing the whole enumeration.
 */
export function listDeclaredUpstreams(config: WorkspaceConfig): DeclaredUpstreamListing[] {
  const entries: DeclaredUpstreamListing[] = [];
  for (const [section, repos] of Object.entries(config.git?.upstreams ?? {})) {
    for (const repoKey of Object.keys(repos)) {
      const repoPath = normalizeWorkspaceRepoPath(repoKey ? `${section}/${repoKey}` : section);
      try {
        entries.push({ repoPath, upstream: getDeclaredUpstreamForRepo(config, repoPath) });
      } catch (err) {
        entries.push({
          repoPath,
          upstream: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return entries.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

function validateWorkspaceGitRemoteEntry(
  repoPath: string,
  section: string,
  repoKey: string,
  nameInput: string,
  declaration: WorkspaceGitRemoteDeclaration
): ResolvedWorkspaceGitRemote {
  const name = validateWorkspaceGitRemoteName(nameInput);
  const remote = normalizeRemoteDeclaration(declaration);
  return {
    repoPath,
    section,
    repoKey,
    name,
    ...remote,
  };
}

function normalizeRemoteDeclaration(declaration: WorkspaceGitRemoteDeclaration): {
  url: string;
  branch?: string;
} {
  if (!isRecord(declaration)) {
    throw new Error("Remote declaration must be an object with url");
  }
  if (!hasOnlyKeys(declaration, ["url", "branch"])) {
    throw new Error("Remote declaration may contain only url and branch");
  }
  if (typeof declaration.url !== "string") throw new Error("Remote URL must be a string");
  if (declaration.branch !== undefined && typeof declaration.branch !== "string") {
    throw new Error("Remote branch must be a string when present");
  }
  const url = normalizeRemoteUrl(declaration.url);
  const branch =
    declaration.branch === undefined
      ? undefined
      : validateWorkspaceGitRemoteBranch(declaration.branch);
  return branch === undefined ? { url } : { url, branch };
}

/** Validate the canonical Git declaration tree read from meta/vibestudio.yml. */
export function validateWorkspaceGitConfig(gitValue: unknown): void {
  if (gitValue === undefined) return;
  const git = requireMapping(gitValue, "git");
  if (!hasOnlyKeys(git, ["remotes", "upstreams"])) {
    throw new Error("git may contain only remotes and upstreams");
  }

  if (git["remotes"] !== undefined) {
    const sections = requireMapping(git["remotes"], "git.remotes");
    for (const [section, repoValue] of Object.entries(sections)) {
      const repos = requireMapping(repoValue, `git.remotes.${section}`);
      for (const [repoKey, remoteValue] of Object.entries(repos)) {
        const repoPath = normalizeWorkspaceRepoPath(repoKey ? `${section}/${repoKey}` : section);
        const remotes = requireMapping(remoteValue, `git.remotes.${section}.${repoKey}`);
        for (const [name, declaration] of Object.entries(remotes)) {
          validateWorkspaceGitRemoteEntry(
            repoPath,
            section,
            repoKey,
            name,
            declaration as WorkspaceGitRemoteDeclaration
          );
        }
      }
    }
  }

  if (git["upstreams"] !== undefined) {
    const sections = requireMapping(git["upstreams"], "git.upstreams");
    for (const [section, repoValue] of Object.entries(sections)) {
      const repos = requireMapping(repoValue, `git.upstreams.${section}`);
      for (const [repoKey, declaration] of Object.entries(repos)) {
        normalizeWorkspaceRepoPath(repoKey ? `${section}/${repoKey}` : section);
        validateWorkspaceGitUpstream(declaration as WorkspaceGitUpstreamConfig);
      }
    }
  }
}

export function normalizeRemoteUrl(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Remote URL is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid remote URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Remote URL must use http or https: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error("Remote URL must not contain embedded credentials");
  }
  url.hash = "";
  return url.href;
}

export function setDeclaredRemoteInConfig(
  config: WorkspaceConfig,
  repoPathInput: string,
  remote: WorkspaceGitRemoteConfig
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const normalized = validateWorkspaceGitRemote(remote);
  const declaration: WorkspaceGitRemoteDeclaration = {
    url: normalized.url,
    ...(normalized.branch === undefined ? {} : { branch: normalized.branch }),
  };
  const git = config.git ?? {};
  const remotes = git.remotes ?? {};
  const sectionRemotes = remotes[section!] ?? {};
  return {
    ...config,
    git: {
      ...git,
      remotes: {
        ...remotes,
        [section!]: {
          ...sectionRemotes,
          [repoKey]: {
            ...(sectionRemotes[repoKey] ?? {}),
            [normalized.name]: declaration,
          },
        },
      },
    },
  };
}

export function removeDeclaredRemoteFromConfig(
  config: WorkspaceConfig,
  repoPathInput: string,
  remoteName: string
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const normalizedRemoteName = validateWorkspaceGitRemoteName(remoteName);
  const git = config.git ?? {};
  const remotes = git.remotes ?? {};
  const nextRemotes = { ...remotes };
  const sectionRemotes = { ...(remotes[section!] ?? {}) };
  const repoRemotes = { ...(sectionRemotes[repoKey] ?? {}) };
  delete repoRemotes[normalizedRemoteName];
  if (Object.keys(repoRemotes).length > 0) {
    sectionRemotes[repoKey] = repoRemotes;
  } else {
    delete sectionRemotes[repoKey];
  }
  if (Object.keys(sectionRemotes).length > 0) nextRemotes[section!] = sectionRemotes;
  else delete nextRemotes[section!];

  const nextGit: GitConfig = { ...git };
  if (Object.keys(nextRemotes).length > 0) nextGit.remotes = nextRemotes;
  else delete nextGit.remotes;
  const nextConfig = { ...config };
  if (Object.keys(nextGit).length > 0) nextConfig.git = nextGit;
  else delete nextConfig.git;
  return nextConfig;
}

export function setDeclaredUpstreamInConfig(
  config: WorkspaceConfig,
  repoPathInput: string,
  upstreamInput: WorkspaceGitUpstreamConfig
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const upstream = validateWorkspaceGitUpstream(upstreamInput);
  if (!getDeclaredRemoteForRepo(config, repoPath, upstream.remote)) {
    throw new Error(`Upstream remote "${upstream.remote}" is not declared for ${repoPath}`);
  }
  const git = config.git ?? {};
  const upstreams = git.upstreams ?? {};
  const sectionUpstreams = upstreams[section!] ?? {};
  return {
    ...config,
    git: {
      ...git,
      upstreams: {
        ...upstreams,
        [section!]: {
          ...sectionUpstreams,
          [repoKey]: upstream,
        },
      },
    },
  };
}

export function removeDeclaredUpstreamFromConfig(
  config: WorkspaceConfig,
  repoPathInput: string
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const git = config.git ?? {};
  const upstreams = git.upstreams ?? {};
  const nextUpstreams = { ...upstreams };
  const sectionUpstreams = { ...(upstreams[section!] ?? {}) };
  delete sectionUpstreams[repoKey];
  if (Object.keys(sectionUpstreams).length > 0) nextUpstreams[section!] = sectionUpstreams;
  else delete nextUpstreams[section!];

  const nextGit: GitConfig = { ...git };
  if (Object.keys(nextUpstreams).length > 0) nextGit.upstreams = nextUpstreams;
  else delete nextGit.upstreams;
  const nextConfig = { ...config };
  if (Object.keys(nextGit).length > 0) nextConfig.git = nextGit;
  else delete nextConfig.git;
  return nextConfig;
}

export async function syncDeclaredRemoteForRepo(options: {
  config: WorkspaceConfig;
  workspaceRoot: string;
  repoPath: string;
}): Promise<SyncDeclaredRemoteResult> {
  const repoPath = normalizeWorkspaceRepoPath(options.repoPath);
  const repoDir = path.join(options.workspaceRoot, repoPath);
  const gitDir = path.join(repoDir, ".git");
  try {
    await fs.access(gitDir);
  } catch {
    return { repoPath, applied: false, removedManaged: [], remotes: [] };
  }

  const remotes = getDeclaredRemotesForRepo(options.config, repoPath);
  const remoteNames = new Set(remotes.map((remote) => remote.name));
  const managedNames = await listManagedRemoteNames(repoDir);
  const removedManaged: string[] = [];
  for (const name of managedNames) {
    if (!remoteNames.has(name)) {
      await removeRemote(repoDir, name);
      removedManaged.push(name);
    }
  }

  if (remotes.length === 0) {
    return { repoPath, applied: false, removedManaged, remotes };
  }

  for (const remote of remotes) {
    await upsertRemote(repoDir, remote);
  }
  return { repoPath, applied: true, removedManaged, remotes };
}

async function upsertRemote(repoDir: string, remote: ResolvedWorkspaceGitRemote): Promise<void> {
  const existing = await gitConfig(repoDir, ["remote", "get-url", remote.name]);
  if (existing.ok) {
    await gitConfig(repoDir, ["remote", "set-url", remote.name, remote.url]);
  } else {
    await gitConfig(repoDir, ["remote", "add", remote.name, remote.url]);
  }
  await gitConfig(repoDir, ["config", `remote.${remote.name}.vibestudio-managed`, "true"], true);
}

async function removeRemote(repoDir: string, name: string): Promise<void> {
  await gitConfig(repoDir, ["remote", "remove", name]);
}

async function listManagedRemoteNames(repoDir: string): Promise<string[]> {
  const result = await gitConfig(repoDir, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.vibestudio-managed$",
  ]);
  if (!result.ok) return [];
  const names = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^remote\.(.+)\.vibestudio-managed\s+true$/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

async function gitConfig(
  cwd: string,
  args: string[],
  throwOnError = false
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return { ok: true, stdout };
  } catch (error) {
    if (throwOnError) throw error;
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
