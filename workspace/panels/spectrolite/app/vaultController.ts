/**
 * Vault controller — owns vault selection and the workspace path index.
 *
 * The path index comes from `vcs.listFiles()` at the vault's exact working
 * state, filtered to `.mdx` and mapped to vault-relative paths via the
 * {@link VaultPathMapping}. There is no `fs` walk. File creation records the new
 * doc as a tracked working `vcs.edit` so it appears in the index immediately
 * (committed + published later via Publish).
 *
 * Switching vault is a panel **reopen** under the new vault's stable
 * contextId (`vault-<hash>`), not a runtime `repoRoot` swap — only reopening
 * rebinds `vcs.*` (and the scribe) to the new vault's durable context.
 */

import { panel } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState } from "./state";
import { createQueuedRefresh } from "./queuedRefresh";
import {
  vaultContextId,
  vaultPathMapping,
  normalizeVaultPath,
  type VaultPathMapping,
} from "./vaultContext";
import type { VaultSemanticVcs } from "./semanticVcs";

export interface VaultFileSession {
  listFiles(prefix?: string): ReturnType<VaultSemanticVcs["listFiles"]>;
  readFile(path: string): ReturnType<VaultSemanticVcs["readFile"]>;
  createFile(path: string, text: string): ReturnType<VaultSemanticVcs["createFile"]>;
}

export interface VaultControllerHooks {
  /** Notify the session layer (agent scope update / default-agent bootstrap). */
  onVaultSelected(repoRoot: string): void;
}

export class VaultController {
  private pathsEpoch = 0;
  private readonly pathsRefresh = createQueuedRefresh();

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: VaultControllerHooks,
    private readonly semanticVcs: VaultFileSession | null = null
  ) {}

  /** The mapping for the active vault (vault-relative ↔ workspace-relative vcs paths). */
  mapping(): VaultPathMapping {
    return vaultPathMapping(this.store.getState().repoRoot ?? "");
  }

  /**
   * Pick a vault from the picker. Its semantic context is durable + per-vault,
   * so binding to it means reopening the panel under `vault-<hash>`. We persist
   * the selection in the new context's stateArgs via `reopen`.
   */
  selectVault(contextPath: string): void {
    const repoRoot = normalizeVaultPath(contextPath);
    this.store.setState({ vaultError: null, vaultPendingPath: repoRoot });
    void panel
      .reopen({
        contextId: vaultContextId(repoRoot),
        stateArgs: { repoRoot },
      })
      .catch((err) => {
        this.store.setState({
          vaultError: `Couldn't open this vault: ${err instanceof Error ? err.message : String(err)}`,
          vaultPendingPath: null,
        });
      });
  }

  /** Forget the selection so the picker shows (reopen without a repoRoot). */
  async switchVault(): Promise<void> {
    this.store.setState({
      activeDeps: {},
      activePath: null,
      dirtyPaths: [],
      installedAgents: [],
      paths: [],
      pathContentHashes: {},
      pathsLoaded: false,
      pathsLoading: false,
      pathsError: null,
      vaultError: null,
      vaultPendingPath: null,
      pendingSuggestions: [],
      removedHandles: [],
      repoRoot: null,
      roster: [],
    });
    await panel.reopen({ stateArgs: { repoRoot: null } }).catch((err) => {
      console.warn("[Spectrolite] reopen for vault switch failed:", err);
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
