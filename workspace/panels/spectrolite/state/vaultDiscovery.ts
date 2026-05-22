/**
 * Discover Spectrolite vaults.
 *
 * A Spectrolite vault is a directory under `projects/` in the workspace.
 * The workspace startup machinery (`WORKSPACE_GIT_INIT_PATTERNS` includes
 * `projects/*`) automatically `git init`s every `projects/<name>/` so
 * each vault is its own git repo without manual setup.
 *
 * Inside a panel context, workspace repos are mounted at the same path:
 * `projects/<name>/` becomes accessible as `/projects/<name>/` via the
 * panel's RPC-backed fs. Edits happen in the per-context working tree;
 * commits go through that copy's `.git`; pushes propagate back to the
 * workspace source tree via the git server (where they're visible to
 * other contexts on their next pull / context creation).
 *
 * `discoverVaults()` returns metadata for every existing `projects/*`
 * directory (whether or not it has been initialised as a git repo).
 */

import { getWorkspaceTree } from "@workspace/runtime";

export interface VaultEntry {
  /** Name as it appears under `projects/`. */
  name: string;
  /** Path relative to the workspace source root, e.g. `projects/my-notes`. */
  relPath: string;
  /** Path as visible inside the panel context fs, e.g. `/projects/my-notes`. */
  contextPath: string;
  /** Whether the directory is a git repo (workspace startup git-inits all `projects/*`). */
  isGitRepo: boolean;
}

interface WorkspaceNodeLike {
  name: string;
  path: string;
  isGitRepo: boolean;
  children?: WorkspaceNodeLike[];
}

export async function discoverVaults(): Promise<VaultEntry[]> {
  let tree: { children?: WorkspaceNodeLike[] };
  try {
    tree = await getWorkspaceTree() as { children?: WorkspaceNodeLike[] };
  } catch (err) {
    console.warn("[Spectrolite] getWorkspaceTree failed:", err);
    return [];
  }
  const projectsNode = tree.children?.find((c) => c.name === "projects");
  if (!projectsNode || !projectsNode.children) return [];
  return projectsNode.children.map((child) => ({
    name: child.name,
    relPath: child.path,
    contextPath: `/${child.path}`,
    isGitRepo: child.isGitRepo,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a vault name to its context fs path. */
export function vaultContextPath(name: string): string {
  return `/projects/${name}`;
}

/** Validate a proposed vault name. */
export function validateVaultName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(trimmed)) {
    return "Name must start with a letter/digit/underscore and contain only letters, digits, underscores, or hyphens";
  }
  if (trimmed.length > 64) return "Name must be 64 characters or fewer";
  return null;
}
