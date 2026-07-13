import { createDevLogger } from "@vibestudio/dev-log";
import { getBytes, type TreeDiff } from "../services/blobstoreService.js";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";
import { VCS_MAIN_HEAD, joinRepoPrefix, normalizeRepoPathForLog } from "./paths.js";
import type { DiscoveredRepo } from "./repoDiscovery.js";
import type { VcsGadCaller } from "./gadCaller.js";
import type { WorktreeStore } from "./worktreeStore.js";

const log = createDevLogger("VcsMemory");
const MAX_INDEXED_FILE_BYTES = 256 * 1024;

export interface WorkspaceVcsMemoryDeps {
  blobsDir: string;
  gad: VcsGadCaller;
  isAttached(): boolean;
  subscribeStateAdvanced(listener: (event: StateAdvancedEvent) => void): () => void;
  discoverRepositories(): Promise<DiscoveredRepo[]>;
  resolveMain(repoPath: string): Promise<string | null>;
  diffStates(leftStateHash: string, rightStateHash: string): Promise<TreeDiff>;
  worktrees: Pick<WorktreeStore, "listStateFiles">;
}

/**
 * Owns file-text memory indexing and recall dispatch. The queue serializes
 * initial catch-up with incremental main advances, while marker discipline
 * guarantees transient CAS misses never become permanent recall gaps.
 */
export class WorkspaceVcsMemory {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WorkspaceVcsMemoryDeps) {}

  enable(options: { startupBarrier?: Promise<void> } = {}): void {
    if (options.startupBarrier) {
      this.queue = this.queue
        .then(() => options.startupBarrier)
        .catch((error) => console.warn("[VcsMemory] startup barrier failed:", error));
    }
    this.deps.subscribeStateAdvanced((event) => {
      if (event.head !== VCS_MAIN_HEAD) return;
      this.queue = this.queue
        .then(() => this.indexRepository(event.repoPath))
        .catch((error) => console.warn("[VcsMemory] index failed:", error));
    });
    this.queue = this.queue
      .then(() => this.reindexKnownRepositories())
      .catch((error) => console.warn("[VcsMemory] initial index failed:", error));
  }

  async reindexKnownRepositories(): Promise<void> {
    if (!this.deps.isAttached()) return;
    for (const repo of await this.deps.discoverRepositories()) {
      await this.indexRepository(repo.repoPath).catch((error) =>
        console.warn(`[VcsMemory] reindex for ${repo.repoPath} failed:`, error)
      );
    }
  }

  async indexRepository(repoPath: string): Promise<void> {
    if (!this.deps.isAttached()) return;
    const normalizedRepo = normalizeRepoPathForLog(repoPath);
    const stateHash = await this.deps.resolveMain(normalizedRepo);
    if (!stateHash) return;
    const markerKey = `memidx:${normalizedRepo}`;
    const marker = (
      await this.deps.gad.call<{ value: string | null }>("getMemoryIndexMarker", {
        key: markerKey,
      })
    ).value;
    if (marker === stateHash) return;

    const reroot = (filePath: string): string => joinRepoPrefix(normalizedRepo, filePath);
    const files: Array<{ path: string; contentHash: string; text: string }> = [];
    let removedPaths: string[] = [];
    const wanted: Array<{ path: string; content_hash: string }> = [];
    if (marker) {
      const diff = await this.deps.diffStates(marker, stateHash);
      wanted.push(
        ...diff.added.map((file) => ({
          path: file.path,
          content_hash: file.contentHash,
        })),
        ...diff.changed.map((file) => ({
          path: file.path,
          content_hash: file.toContentHash,
        }))
      );
      removedPaths = diff.removed.map((file) => reroot(file.path));
    } else {
      wanted.push(...(await this.deps.worktrees.listStateFiles(stateHash)));
    }

    for (const file of wanted) {
      const bytes = await getBytes(this.deps.blobsDir, file.content_hash);
      if (!bytes) {
        console.warn(
          `[VcsMemory] index aborted for ${normalizedRepo}: missing CAS blob ${file.content_hash} ` +
            `for ${reroot(file.path)}; marker left at prior state, will retry on next advance`
        );
        return;
      }
      if (bytes.length > MAX_INDEXED_FILE_BYTES) {
        log.verbose(
          `skip ${reroot(file.path)}: over index size cap ` +
            `(${bytes.length} > ${MAX_INDEXED_FILE_BYTES} bytes)`
        );
        continue;
      }
      if (bytes.subarray(0, 8192).includes(0)) {
        log.verbose(`skip ${reroot(file.path)}: binary content (null byte sniff)`);
        continue;
      }
      files.push({
        path: reroot(file.path),
        contentHash: file.content_hash,
        text: bytes.toString("utf8"),
      });
    }

    if (files.length > 0 || removedPaths.length > 0) {
      await this.deps.gad.call("indexMemoryFiles", { files, removedPaths });
    }
    await this.deps.gad.call("setMemoryIndexMarker", {
      key: markerKey,
      value: stateHash,
    });
  }

  async recall(input: {
    query: string;
    kinds?: string[];
    limit?: number;
    repoPaths?: string[];
    recallKeywords?: string[];
  }): Promise<unknown> {
    const { repoPaths, ...rest } = input;
    const pathPrefixes =
      repoPaths && repoPaths.length > 0
        ? repoPaths.map((repoPath) => normalizeRepoPathForLog(repoPath))
        : null;
    return this.deps.gad.call("recallMemory", {
      ...rest,
      ...(pathPrefixes ? { pathPrefixes } : {}),
    });
  }
}
