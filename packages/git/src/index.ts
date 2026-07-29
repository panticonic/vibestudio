/**
 * @vibestudio/git - Git operations for external repositories
 *
 * Provides git clone/pull/push operations using isomorphic-git,
 * designed to work with an injected filesystem implementation.
 *
 * Usage:
 * ```typescript
 * import { GitClient } from "@vibestudio/git";
 * import { promises as fsPromises } from "fs"; // RPC-backed in panels
 *
 * // Use a host-mediated credential HTTP adapter for external remotes:
 * const git = new GitClient(fsPromises, {
 *   http: credentials.gitHttp(),
 *   authorIdentity: { handle: "alice", displayName: "Alice" },
 * });
 *
 * // Clone a repository
 * await git.clone({
 *   url: "https://github.com/owner/my-panel.git",
 *   dir: "/src",
 *   ref: "main",
 * });
 *
 * // Make changes and push
 * await git.addAll("/src");
 * await git.commit({ dir: "/src", message: "Update" });
 * await git.push({ dir: "/src" });
 * ```
 */

export {
  GitClient,
  GitAuthError,
  GitPushRejectedError,
  SYSTEM_GIT_AUTHOR,
  type FsPromisesLike,
  type GitAuthorIdentity,
  type GitCommitTreeEntry,
  type GitLogEntry,
} from "./client.js";
export { initAndPush, type InitAndPushOptions } from "./convenience.js";
export {
  acquireExactGitSnapshot,
  discoverDefaultGitSnapshot,
  discoverExactGitSnapshot,
  discoverTrackedGitSnapshot,
  readExactGitSnapshot,
  type SnapshotContentSink,
  type ExactSnapshotFile,
  type ExactGitSnapshot,
  type ReservedPathPolicy,
  type AcquireExactGitSnapshotOptions,
  type DiscoverDefaultGitSnapshotOptions,
  type DiscoverExactGitSnapshotOptions,
  type DiscoverTrackedGitSnapshotOptions,
} from "./exact-snapshot.js";
export {
  readThroughImmutableGitCheckout,
  withTemporaryGitCheckout,
  type AtomicCheckoutFilesystem,
} from "./checkout-cache.js";

export type {
  GitClientOptions,
  CloneOptions,
  PullOptions,
  PushOptions,
  FetchResult,
  CommitOptions,
  FileStatus,
  StatusMatrixRow,
  RepoStatus,
  StashEntry,
  FileDiff,
  Hunk,
  DiffLine,
  HunkSelection,
  StageHunksOptions,
  BranchInfo,
  CreateBranchOptions,
  RemoteStatus,
  GitProgress,
  BlameLine,
  FileHistoryEntry,
  BinaryDiffInfo,
  ImageDiff,
} from "./types.js";
