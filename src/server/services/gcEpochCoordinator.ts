import type { BuildSystemV2 } from "../buildV2/index.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import {
  executionSourceContentRoot,
  type ExecutionSourceContentRoot,
} from "./executionSourceRoots.js";
import type { ExecutionPublicationJournal } from "../executionPublicationJournal.js";

export const DEFAULT_VCS_GC_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_VCS_GC_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_VCS_GC_INITIAL_DELAY_MS = 60_000;

/**
 * Owns one GC epoch across the build-retention root snapshot and semantic
 * content collection. It first takes the immutable execution-root snapshot,
 * then traverses every source closure without mutating either store. Artifact
 * quarantine/sweep and content sweep may commit only after that shared
 * preflight succeeds.
 */
export class GcEpochCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      buildSystem: Pick<BuildSystemV2, "prepareGc" | "peekBuildByKey">;
      workspaceVcs: Pick<WorkspaceVcs, "attached" | "prepareGc">;
      publicationJournal: Pick<
        ExecutionPublicationJournal,
        "beginEpoch" | "protectedBuildKeys" | "completeEpoch" | "commitArtifactDeletion"
      > & { ambiguousPublications?: ExecutionPublicationJournal["ambiguousPublications"] };
      minAgeMs?: number;
      intervalMs?: number;
      initialDelayMs?: number;
      logger?: { warn(message: string, error: unknown): void };
    }
  ) {}

  start(): void {
    if (this.timer) return;
    this.schedule(this.deps.initialDelayMs ?? DEFAULT_VCS_GC_INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<boolean> {
    if (this.running || !this.deps.workspaceVcs.attached) return false;
    this.running = true;
    const epoch = this.deps.publicationJournal.beginEpoch();
    try {
      // This snapshot is read-only. In particular, no artifact can be renamed
      // before semantic source traversal proves the whole shared epoch safe.
      const buildPreparation = await this.deps.buildSystem.prepareGc({ epoch });
      const retention = buildPreparation.report;
      if (!retention.complete) {
        throw new Error(
          `build retention root snapshot is incomplete (${retention.providerFailures.length} provider failure${retention.providerFailures.length === 1 ? "" : "s"})`
        );
      }
      if (retention.unresolvedAuthoritativeRootBuildKeys.length > 0) {
        throw new Error(
          `build retention root snapshot has ${retention.unresolvedAuthoritativeRootBuildKeys.length} unresolved authoritative root${retention.unresolvedAuthoritativeRootBuildKeys.length === 1 ? "" : "s"}`
        );
      }
      const executionSourceRoots = this.mergeSourceRoots([
        ...this.executionSourceRoots(retention.storedRootBuildKeys),
        ...retention.retainedSourceRoots,
      ]);
      const contentPreparation = await this.deps.workspaceVcs.prepareGc({
        minAgeMs: this.deps.minAgeMs ?? DEFAULT_VCS_GC_MIN_AGE_MS,
        epoch,
        executionSourceRoots,
      });
      const committedRetention = await buildPreparation.commit({
        publicationProtectedBuildKeys: this.deps.publicationJournal.protectedBuildKeys(epoch),
        commitArtifactDeletion: (buildKey, commit) =>
          this.deps.publicationJournal.commitArtifactDeletion(epoch, buildKey, commit),
      });
      if (
        !committedRetention.complete ||
        committedRetention.unresolvedAuthoritativeRootBuildKeys.length > 0 ||
        committedRetention.notReconstructible > 0 ||
        committedRetention.cleanupFailures.length > 0
      ) {
        throw new Error("build retention commit did not complete cleanly");
      }
      const preparedSourceRoots = new Set(
        executionSourceRoots.map((root) => `${root.repoPath ?? ""}\0${root.stateHash}`)
      );
      const unpreparedSourceRoots = committedRetention.retainedSourceRoots.filter(
        (root) => !preparedSourceRoots.has(`${root.repoPath ?? ""}\0${root.stateHash}`)
      );
      if (unpreparedSourceRoots.length > 0) {
        throw new Error(
          `build retention commit discovered ${unpreparedSourceRoots.length} source root${unpreparedSourceRoots.length === 1 ? "" : "s"} after content preflight`
        );
      }
      await contentPreparation.commit();
      this.deps.publicationJournal.completeEpoch(epoch, new Set(committedRetention.rootBuildKeys));
      const ambiguous = this.deps.publicationJournal.ambiguousPublications?.() ?? [];
      if (ambiguous.length > 0) {
        (this.deps.logger ?? console).warn(
          `[GcEpochCoordinator] ${ambiguous.length} ambiguous execution publication reservation${ambiguous.length === 1 ? "" : "s"} retained`,
          ambiguous
        );
      }
      return true;
    } catch (error) {
      (this.deps.logger ?? console).warn("[GcEpochCoordinator] GC run failed", error);
      return false;
    } finally {
      this.running = false;
    }
  }

  private executionSourceRoots(rootBuildKeys: readonly string[]): ExecutionSourceContentRoot[] {
    const roots = new Map<string, ExecutionSourceContentRoot>();
    for (const key of rootBuildKeys) {
      const build = this.deps.buildSystem.peekBuildByKey(key);
      if (!build) {
        throw new Error(`rooted build ${key} has no verified build metadata`);
      }
      if (build.buildKey !== key || build.metadata.buildKey !== key) {
        throw new Error(`rooted build ${key} has mismatched build metadata`);
      }
      if (build.sourceStateHash !== build.metadata.sourceStateHash) {
        throw new Error(`rooted build ${key} has inconsistent source state metadata`);
      }
      const root = executionSourceContentRoot({
        repoPath: build.metadata.sourcePath,
        stateHash: build.metadata.sourceStateHash,
      });
      const existing = roots.get(root.stateHash);
      if (!existing || (root.repoPath ?? "").localeCompare(existing.repoPath ?? "") < 0) {
        roots.set(root.stateHash, root);
      }
    }
    return [...roots.values()].sort(
      (left, right) =>
        left.stateHash.localeCompare(right.stateHash) ||
        (left.repoPath ?? "").localeCompare(right.repoPath ?? "")
    );
  }

  private mergeSourceRoots(
    candidates: readonly ExecutionSourceContentRoot[]
  ): ExecutionSourceContentRoot[] {
    const roots = new Map<string, ExecutionSourceContentRoot>();
    for (const root of candidates) {
      roots.set(`${root.repoPath ?? ""}\0${root.stateHash}`, root);
    }
    return [...roots.values()].sort(
      (left, right) =>
        left.stateHash.localeCompare(right.stateHash) ||
        (left.repoPath ?? "").localeCompare(right.repoPath ?? "")
    );
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() =>
        this.schedule(this.deps.intervalMs ?? DEFAULT_VCS_GC_INTERVAL_MS)
      );
    }, delay);
    this.timer.unref?.();
  }
}
