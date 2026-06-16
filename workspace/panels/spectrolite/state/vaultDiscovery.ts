/**
 * Discover Spectrolite vaults.
 *
 * A Spectrolite vault is a directory under `projects/` in the workspace.
 *
 * Inside a panel context, workspace repos are mounted at the same path:
 * `projects/<name>/` becomes accessible as `/projects/<name>/` via the
 * panel's RPC-backed fs. Edits happen in the per-context working tree;
 * commits go through the GAD-native runtime VCS surface and advance the
 * caller's workspace head.
 *
 * `discoverVaults()` returns metadata for every existing `projects/*`
 * directory.
 */

import { workspace } from "@workspace/runtime";

export interface VaultEntry {
  /** Name as it appears under `projects/`. */
  name: string;
  /** Path relative to the workspace source root, e.g. `projects/my-notes`. */
  relPath: string;
  /** Path as visible inside the panel context fs, e.g. `/projects/my-notes`. */
  contextPath: string;
}

interface WorkspaceNodeLike {
  name: string;
  path: string;
  children?: WorkspaceNodeLike[];
}

export async function discoverVaults(): Promise<VaultEntry[]> {
  let tree: { children?: WorkspaceNodeLike[] };
  try {
    tree = await workspace.sourceTree() as { children?: WorkspaceNodeLike[] };
  } catch (err) {
    console.warn("[Spectrolite] workspace.sourceTree failed:", err);
    return [];
  }
  const projectsNode = tree.children?.find((c) => c.name === "projects");
  if (!projectsNode || !projectsNode.children) return [];
  return projectsNode.children.map((child) => ({
    name: child.name,
    relPath: child.path,
    contextPath: `/${child.path}`,
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
