/**
 * Vault controller — owns vault selection and the workspace path index.
 *
 * Path-list refreshes are explicit (`refreshPaths()`) and coalesced;
 * everything that adds/removes files (flush, commit, file create, agent
 * writes) calls it directly instead of bumping a shared nonce.
 */

import { promises as fs } from "fs";
import { setStateArgs } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState } from "./state";
import { createQueuedRefresh } from "./queuedRefresh";
import { listMdxPaths } from "../state/workspacePaths";
import { joinSafe, parentDir } from "../state/safePath";

export interface VaultControllerHooks {
  /** Flush dirty buffers before the vault goes away. */
  flushAllDirty(): Promise<void>;
  /** Reset editor state for the new root. */
  onVaultChanged(): void;
  /** Notify the session layer (agent scope update / default-agent bootstrap). */
  onVaultSelected(repoRoot: string): void;
}

export class VaultController {
  private pathsEpoch = 0;
  private readonly pathsRefresh = createQueuedRefresh();

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: VaultControllerHooks,
  ) {}

  /** Persist + activate a newly-picked vault. */
  selectVault(contextPath: string): void {
    void setStateArgs({ repoRoot: contextPath, openPath: undefined });
    this.store.setState({ repoRoot: contextPath, activePath: null });
    this.hooks.onVaultChanged();
    this.pathsEpoch += 1;
    this.pathsRefresh.reset();
    this.store.setState({ paths: [], pathsLoading: false, pathsLoaded: false });
    void this.refreshPaths();
    this.hooks.onVaultSelected(contextPath);
  }

  /** Flush pending work, then forget the selection so the picker shows. */
  async switchVault(): Promise<void> {
    await this.hooks.flushAllDirty().catch((err) => {
      console.warn("[Spectrolite] flush before vault switch failed:", err);
    });
    void setStateArgs({ repoRoot: undefined, openPath: undefined });
    this.pathsEpoch += 1;
    this.pathsRefresh.reset();
    this.store.setState({ repoRoot: null, activePath: null, paths: [], pathsLoading: false, pathsLoaded: false });
    this.hooks.onVaultChanged();
  }

  refreshPaths(): Promise<void> {
    return this.pathsRefresh.run(async () => {
      const root = this.store.getState().repoRoot;
      if (!root) {
        this.store.setState({ paths: [], pathsLoading: false });
        return;
      }
      const epoch = this.pathsEpoch;
      this.store.setState({ pathsLoading: true });
      try {
        const paths = await listMdxPaths(root);
        if (epoch !== this.pathsEpoch) return;
        this.store.setState({ paths, pathsLoading: false, pathsLoaded: true });
      } catch {
        if (epoch !== this.pathsEpoch) return;
        this.store.setState({ paths: [], pathsLoading: false, pathsLoaded: true });
      }
    });
  }

  /**
   * Create a file (exclusive — refuses to clobber). Returns the final
   * relative path on success, the existing path when the file was already
   * there, or throws with a user-facing message.
   */
  async createFile(relPath: string, initialContent: string): Promise<string> {
    const root = this.store.getState().repoRoot;
    if (!root) throw new Error("No vault selected");
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const full = joinSafe(root, finalPath);
    if (!full) throw new Error(`"${finalPath}" escapes the workspace root`);
    try {
      await fs.stat(full);
      return finalPath; // exists — caller just opens it
    } catch {
      // ENOENT — safe to create
    }
    const parent = parentDir(full);
    if (parent) {
      try { await fs.mkdir(parent, { recursive: true }); } catch { /* surfaced by writeFile */ }
    }
    // Exclusive-create: if the file appeared between stat() and now, `wx`
    // fails with EEXIST and we open the existing file instead. We do NOT
    // fall back to a plain write on other errors — that could clobber a
    // file that exists but couldn't be stat'd.
    const fsWithFlags = fs as unknown as { writeFile(p: string, data: string, opts?: { flag?: string }): Promise<void> };
    try {
      await fsWithFlags.writeFile(full, initialContent, { flag: "wx" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/eexist/i.test(msg)) return finalPath;
      throw err instanceof Error ? err : new Error(msg);
    }
    void this.refreshPaths();
    return finalPath;
  }
}
