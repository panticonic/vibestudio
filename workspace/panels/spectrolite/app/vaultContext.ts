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
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Validate a user-authored path before it crosses the vault boundary. */
export function safeVaultRelativePath(input: string): string {
  if (/^[\\/]/u.test(input)) throw new Error("Note paths must be relative to the vault");
  const normalized = normalizeVaultPath(input.trim());
  if (!normalized) throw new Error("Enter a note name");
  if (normalized.includes("\0")) throw new Error("Note paths cannot contain a null byte");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Note paths cannot traverse outside the vault");
  }
  return normalized;
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
