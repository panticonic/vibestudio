/**
 * VCS naming + path policy — the host-side vocabulary of the per-repo VCS.
 *
 * Pure helpers with no store or disk dependencies: repo log ids
 * (`vcs:repo:<path>`), head names (`main`, `ctx:*`, `archived:*`), the
 * platform ignore sets shared by the worktree scanner and the edit-boundary
 * guards, and the path-safety assertions that keep attacker-controlled paths
 * out of GAD state. The userland twin of the edit-boundary policy lives in
 * `@workspace/vcs-engine` (paths.ts) — kept behaviorally in sync.
 */

import * as path from "node:path";

export const VCS_MAIN_HEAD = "main";

/** Head-name prefix for an archived (deleted) repo's preserved history. A repo
 *  log carrying an `archived:*` head was retired through `vcs.deleteRepo`: its
 *  `main` is gone but its lineage is parked here (recoverable). Used to refuse
 *  silent resurrection of a deleted repo by a stale-context push. */
export const VCS_ARCHIVE_HEAD_PREFIX = "archived:";

/** Log-id prefix for per-repo VCS logs (`vcs:repo:<path>`). */
export const VCS_REPO_LOG_PREFIX = "vcs:repo:";

/**
 * Per-repo VCS log id. Each workspace repo (`packages/foo`, `panels/chat`,
 * `projects/<vault>`, `meta`) is a first-class versioned unit with its own GAD
 * log and heads (`main`, `ctx:*`); the workspace state is the live union of
 * every repo's `main` (see `composeRepoStatesLocal`). A repo's state is
 * subtree-rooted (paths relative to the repo).
 */
export function logIdForRepo(repoPath: string): string {
  return `vcs:repo:${normalizeRepoPathForLog(repoPath)}`;
}

/** Inverse of {@link logIdForRepo}: the repo path for a `vcs:repo:<path>` log id,
 *  or null for a non-repo log id. */
export function repoPathFromLogId(logId: string): string | null {
  return logId.startsWith(VCS_REPO_LOG_PREFIX) ? logId.slice(VCS_REPO_LOG_PREFIX.length) : null;
}

/**
 * Normalize a workspace-relative repo path for use as a log id. Most repos are
 * `section/key` (2 segments); flat sections that hold files directly rather than
 * repo subdirs (today `meta`) are single-segment repos.
 */
export function normalizeRepoPathForLog(repoPath: string): string {
  // Canonical repo identity — one string backs the log id (`vcs:repo:<norm>`),
  // the materializedFor cache, and the projection dir. Reject every non-canonical
  // alias `refService.validateRepoPath` rejects (`.`/`..`/empty segments, so no
  // interior `//`, and no leading/trailing slash) rather than silently rewriting,
  // so aliases like `panels/./chat`, `panels//chat`, and `panels/chat/` can never
  // split into a second identity that collides on disk with `panels/chat`.
  const normalized = repoPath.replace(/\\/g, "/");
  if (!normalized) {
    throw new Error(`Invalid workspace repo path: ${repoPath}`);
  }
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid workspace repo path: ${repoPath}`);
    }
  }
  return normalized;
}

export function vcsContextHead(contextId: string): string {
  return `ctx:${validateVcsContextId(contextId)}`;
}

/**
 * Context ids are allowed to contain slashes for historical panel ids, but
 * never path traversal, absolute paths, empty path segments, or NUL bytes.
 */
export function validateVcsContextId(contextId: string): string {
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new Error("Invalid VCS context id: empty");
  }
  if (contextId.includes("\0") || contextId.includes("\\") || path.isAbsolute(contextId)) {
    throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
  }
  for (const segment of contextId.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
    }
  }
  return contextId;
}

export function contextIdFromVcsHead(head: string): string {
  if (!head.startsWith("ctx:")) throw new Error(`Not a VCS context head: ${head}`);
  return validateVcsContextId(head.slice("ctx:".length));
}

/** Prefix a repo-relative path back to its workspace-relative location. */
export function joinRepoPrefix(repoPath: string, relPath: string): string {
  const norm = normalizeRepoPathForLog(repoPath);
  return relPath ? `${norm}/${relPath}` : norm;
}

/**
 * Directories never snapshotted. These are platform invariants, not user
 * preferences: they contain VCS metadata, dependency caches, generated output,
 * or runtime state that must not enter the durable file graph.
 */
export const ALWAYS_IGNORED_DIRS = new Set([
  ".git",
  ".gad",
  ".contexts",
  ".databases",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  ".vibez1",
  ".turbo",
  ".vite",
  ".tmp",
  ".testkit",
  "node_modules",
  "dist",
  "out",
  "coverage",
  "test-results",
  "dist_electron",
  "release",
]);

export const ALWAYS_IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".npmrc",
  ".secrets.yml",
  "firebase-service-account.json",
  "google-services.json",
  "GoogleService-Info.plist",
]);

export const SNAPSHOT_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  "*.sublime-workspace",
  "*~",
  "*.tsbuildinfo",
  "*.tgz",
  ".npmrc.dist-tag-temp",
];

/**
 * Worktree file listing the paths of an in-progress merge's conflicts (with
 * their kind). Written into a head's working tree while a merge is pending so
 * non-content conflicts (mode/binary/delete-vs-change) — which leave no in-file
 * `<<<<<<<` markers — are visible to CLI/agent/direct users; removed when the
 * merge resolves or aborts. Ignored by snapshots so it never enters the graph.
 */
export const MERGE_CONFLICTS_FILE = "MERGE_CONFLICTS.md";

/**
 * Reject a state file path that could escape its worktree root when joined onto
 * a directory: absolute, leading slash, any `..` segment, empty, or containing a
 * NUL byte. Called at the edit boundary so attacker-controlled paths never enter
 * GAD state. (Snapshot scans produce safe relative paths by construction.)
 */
export function assertSafeVcsPath(p: string): void {
  if (p.length === 0) {
    throw new Error(
      "vcs path is empty; edit paths must name a file inside the repo, not the repo root."
    );
  }
  if (
    p.includes("\0") ||
    p.startsWith("/") ||
    path.isAbsolute(p) ||
    p.split(/[/\\]/).some((seg) => seg === "..")
  ) {
    throw new Error(`vcs path escapes worktree: ${JSON.stringify(p)}`);
  }
  // The tree encoder (splitTreePath/assertValidTreeEntryName) additionally
  // rejects `.` segments, empty segments (`a//b`, `./a`, `foo/`, `.`), and any
  // backslash inside a segment. Enforce the same here so such paths fail at the
  // edit boundary rather than passing the guard, entering the working map as a
  // phantom key, and only throwing later at tree-encode time.
  if (p.includes("\\") || p.split("/").some((seg) => seg === "" || seg === ".")) {
    throw new Error(`vcs path is not a valid tree path: ${JSON.stringify(p)}`);
  }
}

let platformIgnoreMatcher: { ignores: (s: string) => boolean } | null = null;

/**
 * Reject a new state path that the snapshot scan would itself exclude — VCS
 * internals (`.git`, `.gad`), generated dirs (`node_modules`, `dist`), and
 * secret/env files (`.env`, `.npmrc`, `.secrets.yml`, …). Without this, an
 * edit-ingress caller (vcs.edit) could write such a path into GAD state
 * (the scan denylist only runs on disk→state, not on caller→state), and
 * materializeState would write it to disk — e.g. planting `.git/hooks/*` or a
 * `.env`, or shadowing internal VCS state. Only platform-invariant exclusions
 * are enforced here (not the user's dynamic `.gadignore`).
 */
export async function assertWritableVcsPath(p: string): Promise<void> {
  // Actionable hint: the guard is a denylist (anything not platform-ignored is trackable), so steer
  // callers to a concrete writable location rather than just naming the rejected one.
  const hint =
    "VCS tracks workspace source — write to a non-ignored path (e.g. projects/…, panels/…, packages/…), " +
    "not a platform-ignored dir (.vibez1, .git, .gad, .tmp, node_modules, dist) or ignored file (.env, *.log).";
  const segs = p.split("/");
  for (const seg of segs.slice(0, -1)) {
    if (ALWAYS_IGNORED_DIRS.has(seg)) {
      throw new Error(`vcs path is in a platform-ignored directory: ${JSON.stringify(p)}. ${hint}`);
    }
  }
  const base = segs.at(-1) ?? "";
  if (ALWAYS_IGNORED_DIRS.has(base) || ALWAYS_IGNORED_FILES.has(base)) {
    throw new Error(`vcs path is platform-ignored: ${JSON.stringify(p)}. ${hint}`);
  }
  if (!platformIgnoreMatcher) {
    const { default: ignore } = await import("ignore");
    platformIgnoreMatcher = ignore().add(SNAPSHOT_IGNORE_PATTERNS);
  }
  if (platformIgnoreMatcher.ignores(p)) {
    throw new Error(`vcs path is platform-ignored: ${JSON.stringify(p)}. ${hint}`);
  }
}

/**
 * Whether `p` is a GAD-trackable path — i.e. exactly the set `edit`
 * accepts (safe + not platform-ignored). The fs-service reroute uses this to
 * decide whether a context mutation must go through GAD (`edit`) or is a
 * scratch/ignored path (`.tmp`, `.testkit`, `node_modules`, `*.log`, …) that
 * stays a direct disk write.
 */
export async function isWritableVcsPath(p: string): Promise<boolean> {
  try {
    assertSafeVcsPath(p);
    await assertWritableVcsPath(p);
    return true;
  } catch {
    return false;
  }
}

export type VcsActor = { id: string; kind: string };
type VcsLogActor = {
  id: string;
  kind: "user" | "agent" | "system" | "panel" | "external";
  metadata?: Record<string, unknown>;
};

export function vcsLogActor(actor: VcsActor): VcsLogActor {
  if (
    actor.kind === "user" ||
    actor.kind === "agent" ||
    actor.kind === "system" ||
    actor.kind === "panel" ||
    actor.kind === "external"
  ) {
    return { id: actor.id, kind: actor.kind };
  }
  const kind =
    actor.kind === "do" || actor.kind === "worker"
      ? "agent"
      : actor.kind === "server"
        ? "system"
        : actor.kind === "shell"
          ? "user"
          : "external";
  return { id: actor.id, kind, metadata: { type: actor.kind } };
}
