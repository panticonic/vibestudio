export { DiffViewer } from "./kit/diff/DiffViewer";
export type { DiffViewerProps } from "./kit/diff/DiffViewer";
export type {
  DiffReviewEntry,
  DiffChangedFile,
  DiffFileKind,
  DiffStat,
  DiffContentFetcher,
} from "./kit/diff/types";
export { diffLines, splitLines, allAdded, allRemoved } from "./kit/diff/lineDiff";
export type { DiffRow, DiffRowType, LineDiffResult } from "./kit/diff/lineDiff";
export { languageForPath } from "./kit/diff/highlight";
