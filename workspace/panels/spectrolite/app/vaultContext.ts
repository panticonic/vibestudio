/**
 * Vault repository path mapping.
 *
 * A Spectrolite panel keeps its existing semantic workspace context. A vault is
 * one repository inside that context, selected by `repoRoot`; it is not a
 * second context or a narrower kind of context. Thus a note shown as `E2E.mdx`
 * in `projects/default` maps to the workspace-relative VCS path
 * `projects/default/E2E.mdx`. Every vault↔VCS boundary routes through one
 * {@link VaultPathMapping}.
 */

/** Strip leading/trailing slashes + backslashes; collapse to posix. */
export function normalizeVaultPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface VaultPathMapping {
  /** The vault's workspace-root-relative root, e.g. `projects/default` (`""` for the tree root). */
  readonly root: string;
  /** A vault-relative path (`E2E.mdx`) → its workspace-relative vcs path. */
  toVcsPath(vaultRelPath: string): string;
  /** A vcs path → its vault-relative path, or `null` if outside this vault. */
  toVaultRelPath(vcsPath: string): string | null;
  /** Does a vcs path belong to this vault? */
  contains(vcsPath: string): boolean;
}

/** One mapping per open vault; route every vault↔vcs path boundary through it. */
export function vaultPathMapping(vaultWorkspaceRoot: string): VaultPathMapping {
  const root = normalizeVaultPath(vaultWorkspaceRoot);
  const prefix = root ? `${root}/` : "";
  const toVaultRelPath = (vcsPath: string): string | null => {
    const norm = normalizeVaultPath(vcsPath);
    if (!prefix) return norm;
    if (norm === root) return "";
    return norm.startsWith(prefix) ? norm.slice(prefix.length) : null;
  };
  return {
    root,
    toVcsPath: (vaultRelPath) => `${prefix}${normalizeVaultPath(vaultRelPath)}`,
    toVaultRelPath,
    contains: (vcsPath) => toVaultRelPath(vcsPath) !== null,
  };
}
