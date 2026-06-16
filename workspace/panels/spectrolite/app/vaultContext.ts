/**
 * Per-vault context binding + path mapping.
 *
 * A vault binds to a STABLE per-vault context head: `contextId = vault-<hash>`
 * derived from the vault's workspace-relative root. Opening a panel under that
 * contextId resolves every `vcs.*` call (and the scribe it spawns) to the same
 * durable `ctx:vault-<hash>` head — so reopening a vault resumes its notes, and
 * `main` is touched only by an explicit Publish. Switching vault = reopening the
 * panel under the new vault's contextId (`reopen({ contextId })`), never a
 * runtime `repoRoot` swap (which can't move the head).
 *
 * The vault is a *subdirectory* of the single workspace tree, but `vcs.*` paths
 * are workspace-root-relative. So a note shown as `E2E.mdx` in a vault rooted at
 * `projects/default` is `vcsPath = projects/default/E2E.mdx`. Every boundary
 * (reads/writes, listFiles, head advances, wikilinks, mentions) routes through
 * one {@link VaultPathMapping}.
 */

/** Strip leading/trailing slashes + backslashes; collapse to posix. */
export function normalizeVaultPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Deterministic, browser-safe FNV-1a (two 32-bit lanes, base36) over the
 * normalized vault path. Output is `[0-9a-z]+`, so `vault-<hash>` satisfies the
 * context-id grammar `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` and stays well under the
 * 63-char limit. Pure (no crypto/SubtleCrypto) so it runs identically in the
 * panel, tests, and any reopen path.
 */
function hashVaultPath(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
    h2 = (h2 + i + 1) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/** Stable per-vault context id (`vault-<hash>`) for a workspace-relative root. */
export function vaultContextId(vaultWorkspaceRoot: string): string {
  return `vault-${hashVaultPath(normalizeVaultPath(vaultWorkspaceRoot))}`;
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
