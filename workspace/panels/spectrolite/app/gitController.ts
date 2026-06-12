/**
 * Git state controller — the single owner of git status / branch / commit
 * operations for the active vault.
 *
 * Replaces the old refresh-nonce broadcast: callers that change the
 * working tree (flush, commit, branch switch, agent writes) call
 * `refreshStatus()` directly. Concurrent refreshes coalesce onto one
 * in-flight call so bursts (e.g. multi-file flush) don't stack git
 * subprocesses.
 */

import { git as runtimeGit, listBranches, contextId as runtimeContextId } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState } from "./state";
import { createQueuedRefresh } from "./queuedRefresh";
import { hasUnflushedChanges } from "../state/fileBuffer";
import { formatGitError } from "../state/gitErrors";
import { KB_COMMIT_TYPE } from "../messages/register";

export const BRANCH_DIRTY_ERROR = "Commit or discard changes before switching branches.";
const UNFLUSHED_COMMIT_ERROR = "Flush pending editor changes before committing.";
const UNFLUSHED_CHECKOUT_ERROR = "Flush pending editor changes before switching branches.";

function commitSubject(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export interface GitControllerHooks {
  flushAllDirty(): Promise<void>;
}

export class GitController {
  private statusEpoch = 0;
  private readonly statusRefresh = createQueuedRefresh();

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: GitControllerHooks,
  ) {}

  /** Invalidate everything after the vault root changed. */
  reset(): void {
    this.statusEpoch += 1;
    this.statusRefresh.reset();
    this.store.setState({
      gitBranch: null,
      gitDirty: [],
      gitStatusError: null,
      gitOperation: null,
      branches: [],
      branchError: null,
      branchesLoading: false,
      checkoutBusy: false,
    });
  }

  refreshStatus(): Promise<void> {
    return this.statusRefresh.run(async () => {
      const epoch = this.statusEpoch;
      const root = this.store.getState().repoRoot;
      if (!root) return;
      try {
        const status = await runtimeGit.client().status(root);
        if (epoch !== this.statusEpoch) return;
        const dirty = (status.files ?? [])
          .filter((file) => file.status !== "unmodified" && file.status !== "ignored")
          .map((file) => file.path);
        this.store.setState({ gitDirty: dirty, gitBranch: status.branch ?? null, gitStatusError: null });
      } catch (err) {
        if (epoch !== this.statusEpoch) return;
        console.debug("[Spectrolite] git status failed:", err);
        this.store.setState({ gitStatusError: formatGitError("status", err) });
      }
    });
  }

  async refreshBranches(): Promise<void> {
    const epoch = this.statusEpoch;
    const root = this.store.getState().repoRoot;
    if (!root) return;
    this.store.setState({ branchesLoading: true });
    try {
      const list = await listBranches(root.replace(/^\/+/, ""));
      if (epoch !== this.statusEpoch) return;
      this.store.setState({
        branches: list.map((branch) => ({ name: branch.name, current: branch.current })),
        branchError: null,
        branchesLoading: false,
      });
    } catch (err) {
      if (epoch !== this.statusEpoch) return;
      console.debug("[Spectrolite] listBranches failed:", err);
      this.store.setState({ branches: [], branchError: formatGitError("branches", err), branchesLoading: false });
    }
  }

  /**
   * Commit everything dirty with the store's commit message. Publishes a
   * kb.commit custom message so chat observers see the commit. The caller
   * (CommitBar) renders the returned error, if any.
   */
  async commit(): Promise<{ sha: string } | { error: string }> {
    const initialState = this.store.getState();
    const root = initialState.repoRoot;
    const message = initialState.commitMessage;
    const subject = commitSubject(message);
    if (!root || !subject) return { error: "Commit message is required" };
    try {
      this.store.setState({ gitOperation: "flushing" });
      await this.hooks.flushAllDirty();
      const afterFlush = this.store.getState();
      if (Object.values(afterFlush.buffers).some(hasUnflushedChanges)) {
        return { error: UNFLUSHED_COMMIT_ERROR };
      }
      this.store.setState({ gitOperation: "committing" });
      const git = runtimeGit.client();
      const status = await git.status(root);
      const dirty = (status.files ?? [])
        .filter((file) => file.status !== "unmodified" && file.status !== "ignored")
        .map((file) => file.path);
      if (dirty.length === 0) return { error: "No changes to commit" };
      await git.addAll(root);
      const sha = await git.commit({ dir: root, message });
      const client = this.store.getState().client;
      if (client && sha) {
        client.publishCustomMessage({
          typeId: KB_COMMIT_TYPE,
          initialState: {
            sha,
            subject,
            body: message.slice(subject.length).trim(),
            files: dirty,
            at: Date.now(),
            editorContextId: runtimeContextId,
          },
          displayMode: "row",
        }).catch((err) => console.warn("[Spectrolite] kb.commit publish failed:", err));
      }
      this.store.setState({ commitMessage: "" });
      void this.refreshStatus();
      void this.refreshBranches();
      return { sha };
    } catch (err) {
      console.warn("[Spectrolite] commit failed:", err);
      return { error: formatGitError("commit", err) };
    } finally {
      this.store.setState({ gitOperation: null });
    }
  }

  /**
   * Switch branches. Refuses (with a stable, user-facing error string)
   * when the tree is dirty; falls back to a force checkout when a plain
   * checkout fails but the tree is verifiably clean.
   */
  async checkout(name: string): Promise<void> {
    const state = this.store.getState();
    const root = state.repoRoot;
    const current = state.branches.find((branch) => branch.current)?.name;
    if (!root || state.checkoutBusy || name === current) return;
    this.store.setState({ checkoutBusy: true, branchError: null, gitOperation: "flushing" });
    const git = runtimeGit.client();
    const dirtyFiles = async () => {
      const status = await git.status(root);
      return (status.files ?? []).filter((file) => file.status !== "unmodified" && file.status !== "ignored");
    };
    try {
      await this.hooks.flushAllDirty();
      if (Object.values(this.store.getState().buffers).some(hasUnflushedChanges)) {
        this.store.setState({ branchError: UNFLUSHED_CHECKOUT_ERROR });
        return;
      }
      if ((await dirtyFiles()).length > 0) {
        this.store.setState({ branchError: BRANCH_DIRTY_ERROR });
        return;
      }
      this.store.setState({ gitOperation: "checkout" });
      const forceCheckoutIfClean = async (checkoutErr?: unknown) => {
        if ((await dirtyFiles()).length > 0) throw checkoutErr ?? new Error(BRANCH_DIRTY_ERROR);
        await git.checkout(root, name, { force: true });
      };
      try {
        await git.checkout(root, name);
        const next = await git.status(root);
        if (next.branch !== name) await forceCheckoutIfClean();
      } catch (checkoutErr) {
        await forceCheckoutIfClean(checkoutErr);
      }
      void this.refreshStatus();
      void this.refreshBranches();
    } catch (err) {
      console.warn("[Spectrolite] checkout failed:", err);
      this.store.setState({ branchError: formatGitError("checkout", err) });
    } finally {
      this.store.setState({ checkoutBusy: false, gitOperation: null });
    }
  }
}
