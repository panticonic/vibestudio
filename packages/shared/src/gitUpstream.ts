/**
 * Wire shapes of the external Git upstream API. Host callers reach this through
 * the `gitInterop.*` service; workspace/userland callers may still use the
 * configured provider directly where appropriate. The shared types keep the
 * contract declared exactly once.
 */

export type GitUpstreamState =
  | "in-sync"
  | "ahead"
  | "behind"
  | "diverged"
  | "auth-failed"
  | "error"
  | "exporting"
  | "pushing"
  | "local-only";

export interface GitUpstreamStatusRow {
  repoPath: string;
  remote?: string;
  branch?: string;
  autoPush: boolean;
  state: GitUpstreamState;
  aheadBy: number;
  behindBy: number;
  lastPushedSha?: string;
  lastPushedAt?: number;
  lastError?: string;
}

export interface GitOverwritePreview {
  count: number;
  commits: Array<{ sha: string; summary: string }>;
}

export interface GitPushUpstreamResult {
  exported: number;
  headCommit: string | null;
  pushed: boolean;
  status: GitUpstreamState;
  overwrites?: GitOverwritePreview;
}

export interface GitPullUpstreamResult {
  behindBy: number;
  aheadBy: number;
  incoming: Array<{ sha: string; summary: string }>;
  imported?: { changed?: boolean; stateHash?: string };
}

/** Compact "2m ago"-style rendering shared by the CLI and the Git tab. */
export function formatRelativeTime(ms: number | undefined): string {
  if (!ms) return "never";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
