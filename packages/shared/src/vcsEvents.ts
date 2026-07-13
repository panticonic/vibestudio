export interface VcsAdvanceActor {
  id: string;
  kind: string;
}

export interface VcsHeadFileChange {
  kind: "added" | "removed" | "changed";
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  oldMode: number | null;
  newMode: number | null;
}

export interface VcsHeadEditOp {
  kind: "replace" | "write" | "create" | "delete" | "chmod";
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  hunks?: unknown;
  mode?: number | null;
}

export interface VcsHeadAdvance {
  head: string;
  stateHash: string;
  repoStateHash: string;
  sinceStateHash: string | null;
  eventId: string | null;
  headHash: string | null;
  actor: VcsAdvanceActor | null;
  transitionKind: "snapshot" | "edit" | "merge" | "merge-resolution";
  changedPaths: string[];
  fileChanges: VcsHeadFileChange[];
  editOps: VcsHeadEditOp[];
}

export interface VcsWorkingAdvance {
  head: string;
  repoPath?: string;
  actor: VcsAdvanceActor | null;
  stateHash: string;
  baseStateHash: string;
  editSeq: number;
  changedPaths: string[];
}
