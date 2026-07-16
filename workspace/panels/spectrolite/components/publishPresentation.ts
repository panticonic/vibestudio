import type { PublishSnapshot } from "../app/publishController";

export interface PublishPresentation {
  count: number;
  uncommittedCount: number;
  hasUncommitted: boolean;
  hasChanges: boolean;
  publishBlocked: boolean;
  syncBlockedByUncommitted: boolean;
  statusLabel: string;
}

export function getPublishPresentation(
  snapshot: PublishSnapshot,
  dirtyCount: number
): PublishPresentation {
  const count = snapshot.pendingChanges;
  const uncommittedCount = Math.max(count, dirtyCount);
  const hasUncommitted = uncommittedCount > 0;
  const ahead = snapshot.relationship === "ahead";
  const needsSync = snapshot.relationship === "behind" || snapshot.relationship === "diverged";
  const hasChanges = hasUncommitted || ahead;
  const local = hasUncommitted
    ? `${uncommittedCount} local change${uncommittedCount === 1 ? "" : "s"}`
    : null;
  const statusLabel = needsSync
    ? local
      ? `Needs sync, ${local}`
      : "Needs sync"
    : local
      ? local[0]!.toUpperCase() + local.slice(1)
      : ahead
        ? "Ready to publish"
        : "Published";

  return {
    count,
    uncommittedCount,
    hasUncommitted,
    hasChanges,
    publishBlocked: false,
    syncBlockedByUncommitted: hasUncommitted,
    statusLabel,
  };
}
