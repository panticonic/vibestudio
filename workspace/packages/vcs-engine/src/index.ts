/**
 * @workspace/vcs-engine — userland VCS engine (eviction stages P5b/P5c).
 *
 * Pure, workerd-safe VCS semantics over content-addressed worktree states:
 * the vendored diff3 text merge, the three-way MergeEngine, the EditEngine
 * (edit-op application + provenance hunks), and the edit-boundary path
 * policy. Consumed by the gad-store DO (`computeMerge`, `applyEditOps`,
 * `commitWorking`, …); the host talks to the DO, never to this package
 * directly.
 */

export {
  MergeEngine,
  type MergeComputation,
  type StateFileEntry,
  type MergeHunk,
} from "./mergeEngine.js";
export { mergeHunksVsOurs, diff3Merge, computeReplaceHunks } from "./diff3.js";
export {
  EditEngine,
  decodeUtf8Text,
  hasConflictMarkers,
  type EditOp,
  type WorkingFileEntry,
} from "./editEngine.js";
export { VCS_IGNORED_DIRS, VCS_IGNORED_FILES } from "./paths.js";
export { discoverRepoPaths } from "./repos.js";
