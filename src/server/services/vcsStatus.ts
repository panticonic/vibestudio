export interface VcsHeadStatus {
  stateHash: string | null;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface UnitVcsStatus {
  unitPath: string;
  head: string;
  stateHash: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
  }>;
}

export function unitStatusFromHead(
  unitPath: string,
  head: string,
  status: VcsHeadStatus
): UnitVcsStatus {
  const within = (p: string) => p === unitPath || p.startsWith(`${unitPath}/`);
  const files = [
    ...status.added.filter(within).map((p) => ({ path: p, status: "added" as const })),
    ...status.changed.filter(within).map((p) => ({ path: p, status: "modified" as const })),
    ...status.removed.filter(within).map((p) => ({ path: p, status: "deleted" as const })),
  ];
  return {
    unitPath,
    head,
    stateHash: status.stateHash,
    dirty: files.length > 0,
    files,
  };
}
