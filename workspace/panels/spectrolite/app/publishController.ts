/** Commit local work, integrate protected main locally, then publish. */

import {
  VaultSemanticVcs,
  type VaultIntegrationConflict,
  type VaultIntegrationResult,
} from "./semanticVcs";

export interface VaultPublishingSession {
  readonly repoPath: string;
  refresh(): ReturnType<VaultSemanticVcs["refresh"]>;
  integrateMain(): ReturnType<VaultSemanticVcs["integrateMain"]>;
  keepLocalForMain(changeIds: string[]): ReturnType<VaultSemanticVcs["keepLocalForMain"]>;
  commit(message: string | null): ReturnType<VaultSemanticVcs["commit"]>;
  pendingChangeCount(): ReturnType<VaultSemanticVcs["pendingChangeCount"]>;
  push(): ReturnType<VaultSemanticVcs["push"]>;
}

export interface PublishSnapshot {
  pendingChanges: number;
  relationship: "at" | "ahead" | "behind" | "diverged" | null;
  publishing: boolean;
  lastError: string | null;
  conflicts: VaultIntegrationConflict[];
}

export type PublishOutcome =
  | { status: "published" | "up-to-date" }
  | { status: "error"; message: string };

export type CommitWorkingCopy = (
  message: string
) => Promise<{ eventId: string; changed: boolean } | null>;

const EMPTY: PublishSnapshot = {
  pendingChanges: 0,
  relationship: null,
  publishing: false,
  lastError: null,
  conflicts: [],
};

export class PublishController {
  private snap: PublishSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(
    private session: VaultPublishingSession | null,
    private readonly onIntegrated?: () => void | Promise<void>,
    private readonly commitWorkingCopy?: CommitWorkingCopy
  ) {}

  /** Bind publishing to one repository without changing the panel context. */
  bindSession(session: VaultPublishingSession | null): void {
    if (this.session === session) return;
    this.session = session;
    this.snap = EMPTY;
    this.listeners.forEach((listener) => listener());
  }

  getSnapshot(): PublishSnapshot {
    return this.snap;
  }

  getRepo(): string {
    return this.session?.repoPath ?? "";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<PublishSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  async refresh(): Promise<void> {
    if (!this.session) return;
    try {
      const revision = await this.session.refresh();
      this.set({
        pendingChanges: revision.status.workingCounts.changes,
        relationship: revision.status.mainRelation,
        lastError: null,
      });
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
    }
  }

  async sync(): Promise<"up-to-date" | "integrated" | "conflicts" | "error"> {
    if (!this.session) return "up-to-date";
    try {
      const result = await this.session.integrateMain();
      if (typeof result !== "string") {
        this.set({ conflicts: result.conflicts, lastError: null });
        return "conflicts";
      }
      if (result === "integrated") await this.onIntegrated?.();
      this.set({ conflicts: [] });
      await this.refresh();
      return result;
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
      return "error";
    }
  }

  async keepLocal(changeIds: string[]): Promise<"integrated" | "conflicts" | "error"> {
    if (!this.session) return "error";
    try {
      const result = await this.session.keepLocalForMain(changeIds);
      return await this.finishIntegration(result);
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
      return "error";
    }
  }

  async publish(message = "Publish"): Promise<PublishOutcome> {
    if (!this.session) return { status: "error", message: "No vault selected" };
    if (this.snap.publishing) return { status: "error", message: "already publishing" };
    this.set({ publishing: true, lastError: null });
    try {
      const committedByEditor = await this.commitWorkingCopy?.(message);
      const revision = await this.session.refresh();
      if (committedByEditor?.changed !== true && !revision.status.clean) {
        await this.session.commit(message);
      }

      const integrated = await this.session.integrateMain();
      if (typeof integrated !== "string") {
        this.set({ conflicts: integrated.conflicts });
        return {
          status: "error",
          message: "Published changes need an explicit conflict resolution before publishing",
        };
      }
      if (integrated === "integrated") await this.onIntegrated?.();
      this.set({ conflicts: [] });

      const beforePush = await this.session.refresh();
      if (beforePush.status.mainRelation === "at") {
        await this.refresh();
        return { status: "up-to-date" };
      }
      await this.session.push();
      await this.refresh();
      return { status: "published" };
    } catch (error) {
      const message = errorMessage(error);
      this.set({ lastError: message });
      return { status: "error", message };
    } finally {
      this.set({ publishing: false });
    }
  }

  private async finishIntegration(
    result: VaultIntegrationResult
  ): Promise<"integrated" | "conflicts"> {
    if (typeof result !== "string") {
      this.set({ conflicts: result.conflicts, lastError: null });
      return "conflicts";
    }
    if (result === "integrated") await this.onIntegrated?.();
    this.set({ conflicts: [], lastError: null });
    await this.refresh();
    return "integrated";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
