import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import { semanticVcsPathAdmission } from "@vibestudio/vcs-path-policy";
import { GitClient, type GitCommitTreeEntry } from "./client.js";

export interface SnapshotContentSink {
  put(bytes: Uint8Array): Promise<{ digest: string; size: number }>;
}

export interface ExactSnapshotFile {
  path: string;
  contentHash: string;
  size: number;
  /** Semantic descriptor mode. */
  mode: 0o644 | 0o755;
}

export interface ExactGitSnapshot {
  commit: string;
  snapshot: CanonicalSnapshotDigest;
  files: ExactSnapshotFile[];
  readFile(path: string): Uint8Array | null;
}

/**
 * How a commit that tracks platform-reserved paths (`.git`, `.gad`, `.env`,
 * `.secrets.yml`, …) is treated.
 *
 * `reject` refuses the whole import, so a repository whose content is being
 * adopted wholesale can never silently lose files. `exclude` omits them from
 * the admitted set and the canonical digest; it exists for sources that are
 * only ever partially vendored, where a reserved root file can be an ordinary
 * fact of the source repository rather than content the workspace was ever
 * going to represent. Discovery and acquisition of one source must
 * always agree, or its snapshot digest is not reproducible.
 */
export type ReservedPathPolicy = "reject" | "exclude";

interface ReadExactGitSnapshotOptions {
  git: GitClient;
  dir: string;
  commit: string;
  label: string;
  sink: SnapshotContentSink;
  expectedSnapshot?: string;
  /** Optional monorepo subtree; returned paths are relative to it. */
  subdir?: string;
  /** Defaults to `reject`. */
  reservedPaths?: ReservedPathPolicy;
}

export interface AcquireExactGitSnapshotOptions extends Omit<
  ReadExactGitSnapshotOptions,
  "commit"
> {
  url: string;
  ref: string;
  expectedCommit: string;
}

export interface DiscoverExactGitSnapshotOptions extends Omit<
  ReadExactGitSnapshotOptions,
  "commit" | "expectedSnapshot"
> {
  url: string;
  ref: string;
}
export type DiscoverDefaultGitSnapshotOptions = Omit<DiscoverExactGitSnapshotOptions, "ref">;
export interface DiscoverTrackedGitSnapshotOptions extends Omit<
  DiscoverExactGitSnapshotOptions,
  "ref"
> {
  /** Canonical branch/tag ref, or a refs/tags/* pattern. */
  track: string;
}

const FULL_OID = /^[0-9a-f]{40}$/i;
const CANONICAL_REF = /^refs\/(?:heads|tags)\/[^\s~^:?*[\]\\]+$/;
const TRACK_GLOB_META = /[*?]/u;
const SNAPSHOT_CONTENT_STORE_CONCURRENCY = 8;

function assertExactCoordinates(ref: string, commit: string): void {
  if (!CANONICAL_REF.test(ref) || ref === "HEAD") {
    throw new Error(`Exact Git snapshot ref must be a canonical refs/heads/* or refs/tags/* ref`);
  }
  if (!FULL_OID.test(commit)) {
    throw new Error(`Exact Git snapshot commit must be a full 40-character object id`);
  }
}

function globExpression(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

/**
 * A trailing `-rc1`/`-beta.2` qualifies the release it hangs off, so it must
 * sort BELOW the bare release rather than above it. Splitting the prerelease
 * suffix off before the natural comparison keeps `v1.0.0` ahead of
 * `v1.0.0-rc1` while leaving `v1.10.0` ahead of `v1.9.0`.
 */
function splitPrerelease(ref: string): { release: string; prerelease: string | null } {
  const at = ref.indexOf("-", ref.lastIndexOf("/") + 1);
  return at < 0
    ? { release: ref, prerelease: null }
    : { release: ref.slice(0, at), prerelease: ref.slice(at + 1) };
}

function naturalVersionCompare(left: string, right: string): number {
  const leftVersion = splitPrerelease(left);
  const rightVersion = splitPrerelease(right);
  if (leftVersion.release !== rightVersion.release) {
    return naturalPartsCompare(leftVersion.release, rightVersion.release);
  }
  if (leftVersion.prerelease === null) return rightVersion.prerelease === null ? 0 : 1;
  if (rightVersion.prerelease === null) return -1;
  return naturalPartsCompare(leftVersion.prerelease, rightVersion.prerelease);
}

function naturalPartsCompare(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/gu) ?? [];
  const rightParts = right.match(/\d+|\D+/gu) ?? [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (/^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart)) {
      const leftNumber = leftPart.replace(/^0+(?=\d)/u, "");
      const rightNumber = rightPart.replace(/^0+(?=\d)/u, "");
      if (leftNumber.length !== rightNumber.length) return leftNumber.length - rightNumber.length;
      const numeric = compareUtf16CodeUnits(leftNumber, rightNumber);
      if (numeric !== 0) return numeric;
    }
    const lexical = compareUtf16CodeUnits(leftPart, rightPart);
    if (lexical !== 0) return lexical;
  }
  return compareUtf16CodeUnits(left, right);
}

function selectSubtree(
  entries: readonly GitCommitTreeEntry[],
  subdir: string | undefined
): GitCommitTreeEntry[] {
  if (!subdir) return [...entries];
  const normalized = subdir.replace(/^\/+|\/+$/g, "");
  const admission = semanticVcsPathAdmission(`${normalized}/placeholder`);
  if (!normalized || !admission.admissible) {
    throw new Error(`Exact Git snapshot subtree is not canonical: ${JSON.stringify(subdir)}`);
  }
  const prefix = `${normalized}/`;
  return entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }) as GitCommitTreeEntry);
}

async function admitAndStore(
  label: string,
  entries: readonly GitCommitTreeEntry[],
  sink: SnapshotContentSink,
  reservedPaths: ReservedPathPolicy
): Promise<{
  files: ExactSnapshotFile[];
  bytesByPath: Map<string, Uint8Array>;
  snapshot: CanonicalSnapshotDigest;
}> {
  const excluded: string[] = [];
  const inadmissible: string[] = [];
  const admitted: Array<ExactSnapshotFile & { bytes: Uint8Array; snapshotMode: number }> = [];
  for (const entry of entries) {
    const admission = semanticVcsPathAdmission(entry.path);
    if (!admission.admissible && admission.reason === "platform-reserved") {
      excluded.push(entry.path);
      continue;
    }
    if (!admission.admissible) {
      inadmissible.push(`${entry.path} (invalid semantic path)`);
      continue;
    }
    if (entry.type !== "blob" || (entry.mode !== 0o100644 && entry.mode !== 0o100755)) {
      inadmissible.push(`${entry.path} (${entry.type}, mode ${entry.mode.toString(8)})`);
      continue;
    }
    const bytes = new Uint8Array(entry.bytes);
    admitted.push({
      path: entry.path,
      bytes,
      contentHash: sha256Hex(bytes),
      size: bytes.byteLength,
      mode: entry.mode === 0o100755 ? 0o755 : 0o644,
      snapshotMode: entry.mode,
    });
  }
  if (reservedPaths === "reject" && excluded.length > 0) {
    throw new Error(
      `Cannot import ${label}: Git commit tracks paths excluded from the semantic snapshot ` +
        `(${excluded.sort(compareUtf16CodeUnits).join(", ")}); remove them from the commit before import`
    );
  }
  if (inadmissible.length > 0) {
    throw new Error(
      `Cannot import ${label}: Git commit contains entries the semantic workspace cannot represent ` +
        `(${inadmissible.sort(compareUtf16CodeUnits).join(", ")}); only regular files and executable files are importable`
    );
  }
  admitted.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const distinct = [...new Map(admitted.map((file) => [file.contentHash, file])).values()];
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(SNAPSHOT_CONTENT_STORE_CONCURRENCY, distinct.length) },
      async () => {
        for (;;) {
          const file = distinct[cursor++];
          if (!file) return;
          const stored = await sink.put(file.bytes);
          if (stored.digest !== file.contentHash || stored.size !== file.size) {
            throw new Error(
              `Cannot import ${label}: content store integrity mismatch for ${file.path} ` +
                `(returned ${stored.digest}/${stored.size}, expected ${file.contentHash}/${file.size})`
            );
          }
        }
      }
    )
  );
  return {
    files: admitted.map(({ path, contentHash, size, mode }) => ({
      path,
      contentHash,
      size,
      mode,
    })),
    bytesByPath: new Map(admitted.map((file) => [file.path, file.bytes])),
    snapshot: canonicalSnapshotDigest(
      admitted.map(({ path, snapshotMode: mode, size, contentHash }) => ({
        path,
        mode,
        size,
        contentHash,
      }))
    ),
  };
}

/** Read, admit, persist, and hash one immutable commit (or one carved subtree). */
export async function readExactGitSnapshot(
  options: ReadExactGitSnapshotOptions
): Promise<ExactGitSnapshot> {
  if (!FULL_OID.test(options.commit)) {
    throw new Error(`Exact Git snapshot commit must be a full 40-character object id`);
  }
  const startedAt = performance.now();
  const observedHead = await options.git.getCurrentCommit(options.dir);
  const headReadAt = performance.now();
  if (observedHead?.toLowerCase() !== options.commit.toLowerCase()) {
    throw new Error(
      `Cannot import ${options.label}: Git HEAD advanced while resolving the snapshot ` +
        `(expected ${options.commit}, observed ${observedHead ?? "no commit"}); retry`
    );
  }
  // The immutable commit tree, rather than the checkout's worktree, is the
  // snapshot source. Verifying every worktree path here is both redundant and
  // prohibitively expensive for a large template: local worktree changes
  // cannot influence readCommitTree(commit).
  const tree = await options.git.readCommitTree(options.dir, options.commit);
  const treeReadAt = performance.now();
  const selected = selectSubtree(tree, options.subdir);
  const admitted = await admitAndStore(
    options.label,
    selected,
    options.sink,
    options.reservedPaths ?? "reject"
  );
  const admittedAt = performance.now();
  if (admittedAt - startedAt >= 100) {
    console.error("[Perf] exact Git snapshot read", {
      headMs: headReadAt - startedAt,
      treeMs: treeReadAt - headReadAt,
      admitAndStoreMs: admittedAt - treeReadAt,
      totalMs: admittedAt - startedAt,
      files: selected.length,
    });
  }
  if (options.expectedSnapshot && admitted.snapshot !== options.expectedSnapshot) {
    throw new Error(
      `Cannot import ${options.label}: canonical snapshot mismatch ` +
        `(expected ${options.expectedSnapshot}, observed ${admitted.snapshot})`
    );
  }
  return {
    commit: options.commit.toLowerCase(),
    snapshot: admitted.snapshot,
    files: admitted.files,
    readFile(path) {
      const bytes = admitted.bytesByPath.get(path);
      return bytes ? new Uint8Array(bytes) : null;
    },
  };
}

/** Clone and verify one exact remote ref before admitting its immutable tree. */
export async function acquireExactGitSnapshot(
  options: AcquireExactGitSnapshotOptions
): Promise<ExactGitSnapshot> {
  assertExactCoordinates(options.ref, options.expectedCommit);
  options.git.resolveUrl(options.url);
  await options.git.clone({
    url: options.url,
    dir: options.dir,
    ref: options.ref,
    singleBranch: false,
    fullHistory: true,
  });
  const observed = await options.git.resolveCommit(options.dir, options.ref);
  if (!observed || observed.toLowerCase() !== options.expectedCommit.toLowerCase()) {
    throw new Error(
      `Cannot import ${options.label}: exact ref ${options.ref} resolved to ` +
        `${observed ?? "no commit"}, expected ${options.expectedCommit}`
    );
  }
  const head = await options.git.getCurrentCommit(options.dir);
  if (head?.toLowerCase() !== options.expectedCommit.toLowerCase()) {
    await options.git.checkout(options.dir, options.expectedCommit, { force: true });
  }
  return readExactGitSnapshot({
    git: options.git,
    dir: options.dir,
    commit: options.expectedCommit,
    label: options.label,
    sink: options.sink,
    ...(options.expectedSnapshot ? { expectedSnapshot: options.expectedSnapshot } : {}),
    ...(options.subdir ? { subdir: options.subdir } : {}),
    ...(options.reservedPaths ? { reservedPaths: options.reservedPaths } : {}),
  });
}

/**
 * Resolve a human-selected canonical ref once, then return the same canonical
 * coordinates used by every subsequent exact acquisition. Discovery is the
 * only API allowed to omit commit/snapshot input.
 */
export async function discoverExactGitSnapshot(
  options: DiscoverExactGitSnapshotOptions
): Promise<ExactGitSnapshot> {
  assertExactCoordinates(options.ref, "0".repeat(40));
  options.git.resolveUrl(options.url);
  await options.git.clone({
    url: options.url,
    dir: options.dir,
    ref: options.ref,
    singleBranch: false,
    fullHistory: true,
  });
  const observed = await options.git.resolveCommit(options.dir, options.ref);
  if (!observed || !FULL_OID.test(observed)) {
    throw new Error(`Git ref ${options.ref} did not resolve to a full commit`);
  }
  return readExactGitSnapshot({
    git: options.git,
    dir: options.dir,
    commit: observed.toLowerCase(),
    label: options.label,
    sink: options.sink,
    ...(options.subdir ? { subdir: options.subdir } : {}),
    ...(options.reservedPaths ? { reservedPaths: options.reservedPaths } : {}),
  });
}

/** Discover a remote's advertised default branch and freeze it to exact coordinates. */
export async function discoverDefaultGitSnapshot(
  options: DiscoverDefaultGitSnapshotOptions
): Promise<ExactGitSnapshot & { ref: string }> {
  options.git.resolveUrl(options.url);
  await options.git.clone({
    url: options.url,
    dir: options.dir,
    singleBranch: false,
    fullHistory: true,
  });
  const branch = await options.git.getCurrentBranch(options.dir);
  const commit = await options.git.getCurrentCommit(options.dir);
  if (!branch || !commit || !FULL_OID.test(commit)) {
    throw new Error(`Git remote ${options.url} has no discoverable default branch`);
  }
  const ref = `refs/heads/${branch}`;
  assertExactCoordinates(ref, commit);
  const snapshot = await readExactGitSnapshot({
    git: options.git,
    dir: options.dir,
    commit: commit.toLowerCase(),
    label: options.label,
    sink: options.sink,
    ...(options.subdir ? { subdir: options.subdir } : {}),
    ...(options.reservedPaths ? { reservedPaths: options.reservedPaths } : {}),
  });
  return { ...snapshot, ref };
}

/**
 * Resolve one explicit tracking policy. Branches and exact tags stay exact;
 * tag globs select the highest naturally version-sorted fetched tag and then
 * freeze that selection to an immutable ref/commit/snapshot tuple.
 */
export async function discoverTrackedGitSnapshot(
  options: DiscoverTrackedGitSnapshotOptions
): Promise<ExactGitSnapshot & { ref: string }> {
  if (!TRACK_GLOB_META.test(options.track)) {
    const snapshot = await discoverExactGitSnapshot({
      ...options,
      ref: options.track,
    });
    return { ...snapshot, ref: options.track };
  }
  if (!options.track.startsWith("refs/tags/") || /[\s~^:[\]\\]/u.test(options.track)) {
    throw new Error("Template track glob must be a canonical refs/tags/* pattern");
  }
  options.git.resolveUrl(options.url);
  await options.git.clone({
    url: options.url,
    dir: options.dir,
    singleBranch: false,
    fullHistory: true,
  });
  const trackPattern = globExpression(options.track);
  const matches = (await options.git.listTags(options.dir))
    .map((tag) => `refs/tags/${tag}`)
    .filter((ref) => trackPattern.test(ref))
    .sort(naturalVersionCompare);
  const ref = matches.at(-1);
  if (!ref) {
    throw new Error(`Git track ${options.track} did not match any fetched tag`);
  }
  await options.git.checkout(options.dir, ref, { force: true });
  const commit = await options.git.getCurrentCommit(options.dir);
  if (!commit || !FULL_OID.test(commit)) {
    throw new Error(`Git tag ${ref} did not resolve to a full commit`);
  }
  const snapshot = await readExactGitSnapshot({
    git: options.git,
    dir: options.dir,
    commit: commit.toLowerCase(),
    label: options.label,
    sink: options.sink,
    ...(options.subdir ? { subdir: options.subdir } : {}),
    ...(options.reservedPaths ? { reservedPaths: options.reservedPaths } : {}),
  });
  return { ...snapshot, ref };
}
