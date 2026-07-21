/**
 * Vault controller — owns vault selection and the workspace path index.
 *
 * The path index comes from `vcs.listFiles()` at the vault's exact working
 * state, filtered to `.mdx` and mapped to vault-relative paths via the
 * {@link VaultPathMapping}. There is no `fs` walk. File creation records the new
 * doc as a tracked working `vcs.edit` so it appears in the index immediately
 * (committed + published later via Publish).
 *
 * Switching vault changes the repository binding inside the panel's existing
 * semantic workspace context. A vault is a repository, not another context.
 */

import { panel } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState } from "./state";
import { createQueuedRefresh } from "./queuedRefresh";
import { vaultPathMapping, normalizeVaultPath, type VaultPathMapping } from "./vaultContext";
import type { VaultSemanticVcs } from "./semanticVcs";

export interface VaultFileSession {
  listFiles(prefix?: string): ReturnType<VaultSemanticVcs["listFiles"]>;
  readFile(path: string): ReturnType<VaultSemanticVcs["readFile"]>;
  createFile(path: string, text: string): ReturnType<VaultSemanticVcs["createFile"]>;
}

export interface VaultControllerHooks {
  /** Flush the active document before its repository binding is replaced. */
  beforeVaultSwitch(): Promise<void>;
  /** Rebind VCS and publishing within the unchanged panel context. */
  bindVault(repoRoot: string | null): VaultFileSession | null;
  /** Notify the session layer (agent scope update / default-agent bootstrap). */
  onVaultSelected(repoRoot: string): void;
}

export class VaultController {
  private pathsEpoch = 0;
  private readonly pathsRefresh = createQueuedRefresh();

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: VaultControllerHooks,
    private semanticVcs: VaultFileSession | null = null
  ) {}

  /** The mapping for the active vault (vault-relative ↔ workspace-relative vcs paths). */
  mapping(): VaultPathMapping {
    return vaultPathMapping(this.store.getState().repoRoot ?? "");
  }

  /**
   * Pick a repository while retaining panel identity, context ownership, and
   * channel history. Controllers and resident-agent prompts update their
   * repository focus; their identities and authority scope do not change.
   */
  selectVault(repoRootInput: string): void {
    const repoRoot = normalizeVaultPath(repoRootInput);
    this.store.setState({ vaultError: null, vaultPendingPath: repoRoot });
    void this.selectVaultInCurrentContext(repoRoot).catch((err) => {
      this.store.setState({
        vaultError: `Couldn't open this vault: ${err instanceof Error ? err.message : String(err)}`,
        vaultPendingPath: null,
      });
    });
  }

  private async selectVaultInCurrentContext(repoRoot: string): Promise<void> {
    this.pathsEpoch += 1;
    const previousRoot = this.store.getState().repoRoot;
    if (previousRoot !== null) await this.hooks.beforeVaultSwitch();
    const nextSemanticVcs = this.hooks.bindVault(repoRoot);
    if (!nextSemanticVcs) throw new Error("The panel has no writable semantic workspace context");
    try {
      await panel.stateArgs.set({ repoRoot, openPath: null });
      this.semanticVcs = nextSemanticVcs;
      this.store.setState({
        activeDeps: {},
        activePath: null,
        dirtyPaths: [],
        pathContentHashes: {},
        paths: [],
        pathsError: null,
        pathsLoaded: false,
        pathsLoading: false,
        pendingSuggestions: [],
        recentPaths: [],
        repoRoot,
        vaultError: null,
        vaultPendingPath: null,
      });
      this.hooks.onVaultSelected(repoRoot);
      await this.refreshPaths();
    } catch (err) {
      this.semanticVcs = this.hooks.bindVault(previousRoot);
      throw err;
    }
  }

  /** Forget the selection so the picker shows in the current semantic context. */
  async switchVault(): Promise<void> {
    this.pathsEpoch += 1;
    await this.hooks.beforeVaultSwitch();
    this.store.setState({
      activeDeps: {},
      activePath: null,
      dirtyPaths: [],
      paths: [],
      pathContentHashes: {},
      pathsLoaded: false,
      pathsLoading: false,
      pathsError: null,
      vaultError: null,
      vaultPendingPath: null,
      pendingSuggestions: [],
      repoRoot: null,
    });
    this.semanticVcs = this.hooks.bindVault(null);
    await panel.stateArgs.set({ repoRoot: null, openPath: null }).catch((err) => {
      console.warn("[Spectrolite] couldn't persist vault switch state:", err);
    });
  }

  refreshPaths(): Promise<void> {
    return this.pathsRefresh.run(async () => {
      const root = this.store.getState().repoRoot;
      if (root === null) {
        this.store.setState({
          paths: [],
          pathContentHashes: {},
          pathsLoading: false,
          pathsError: null,
        });
        return;
      }
      const mapping = vaultPathMapping(root);
      const epoch = this.pathsEpoch;
      this.store.setState({ pathsLoading: true, pathsError: null });
      try {
        if (!this.semanticVcs) throw new Error("The vault is not bound to a VCS context");
        const entries = await this.semanticVcs.listFiles(mapping.toVcsPath(""));
        if (epoch !== this.pathsEpoch) return;
        const pathContentHashes: Record<string, string> = {};
        const paths = entries
          .flatMap((entry) => {
            const relPath = mapping.toVaultRelPath(entry.path);
            if (relPath === null || !/\.mdx$/i.test(relPath)) return [];
            pathContentHashes[relPath] = entry.contentHash;
            return [relPath];
          })
          .sort((a, b) => a.localeCompare(b));
        this.store.setState({
          paths,
          pathContentHashes,
          pathsLoading: false,
          pathsLoaded: true,
          pathsError: null,
        });
      } catch (err) {
        if (epoch !== this.pathsEpoch) return;
        this.store.setState({
          pathsLoading: false,
          pathsLoaded: true,
          pathsError: `Couldn't load the notes in this vault: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /**
   * Create a file (exclusive — refuses to clobber an existing note). Returns
   * the final vault-relative path on success, or the existing path when the
   * file is already there. Records the empty doc as a tracked working `vcs.edit`
   * on the vault's working state (no commit — Publish seals and advances it later).
   */
  async createFile(relPath: string, initialContent: string): Promise<string> {
    const root = this.store.getState().repoRoot;
    if (root === null) throw new Error("No vault selected");
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const mapping = vaultPathMapping(root);
    const vcsPath = mapping.toVcsPath(finalPath);

    if (!this.semanticVcs) throw new Error("The vault is not bound to a VCS context");
    const existing = await this.semanticVcs.readFile(vcsPath).catch(() => null);
    if (existing) return finalPath; // already exists — caller just opens it

    await this.semanticVcs.createFile(vcsPath, initialContent);
    void this.refreshPaths();
    return finalPath;
  }
}
