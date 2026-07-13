/**
 * VCS path policy — the edit-ingress guards (eviction stage P5c; the userland
 * twin of the host's scan-side denylist in `src/server/vcsHost/paths.ts`).
 *
 * Pure + workerd-safe (no `ignore` dependency): the platform-invariant
 * exclusions are a fixed set of directory/file names plus simple basename
 * globs, matched per path segment (the same effective semantics the host's
 * `ignore`-based matcher applies to slash-free patterns). The host keeps its
 * own copy for the scan path (disk walking stays a host primitive); the
 * pattern lists must stay in sync.
 */

/** Directories never tracked: VCS metadata, dependency caches, generated
 *  output, runtime state. */
export const VCS_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".gad",
  ".contexts",
  ".databases",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  ".vibestudio",
  ".turbo",
  ".vite",
  // `.tmp/` stays scratch for host filesystem routing and snapshot scans, but
  // this engine is the explicit/force-add seam: deliberate vcs.edit calls may
  // track it. Ordinary fs temp writes never reach this engine.
  ".testkit",
  "node_modules",
  "dist",
  "out",
  "coverage",
  "test-results",
  "dist_electron",
  "release",
]);

/** Files never tracked (exact basenames). */
export const VCS_IGNORED_FILES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".npmrc",
  ".secrets.yml",
  "firebase-service-account.json",
  "google-services.json",
  "GoogleService-Info.plist",
  // Host-owned per-context bookkeeping marker written into every materialized
  // context folder (host twin: src/server/vcsHost/paths.ts). Not workspace
  // source — edit ingress must refuse it so it never enters VCS state.
  ".vibestudio-context.json",
]);

/** Basename glob patterns never tracked (secret/env/scratch files). Mirrors
 *  the host's SNAPSHOT_IGNORE_PATTERNS. */
const IGNORED_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..*$/,
  /^.*\.log$/,
  /^.*\.swp$/,
  /^.*\.swo$/,
  /^.*\.sublime-workspace$/,
  /^.*~$/,
  /^.*\.tsbuildinfo$/,
  /^.*\.tgz$/,
  /^\.npmrc\.dist-tag-temp$/,
];

/**
 * Reject a state file path that could escape its worktree root when joined
 * onto a directory: absolute, leading slash, any `..` segment, empty, or
 * containing a NUL byte. Runs at the edit boundary so attacker-controlled
 * paths never enter VCS state.
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
    /^[a-zA-Z]:[\\/]/.test(p) ||
    p.split(/[/\\]/u).some((seg) => seg === "..")
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

function segmentIgnored(segment: string): boolean {
  return IGNORED_SEGMENT_PATTERNS.some((re) => re.test(segment));
}

/** True when an otherwise-safe workspace-relative path belongs to platform
 * metadata, generated output, or a secret/scratch file class that VCS must not
 * track. This is the non-throwing policy seam for callers that want to offer a
 * recoverable alternative before invoking the edit boundary. */
export function isPlatformIgnoredVcsPath(p: string): boolean {
  const segs = p.split("/");
  if (segs.length === 0) return false;
  if (segs.slice(0, -1).some((seg) => VCS_IGNORED_DIRS.has(seg) || segmentIgnored(seg))) {
    return true;
  }
  const base = segs.at(-1) ?? "";
  return VCS_IGNORED_DIRS.has(base) || VCS_IGNORED_FILES.has(base) || segmentIgnored(base);
}

/**
 * Reject a new state path that must never enter VCS — VCS
 * internals (`.git`, `.gad`), generated dirs (`node_modules`, `dist`), and
 * secret/env files. Without this, an edit-ingress caller could write such a
 * path into VCS state (the scan denylist only runs disk→state, not
 * caller→state) and materialization would write it to disk — e.g. planting
 * `.git/hooks/*` or a `.env`. Only platform-invariant exclusions are enforced
 * here (not the user's dynamic `.gadignore`).
 */
export function assertWritableVcsEditPath(p: string): void {
  const hint =
    "VCS tracks workspace source — write to a non-ignored path (e.g. projects/…, panels/…, packages/…), " +
    "not a platform-ignored dir (.vibestudio, .git, .gad, .tmp, node_modules, dist) or ignored file (.env, *.log).";
  const segs = p.split("/");
  for (const seg of segs.slice(0, -1)) {
    if (VCS_IGNORED_DIRS.has(seg) || segmentIgnored(seg)) {
      throw new Error(`vcs path is in a platform-ignored directory: ${JSON.stringify(p)}. ${hint}`);
    }
  }
  const base = segs.at(-1) ?? "";
  if (VCS_IGNORED_DIRS.has(base) || VCS_IGNORED_FILES.has(base) || segmentIgnored(base)) {
    throw new Error(`vcs path is platform-ignored: ${JSON.stringify(p)}. ${hint}`);
  }
}
