/**
 * Durable host evidence for one atomic protected-main publication.
 *
 * Every repository pointer changes in one atomic protected publication CAS;
 * this non-ancestry effect notification exposes the complete batch once.
 */
export interface ProtectedPublicationFileChange {
  kind: "added" | "removed" | "changed";
  /** Workspace-rooted path. */
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  oldExecutable: boolean | null;
  newExecutable: boolean | null;
}

export interface ProtectedPublicationRepositoryChange {
  repoPath: string;
  previousStateHash: string | null;
  nextStateHash: string | null;
  fileChanges: ProtectedPublicationFileChange[];
}

export interface ProtectedPublicationEvent {
  /** Stable semantic publication identity, also used for host replay. */
  publicationId: string;
  /** Host-computed digest of the exact protected-ref vector after the atomic CAS. */
  resultHostRefsBasisDigest: string;
  /** Durable host CAS application time. */
  appliedAt: number;
  /** Exact workspace-rooted content state after the complete publication. */
  workspaceStateHash: string;
  /** Deduplicated workspace-rooted paths changed by the complete publication. */
  changedPaths: string[];
  /** Every repository pointer changed by the same protected-ref CAS. */
  repositories: ProtectedPublicationRepositoryChange[];
}
