/**
 * PublishController — the VCS-native publish UX (plan section F).
 *
 * Under GAD-native editing the vault lives on a durable per-vault context head
 * (`ctx:vault-<hash>`); `main` / `/projects` move only on an explicit Publish.
 * This controller drives:
 *  - the always-visible **"● N unpublished changes"** indicator
 *    (`vcs.publishStatus` = ctx-head-vs-`main` diff, NOT `vcs.status`),
 *  - one-click **Publish**, and
 *  - **pending-merge** display / resolution.
 *
 * Publish is **pull-main-then-publish**: first merge `main` *into* the vault's
 * ctx head (which the panel may write), then publish ctx→`main`. So any
 * divergence conflicts in the panel's OWN head — resolvable with the normal
 * editor conflict tooling — and the ctx→`main` step is always a clean
 * fast-forward. Conflicts never park unresolvably on `main`.
 *
 * Store-shaped (snapshot + subscribe) and pure over an injected vcs surface, so
 * it is unit-testable without a server.
 */

export interface PublishMergeResult {
  status: "up-to-date" | "merged" | "conflicted";
  conflicts: Array<{ path: string; kind: string }>;
}

export interface PublishVcs {
  publishStatus(head?: string): Promise<{
    ahead: number;
    files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  }>;
  /** Merge another head into the caller's ctx head (pull main → ctx). */
  merge(sourceHead: string, targetHead?: string): Promise<PublishMergeResult>;
  /** Privileged ctx→main publish (fast-forward after the pull). */
  publish(sourceHead?: string): Promise<PublishMergeResult>;
  pendingMerge(targetHead?: string): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
  } | null>;
  abortMerge(targetHead?: string): Promise<{ aborted: boolean }>;
}

export interface PublishSnapshot {
  ahead: number;
  files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  publishing: boolean;
  /** A conflicted pull parked on the panel's own ctx head, awaiting resolution. */
  pending: { theirsHead: string; conflicts: Array<{ path: string; kind: string }> } | null;
  lastError: string | null;
}

export type PublishOutcome =
  | { status: "published" }
  | { status: "up-to-date" }
  | { status: "needs-resolve" }
  | { status: "error"; message: string };

const EMPTY: PublishSnapshot = {
  ahead: 0,
  files: [],
  publishing: false,
  pending: null,
  lastError: null,
};

export class PublishController {
  private snap: PublishSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly vcs: PublishVcs) {}

  getSnapshot(): PublishSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<PublishSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Recompute the unpublished count + any pending merge (call on head advance). */
  async refresh(): Promise<void> {
    try {
      const [status, pending] = await Promise.all([
        this.vcs.publishStatus(),
        this.vcs.pendingMerge(),
      ]);
      this.set({ ahead: status.ahead, files: status.files, pending, lastError: null });
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
    }
  }

  /**
   * Publish the vault to `main`: pull `main` into ctx first (so conflicts land
   * in the panel's own head), then fast-forward ctx→`main`.
   */
  async publish(): Promise<PublishOutcome> {
    if (this.snap.publishing) return { status: "error", message: "already publishing" };
    this.set({ publishing: true, lastError: null });
    try {
      // Publish is pull-main-then-ctx→main. A conflict in the PULL parks on the
      // caller's own ctx head (resolvable in-editor → needs-resolve). A conflict
      // in the ctx→main step is a TOCTOU (main advanced again after the pull);
      // the server rolls that back (a panel can't resolve a main-parked merge),
      // so we re-pull the newer main and retry, bounded.
      for (let attempt = 0; attempt < 3; attempt++) {
        const pull = await this.vcs.merge("main");
        if (pull.status === "conflicted") {
          const pending = await this.vcs.pendingMerge();
          this.set({ pending });
          return { status: "needs-resolve" };
        }
        const result = await this.vcs.publish();
        if (result.status === "conflicted") continue; // main moved; re-pull + retry
        await this.refresh();
        return { status: result.status === "up-to-date" ? "up-to-date" : "published" };
      }
      return {
        status: "error",
        message: "Publish kept racing a concurrent change to main — please try again.",
      };
    } catch (error) {
      const message = errorMessage(error);
      this.set({ lastError: message });
      return { status: "error", message };
    } finally {
      this.set({ publishing: false });
    }
  }

  /** Abandon a conflicted pull, restoring the pre-merge ctx tree. */
  async abort(): Promise<void> {
    try {
      await this.vcs.abortMerge();
      this.set({ pending: null });
      await this.refresh();
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
