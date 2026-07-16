import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { createDevLogger } from "@vibestudio/dev-log";
import { getCentralDataPath } from "@vibestudio/env-paths";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  BLOBSTORE_READ_POLICY as READ_POLICY,
  DIGEST_RE,
  TREE_LIST_CURSOR_MAX_CHARS,
  TREE_LIST_ORDER,
  blobstoreMethods,
} from "@vibestudio/service-schemas/blobstore";
import {
  decodeStateNode,
  decodeTreeNode,
  encodeStateNode,
  encodeTreeNode,
  encodeWorktreeTree,
  treeHashDigest,
  STATE_HASH_RE,
  TREE_HASH_RE,
  TREE_EXEC_MODE,
} from "@vibestudio/shared/contentTree/treeObjects";
import {
  EMPTY_STATE_HASH,
  MAX_TREE_PATH_SEGMENTS,
  MAX_TREE_PATH_UTF8_BYTES,
  compareUtf16CodeUnits,
  splitTreePath,
  utf8ByteLength,
  type ManifestHashEntry,
  type WorktreeHashFile,
} from "@vibestudio/content-addressing";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../serviceWithHttpRoutes.js";
import {
  blobCasPath,
  centralBlobCasDir,
  ensureBlobCasLayout,
  putBlobBytes,
} from "../storage/blobCas.js";
import { assertPresent } from "../../lintHelpers";

const log = createDevLogger("BlobstoreService");

export interface BlobstoreServiceDeps {
  blobsDir: string;
}

export interface BlobStat {
  size: number;
  mtime: number;
}

export const ensureLayout = ensureBlobCasLayout;

function sweepTmp(blobsDir: string): void {
  const tmpDir = path.join(blobsDir, "tmp");
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
}

export const blobPath = blobCasPath;

function backingCasDir(blobsDir: string): string {
  const override = process.env["VIBESTUDIO_GLOBAL_BLOB_CAS_DIR"];
  if (override) return path.resolve(override);

  const resolved = path.resolve(blobsDir);
  const stateDir = path.dirname(resolved);
  const workspaceDir = path.dirname(stateDir);
  const workspacesDir = path.resolve(getCentralDataPath(), "workspaces");
  if (
    path.basename(resolved) === "blobs" &&
    path.basename(stateDir) === "state" &&
    path.dirname(workspaceDir) === workspacesDir
  ) {
    return centralBlobCasDir(getCentralDataPath());
  }
  return blobsDir;
}

async function ensureWorkspaceBlobReference(
  blobsDir: string,
  backingDir: string,
  digest: string
): Promise<void> {
  if (path.resolve(blobsDir) === path.resolve(backingDir)) return;
  const sourcePath = blobCasPath(backingDir, digest);
  const referencePath = blobPath(blobsDir, digest);
  await fsp.mkdir(path.dirname(referencePath), { recursive: true });
  try {
    await fsp.link(sourcePath, referencePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function statBlob(blobsDir: string, digest: string): Promise<BlobStat | null> {
  const filePath = blobPath(blobsDir, digest);
  try {
    const stat = await fsp.stat(filePath);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function promoteTempBlob(blobsDir: string, tmpPath: string, digest: string): Promise<void> {
  const backingDir = backingCasDir(blobsDir);
  ensureBlobCasLayout(backingDir);
  const finalPath = blobCasPath(backingDir, digest);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await fsp.link(tmpPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await ensureWorkspaceBlobReference(blobsDir, backingDir, digest);
}

async function putBlob(
  blobsDir: string,
  req: IncomingMessage
): Promise<{ digest: string; size: number }> {
  const tmpPath = path.join(blobsDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let size = 0;

  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, tee, fs.createWriteStream(tmpPath, { flags: "wx" }));
    const digest = hash.digest("hex");
    await promoteTempBlob(blobsDir, tmpPath, digest);
    await fsp.unlink(tmpPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return { digest, size };
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function putBytes(
  blobsDir: string,
  bytes: Buffer
): Promise<{ digest: string; size: number }> {
  const backingDir = backingCasDir(blobsDir);
  const stored = await putBlobBytes(backingDir, bytes);
  await ensureWorkspaceBlobReference(blobsDir, backingDir, stored.digest);
  return stored;
}

export async function getBytes(blobsDir: string, digest: string): Promise<Buffer | null> {
  const filePath = blobPath(blobsDir, digest);
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Stream a file from disk into the CAS (hash while copying — never loads the
 * file into memory). Hardlinks tmp → final like the other writers, so on the
 * same filesystem the eventual `materializeState` hardlink shares the inode.
 */
export async function putFile(
  blobsDir: string,
  filePath: string
): Promise<{ digest: string; size: number }> {
  const tmpPath = path.join(blobsDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let size = 0;
  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(filePath),
      tee,
      fs.createWriteStream(tmpPath, { flags: "wx" })
    );
    const digest = hash.digest("hex");
    await promoteTempBlob(blobsDir, tmpPath, digest);
    await fsp.unlink(tmpPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return { digest, size };
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Hard cap on a single getRange read. A caller that wants more must
 * page — both keeps memory usage bounded per request and limits the
 * blast radius of a buggy/malicious caller that asks for `length: 1e12`.
 * 256 KiB is well above the natural ~8 KiB head excerpt that the
 * agent uses, leaving plenty of room for explicit drilling.
 */
const MAX_GET_RANGE_BYTES = 256 * 1024;

async function getByteRange(
  blobsDir: string,
  digest: string,
  offset: number,
  length: number
): Promise<Buffer | null> {
  if (length > MAX_GET_RANGE_BYTES) {
    throw new Error(
      `blobstore.getRange length too large (${length} > ${MAX_GET_RANGE_BYTES} bytes); page the request`
    );
  }
  const filePath = blobPath(blobsDir, digest);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    if (offset >= stat.size) return Buffer.alloc(0);
    const cappedLength = Math.min(length, stat.size - offset);
    const buf = Buffer.alloc(cappedLength);
    if (cappedLength > 0) {
      await handle.read(buf, 0, cappedLength, offset);
    }
    return buf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export interface GrepMatch {
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

/**
 * Reject regex patterns prone to catastrophic backtracking. The
 * native JS regex engine has no execution timeout, so a single
 * pathological pattern can freeze the server indefinitely once
 * `re.test()` enters exponential backtracking on adversarial input
 * (e.g. `(a+)+b` against `aaaaaaaaaaaaaaaac`).
 *
 * Defense in depth — for an absolute guarantee we'd need a
 * non-backtracking engine like RE2. This validator catches the
 * common bad shapes:
 *
 *   1. Length cap — keeps the search space bounded.
 *   2. Nested quantifiers — `(...)+` / `(...)*` / `(...){n,}` where
 *      the inner group contains its own quantifier.
 *   3. Adjacent quantifiers on overlapping classes — `a+a*` style.
 */
function assertSafeGrepPattern(pattern: string): void {
  if (pattern.length > 1024) {
    throw new Error(`grep pattern too long (max 1024 chars, got ${pattern.length})`);
  }
  // Nested quantifier inside a quantified group: `(...+...)+`,
  // `(...*...)*`, `(...{N,}...)+`, etc.
  if (/\([^)]*[+*][^)]*\)\s*[+*?{]/u.test(pattern)) {
    throw new Error(
      "grep pattern contains nested quantifiers (catastrophic-backtracking risk); rewrite to avoid `(...+...)+` or `(...*...)*` shapes"
    );
  }
  // Alternation of overlapping single-char classes inside a
  // quantifier: `(a|a)*`, `(a|ab)+`, etc. Detected loosely as a
  // group with `|` followed by a quantifier.
  if (/\([^()]*\|[^()]*\)\s*[+*]/u.test(pattern)) {
    // Allow only if the inner branches don't share a leading char —
    // hard to check without a parser. Conservative: reject.
    throw new Error(
      "grep pattern uses quantified alternation (catastrophic-backtracking risk); rewrite without `(a|b)*` style"
    );
  }
}

async function grepBlob(
  blobsDir: string,
  digest: string,
  pattern: string,
  opts: { caseInsensitive?: boolean; contextLines?: number; maxMatches?: number }
): Promise<GrepMatch[] | null> {
  const bytes = await getBytes(blobsDir, digest);
  if (!bytes) return null;
  // ReDoS mitigation — bound pattern length and reject patterns with
  // catastrophic-backtracking shapes BEFORE compilation. The native
  // regex engine has no execution timeout in JS, so a pathological
  // pattern (e.g. `(a+)+b`) would freeze the server during `re.test`.
  assertSafeGrepPattern(pattern);
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/u);
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? "iu" : "u");
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }
  const context = Math.max(0, Math.min(opts.contextLines ?? 0, 10));
  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? 50, 500));
  const matches: GrepMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxMatches) break;
    if (!re.test(assertPresent(lines[i]))) continue;
    const before: string[] = [];
    for (let j = Math.max(0, i - context); j < i; j++) before.push(assertPresent(lines[j]));
    const after: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + context); j++)
      after.push(assertPresent(lines[j]));
    matches.push({ lineNumber: i + 1, line: assertPresent(lines[i]), before, after });
  }
  return matches;
}

async function listBlobs(
  blobsDir: string,
  opts?: { prefix?: string; limit?: number }
): Promise<string[]> {
  const prefix = opts?.prefix ?? "";
  const limit = opts?.limit;
  const shaDir = path.join(blobsDir, "sha256");
  const results: string[] = [];

  let firstDirs: fs.Dirent[];
  try {
    firstDirs = await fsp.readdir(shaDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  for (const first of firstDirs.sort((a, b) => compareUtf16CodeUnits(a.name, b.name))) {
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/.test(first.name)) continue;
    if (prefix.length >= 2 && first.name !== prefix.slice(0, 2)) continue;
    if (prefix.length < 2 && !first.name.startsWith(prefix)) continue;

    const secondDirPath = path.join(shaDir, first.name);
    const secondDirs = await fsp.readdir(secondDirPath, { withFileTypes: true });
    for (const second of secondDirs.sort((a, b) => compareUtf16CodeUnits(a.name, b.name))) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/.test(second.name)) continue;
      const firstFour = first.name + second.name;
      if (prefix.length >= 4 && firstFour !== prefix.slice(0, 4)) continue;
      if (prefix.length < 4 && !firstFour.startsWith(prefix)) continue;

      const leafDir = path.join(secondDirPath, second.name);
      const files = await fsp.readdir(leafDir, { withFileTypes: true });
      for (const file of files.sort((a, b) => compareUtf16CodeUnits(a.name, b.name))) {
        if (!file.isFile()) continue;
        const digest = firstFour + file.name;
        if (!DIGEST_RE.test(digest)) continue;
        if (!digest.startsWith(prefix)) continue;
        results.push(digest);
        if (limit && results.length >= limit) return results;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tree objects — immutable content-addressed file trees in the same CAS.
//
// A directory node is stored as a canonical-JSON blob whose sha256 digest IS
// the hex suffix of its `manifest:` hash (and a `state:` root pointer likewise
// stores `{manifestRootHash}` at its own hex suffix), so tree metadata lives
// in the ONE flat CAS: blob GC/list/prune see tree nodes as ordinary blobs,
// and tree hashes stay byte-compatible with existing gad manifest/state
// hashes. Pure encode/decode/validation lives in
// @vibestudio/shared/contentTree/treeObjects; this section binds it to the disk
// store. Stored nodes are decoded STRICTLY on every read — raw blob writes
// are unauthenticated, so a crafted "node" (path traversal names, junk shape,
// non-canonical bytes) is rejected before it can flow into list/read/
// materialize.
// ---------------------------------------------------------------------------

/** Walk depth cap — a valid Merkle tree cannot cycle (a node would need to
 *  contain its own hash), but crafted node chains shouldn't recurse unbounded. */
const MAX_TREE_DEPTH = 128;

export type TreeListEntry =
  | { path: string; kind: "file"; contentHash: string; mode: number }
  | { path: string; kind: "dir"; treeHash: string };

export interface TreeListBasis {
  ref: string;
  rootTreeHash: string;
  prefix: string;
  order: typeof TREE_LIST_ORDER;
}

export class ExactTreeListingLimitExceeded extends Error {
  readonly name = "ExactTreeListingLimitExceeded";

  constructor(
    readonly limit: number,
    readonly observed: number
  ) {
    super(`Exact tree inventory exceeds the explicit ${limit}-entry bound`);
  }
}

export type TreeListPage = {
  basis: TreeListBasis;
  entries: TreeListEntry[];
} & ({ completeness: "complete" } | { completeness: "continuation"; nextCursor: string });

export interface TreeDiffFile {
  path: string;
  contentHash: string;
  mode: number;
}

export interface TreeDiff {
  added: TreeDiffFile[];
  removed: TreeDiffFile[];
  changed: Array<{
    path: string;
    fromContentHash: string;
    toContentHash: string;
    fromMode: number;
    toMode: number;
  }>;
}

/** `diffTrees` is retained for bounded host admission/approval checks. The
 * semantic comparison path uses its own paged projection. Crossing this
 * boundary is a refusal, never a truncated diff that could authorize work. */
export const MAX_TREE_DIFF_ENTRIES = 100_000;

function missingTreeObjectError(hash: string): Error {
  return new Error(`Tree object missing from store: ${hash}`);
}

/** Read + strictly decode a stored directory node; null when absent. */
async function readTreeNode(
  blobsDir: string,
  treeHash: string
): Promise<ManifestHashEntry[] | null> {
  const bytes = await getBytes(blobsDir, treeHashDigest(treeHash));
  if (!bytes) return null;
  return decodeTreeNode(bytes.toString("utf8"));
}

/** Resolve a `manifest:`/`state:` reference to its root `manifest:` hash;
 *  null when a `state:` pointer object is absent from the store. */
async function resolveTreeRef(blobsDir: string, ref: string): Promise<string | null> {
  if (TREE_HASH_RE.test(ref)) return ref;
  if (STATE_HASH_RE.test(ref)) {
    const bytes = await getBytes(blobsDir, treeHashDigest(ref));
    if (!bytes) return null;
    return decodeStateNode(bytes.toString("utf8"));
  }
  throw new Error(`Invalid tree reference: ${JSON.stringify(ref)}`);
}

/**
 * Store one immutable directory node from its entries. Validates entry shape
 * (names, hashes, modes, duplicates — see contentTree/treeObjects) AND that
 * every referenced child object already exists in the store: file blobs must
 * be present, and dir children must decode as valid tree nodes — so userland
 * can never claim a tree hash whose objects are missing or junk. With
 * `{root:true}` also stores the `state:` root pointer (gad state-hash scheme)
 * and returns its stateHash. Idempotent by content.
 */
export async function putTree(
  blobsDir: string,
  entriesInput: ManifestHashEntry[],
  opts?: { root?: boolean }
): Promise<{ treeHash: string; stateHash?: string }> {
  // Project to the exact hashed shape so unknown extra keys from the wire can
  // never leak into (and silently perturb) the content address.
  const projected: ManifestHashEntry[] = entriesInput.map((entry) =>
    entry.kind === "file"
      ? { name: entry.name, kind: "file", contentHash: entry.contentHash, mode: entry.mode }
      : { name: entry.name, kind: "dir", childHash: entry.childHash }
  );
  const encoded = encodeTreeNode(projected);

  for (const entry of encoded.entries) {
    if (entry.kind === "file") {
      if (!(await pathExists(blobPath(blobsDir, entry.contentHash)))) {
        throw new Error(
          `putTree: missing file blob ${entry.contentHash} for entry ${JSON.stringify(entry.name)}`
        );
      }
    } else {
      const childBytes = await getBytes(blobsDir, treeHashDigest(entry.childHash));
      if (!childBytes) {
        throw new Error(
          `putTree: missing child tree object ${entry.childHash} for entry ${JSON.stringify(entry.name)}`
        );
      }
      // Throws if the referenced blob is not a valid canonical tree node —
      // rejecting a "dir" that points at arbitrary attacker-written bytes.
      decodeTreeNode(childBytes.toString("utf8"));
    }
  }

  const { digest } = await putBytes(blobsDir, Buffer.from(encoded.canonicalText, "utf8"));
  if (digest !== treeHashDigest(encoded.treeHash)) {
    throw new Error(
      `putTree: CAS digest ${digest} disagrees with tree hash ${encoded.treeHash} (hashing bug)`
    );
  }
  if (!opts?.root) return { treeHash: encoded.treeHash };

  // A state pointer is a promise that the complete tree can be projected.
  // Validate cumulative depth/path bounds before minting that root identity;
  // standalone child manifests cannot know the path at which they are later
  // composed, but an unprojectable tree can never become a content state.
  for await (const _page of iterateExactTreePages(blobsDir, encoded.treeHash)) {
    // Drain only: root validation is bounded to one page of metadata at a
    // time and never constructs the complete inventory.
  }

  const state = encodeStateNode(encoded.treeHash);
  const stateWrite = await putBytes(blobsDir, Buffer.from(state.canonicalText, "utf8"));
  if (stateWrite.digest !== treeHashDigest(state.stateHash)) {
    throw new Error(
      `putTree: CAS digest ${stateWrite.digest} disagrees with state hash ${state.stateHash} (hashing bug)`
    );
  }
  return { treeHash: encoded.treeHash, stateHash: state.stateHash };
}

/** Whether the store holds the node object for a `manifest:`/`state:` hash. */
export async function hasTreeObject(blobsDir: string, hash: string): Promise<boolean> {
  return pathExists(blobPath(blobsDir, treeHashDigest(hash)));
}

/**
 * Mirror a full worktree file listing into the CAS as tree objects — the
 * server-internal bulk writer behind the mirroring invariant ("any state hash
 * the system hands out can be resolved to a full tree in the content store").
 * Encodes the listing with `encodeWorktreeTree` (hash-identical to
 * `buildWorktreeManifest`, i.e. to the semantic control plane) and writes every distinct
 * directory node bottom-up, then the `state:` root pointer LAST — so the state
 * node's presence implies the complete tree beneath it is present, which is
 * exactly the cheap already-mirrored fast path here.
 *
 * `expectStateHash` verifies a caller's precomputed state identity: when the
 * re-encoded state hash disagrees, this throws BEFORE writing anything.
 *
 * Unlike `putTree` (the userland RPC ingress), this does NOT verify that file
 * blobs exist: every internal state-minting path streams file bytes into this
 * same CAS before their hashes exist anywhere, so the check would be pure
 * overhead on the hot snapshot/edit paths. Idempotent by content.
 */
export async function mirrorWorktreeTree(
  blobsDir: string,
  files: WorktreeHashFile[],
  opts?: { expectStateHash?: string }
): Promise<{ stateHash: string; treeHash: string; written: number }> {
  const encoded = encodeWorktreeTree(files);
  if (opts?.expectStateHash !== undefined && encoded.stateHash !== opts.expectStateHash) {
    throw new Error(
      `mirrorWorktreeTree: file listing re-encodes to ${encoded.stateHash}, expected ` +
        `${opts.expectStateHash} — refusing to mirror a corrupt/truncated listing (nothing written)`
    );
  }
  // Fast path: the state node is written last (below), so its presence means
  // the full tree was already mirrored.
  if (await hasTreeObject(blobsDir, encoded.stateHash)) {
    return { stateHash: encoded.stateHash, treeHash: encoded.rootTreeHash, written: 0 };
  }
  let written = 0;
  for (const node of encoded.nodes) {
    const digest = treeHashDigest(node.treeHash);
    if (await pathExists(blobPath(blobsDir, digest))) continue;
    const put = await putBytes(blobsDir, Buffer.from(node.canonicalText, "utf8"));
    if (put.digest !== digest) {
      throw new Error(
        `mirrorWorktreeTree: CAS digest ${put.digest} disagrees with tree hash ${node.treeHash} (hashing bug)`
      );
    }
    written += 1;
  }
  const statePut = await putBytes(blobsDir, Buffer.from(encoded.stateNode.canonicalText, "utf8"));
  if (statePut.digest !== treeHashDigest(encoded.stateHash)) {
    throw new Error(
      `mirrorWorktreeTree: CAS digest ${statePut.digest} disagrees with state hash ${encoded.stateHash} (hashing bug)`
    );
  }
  written += 1;
  return { stateHash: encoded.stateHash, treeHash: encoded.rootTreeHash, written };
}

export interface MerkleTreeGraft {
  /** Exact workspace-relative directory at which the state root is mounted. */
  path: string;
  /** An immutable, structurally complete repository content state. */
  stateHash: string;
}

interface TreeExtent {
  /** Longest path (file or directory), relative to this tree root. */
  maxPathSegments: number;
  maxPathUtf8Bytes: number;
  /** Longest directory path, relative to this tree root. */
  maxDirectorySegments: number;
}

interface InspectedStateRoot {
  stateHash: string;
  rootTreeHash: string;
  extent: TreeExtent;
}

interface GraftTrie {
  children: Map<string, GraftTrie>;
  graftRootHash?: string;
}

/**
 * Fixed-size LRU for completed async facts plus a transient single-flight
 * registry. Rejections are never retained, so a repaired backing store can be
 * inspected again. Active work is separate from retained cache state: it may
 * temporarily reflect caller concurrency, but disappears as soon as each
 * computation settles.
 */
class BoundedAsyncMemo<Key, Value> {
  private readonly completed = new Map<Key, Value>();
  private readonly inFlight = new Map<Key, Promise<Value>>();

  constructor(private readonly maxCompletedEntries: number) {
    if (!Number.isSafeInteger(maxCompletedEntries) || maxCompletedEntries < 0) {
      throw new Error("BoundedAsyncMemo: maxCompletedEntries must be a non-negative safe integer");
    }
  }

  getOrCreate(key: Key, create: () => Promise<Value>): Promise<Value> {
    if (this.completed.has(key)) {
      const value = this.completed.get(key) as Value;
      // Map insertion order is the LRU order: a read promotes the entry.
      this.completed.delete(key);
      this.completed.set(key, value);
      return Promise.resolve(value);
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Deferring create by one microtask lets us publish the single-flight
    // promise before any producer work begins.
    const pending = Promise.resolve()
      .then(create)
      .then((value) => {
        this.remember(key, value);
        return value;
      });
    this.inFlight.set(key, pending);
    void pending.then(
      () => this.clearInFlight(key, pending),
      () => this.clearInFlight(key, pending)
    );
    return pending;
  }

  private remember(key: Key, value: Value): void {
    if (this.maxCompletedEntries === 0) return;
    this.completed.delete(key);
    this.completed.set(key, value);
    while (this.completed.size > this.maxCompletedEntries) {
      const oldest = this.completed.keys().next().value as Key | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private clearInFlight(key: Key, pending: Promise<Value>): void {
    if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
  }
}

export interface MerkleTreeComposerOptions {
  /** Completed immutable state-root inspections retained by LRU. */
  stateRootCacheEntries?: number;
  /** Completed immutable tree-extent inspections retained by LRU. */
  treeExtentCacheEntries?: number;
}

const DEFAULT_STATE_ROOT_CACHE_ENTRIES = 2_048;
const DEFAULT_TREE_EXTENT_CACHE_ENTRIES = 16_384;

/**
 * Merkle-native composition of independently addressed content states.
 *
 * Each repository state is grafted into a small workspace path scaffold by
 * its exact root tree hash. Composition is therefore O(repository roots +
 * scaffold nodes), not O(files): unchanged repository subtrees retain their
 * identities and are never flattened and re-encoded for a new semantic
 * frontier. The result is still an ordinary `state:` tree, so every existing
 * tree reader can walk it without a composition-specific index or overlay.
 *
 * The first use of a distinct state structurally walks its directory nodes to
 * prove that every referenced tree object exists and to derive its exact path
 * extent. Those immutable facts are memoized by state/tree hash. Later
 * compositions that merely change semantic provenance reuse them in O(1).
 * File bodies are not read: the state-node publication invariant already
 * guarantees that content blobs and child nodes were written before the
 * `state:` pointer became visible.
 */
export class MerkleTreeComposer {
  private readonly stateRoots: BoundedAsyncMemo<string, InspectedStateRoot>;
  private readonly treeExtents: BoundedAsyncMemo<string, TreeExtent>;

  constructor(
    private readonly blobsDir: string,
    options: MerkleTreeComposerOptions = {}
  ) {
    this.stateRoots = new BoundedAsyncMemo(
      options.stateRootCacheEntries ?? DEFAULT_STATE_ROOT_CACHE_ENTRIES
    );
    this.treeExtents = new BoundedAsyncMemo(
      options.treeExtentCacheEntries ?? DEFAULT_TREE_EXTENT_CACHE_ENTRIES
    );
  }

  async composeStateGrafts(
    grafts: readonly MerkleTreeGraft[]
  ): Promise<{ stateHash: string; treeHash: string }> {
    const normalized = grafts.map((graft) => ({
      path: graft.path,
      segments: splitTreePath(graft.path),
      stateHash: graft.stateHash,
    }));
    const seenPaths = new Set<string>();
    for (const graft of normalized) {
      if (graft.segments.length === 0) {
        throw new Error("MerkleTreeComposer: a graft path must name a directory below the root");
      }
      if (seenPaths.has(graft.path)) {
        throw new Error(`MerkleTreeComposer: duplicate graft path ${JSON.stringify(graft.path)}`);
      }
      seenPaths.add(graft.path);
    }

    const inspected = await Promise.all(
      normalized.map(async (graft) => ({
        ...graft,
        root: await this.inspectStateRoot(graft.stateHash),
      }))
    );

    // The empty worktree state has no directory entries. A repository's
    // semantic existence is represented by the repository map, not by an
    // otherwise-unobservable empty directory in the workspace content state.
    const active = inspected.filter(({ stateHash }) => stateHash !== EMPTY_STATE_HASH);
    const activePaths = new Set(active.map(({ path: graftPath }) => graftPath));
    for (const graft of active) {
      for (let depth = 1; depth < graft.segments.length; depth += 1) {
        const ancestor = graft.segments.slice(0, depth).join("/");
        if (activePaths.has(ancestor)) {
          throw new Error(
            `MerkleTreeComposer: graft paths overlap at ${JSON.stringify(ancestor)} and ${JSON.stringify(graft.path)}`
          );
        }
      }
      this.assertGraftWithinProjectionBounds(graft.path, graft.segments, graft.root.extent);
    }

    const trie: GraftTrie = { children: new Map() };
    for (const graft of active) {
      let node = trie;
      for (const segment of graft.segments) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.graftRootHash = graft.root.rootTreeHash;
    }

    const treeHash = await this.writeScaffold(trie);
    const state = encodeStateNode(treeHash);
    const stateWrite = await putBytes(this.blobsDir, Buffer.from(state.canonicalText, "utf8"));
    if (stateWrite.digest !== treeHashDigest(state.stateHash)) {
      throw new Error(
        `MerkleTreeComposer: CAS digest ${stateWrite.digest} disagrees with state hash ${state.stateHash} (hashing bug)`
      );
    }
    return { stateHash: state.stateHash, treeHash };
  }

  private inspectStateRoot(stateHash: string): Promise<InspectedStateRoot> {
    if (!STATE_HASH_RE.test(stateHash)) {
      return Promise.reject(
        new Error(
          `MerkleTreeComposer: graft is not a canonical state hash: ${JSON.stringify(stateHash)}`
        )
      );
    }
    return this.stateRoots.getOrCreate(stateHash, async (): Promise<InspectedStateRoot> => {
      const rootTreeHash = await resolveTreeRef(this.blobsDir, stateHash);
      if (!rootTreeHash) {
        throw new Error(`MerkleTreeComposer: state root is missing from the CAS: ${stateHash}`);
      }
      const extent = await this.inspectTreeExtent(rootTreeHash, 0);
      if (
        extent.maxPathSegments > MAX_TREE_PATH_SEGMENTS ||
        extent.maxDirectorySegments > MAX_TREE_PATH_SEGMENTS - 1 ||
        extent.maxPathUtf8Bytes > MAX_TREE_PATH_UTF8_BYTES
      ) {
        throw new Error(
          `MerkleTreeComposer: state ${stateHash} exceeds canonical projection bounds`
        );
      }
      return { stateHash, rootTreeHash, extent };
    });
  }

  private inspectTreeExtent(treeHash: string, traversalDepth: number): Promise<TreeExtent> {
    if (traversalDepth > MAX_TREE_PATH_SEGMENTS) {
      return Promise.reject(
        new Error("MerkleTreeComposer: tree exceeds the canonical traversal depth")
      );
    }
    return this.treeExtents.getOrCreate(treeHash, async (): Promise<TreeExtent> => {
      const entries = await readTreeNode(this.blobsDir, treeHash);
      if (!entries) throw missingTreeObjectError(treeHash);
      let maxPathSegments = 0;
      let maxPathUtf8Bytes = 0;
      let maxDirectorySegments = 0;
      for (const entry of entries) {
        const entryBytes = utf8ByteLength(entry.name);
        if (entry.kind === "file") {
          maxPathSegments = Math.max(maxPathSegments, 1);
          maxPathUtf8Bytes = Math.max(maxPathUtf8Bytes, entryBytes);
          continue;
        }
        const child = await this.inspectTreeExtent(entry.childHash, traversalDepth + 1);
        maxDirectorySegments = Math.max(maxDirectorySegments, 1 + child.maxDirectorySegments);
        maxPathSegments = Math.max(maxPathSegments, 1 + child.maxPathSegments);
        maxPathUtf8Bytes = Math.max(
          maxPathUtf8Bytes,
          child.maxPathSegments === 0 ? entryBytes : entryBytes + 1 + child.maxPathUtf8Bytes
        );
      }
      return { maxPathSegments, maxPathUtf8Bytes, maxDirectorySegments };
    });
  }

  private assertGraftWithinProjectionBounds(
    graftPath: string,
    segments: string[],
    extent: TreeExtent
  ): void {
    const prefixSegments = segments.length;
    const prefixBytes = utf8ByteLength(graftPath);
    const mountedPathBytes =
      extent.maxPathSegments === 0 ? prefixBytes : prefixBytes + 1 + extent.maxPathUtf8Bytes;
    if (
      prefixSegments > MAX_TREE_PATH_SEGMENTS - 1 ||
      prefixSegments + extent.maxDirectorySegments > MAX_TREE_PATH_SEGMENTS - 1 ||
      prefixSegments + extent.maxPathSegments > MAX_TREE_PATH_SEGMENTS ||
      mountedPathBytes > MAX_TREE_PATH_UTF8_BYTES
    ) {
      throw new Error(
        `MerkleTreeComposer: graft ${JSON.stringify(graftPath)} exceeds canonical projection bounds`
      );
    }
  }

  private async writeScaffold(node: GraftTrie): Promise<string> {
    if (node.graftRootHash !== undefined) {
      if (node.children.size !== 0) {
        throw new Error("MerkleTreeComposer: a graft root cannot also contain scaffold children");
      }
      return node.graftRootHash;
    }
    const entries: ManifestHashEntry[] = [];
    for (const [name, child] of node.children) {
      entries.push({ name, kind: "dir", childHash: await this.writeScaffold(child) });
    }
    return (await putTree(this.blobsDir, entries)).treeHash;
  }
}

/** Entries of a tree object, or null when the referenced object is absent. */
export async function getTree(blobsDir: string, ref: string): Promise<ManifestHashEntry[] | null> {
  const treeHash = await resolveTreeRef(blobsDir, ref);
  if (!treeHash) return null;
  return readTreeNode(blobsDir, treeHash);
}

export async function collectTreeReachableDigests(
  blobsDir: string,
  ref: string
): Promise<{ treeDigests: string[]; contentDigests: string[] } | null> {
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) return null;
  const treeDigests = new Set<string>();
  const contentDigests = new Set<string>();
  if (STATE_HASH_RE.test(ref)) treeDigests.add(treeHashDigest(ref));

  const walk = async (treeHash: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH)
      throw new Error("collectTreeReachableDigests: tree exceeds max depth");
    treeDigests.add(treeHashDigest(treeHash));
    const entries = await readTreeNode(blobsDir, treeHash);
    if (!entries) throw missingTreeObjectError(treeHash);
    for (const entry of entries) {
      if (entry.kind === "file") {
        contentDigests.add(entry.contentHash);
      } else {
        await walk(entry.childHash, depth + 1);
      }
    }
  };

  await walk(rootHash, 0);
  return {
    treeDigests: [...treeDigests].sort(compareUtf16CodeUnits),
    contentDigests: [...contentDigests].sort(compareUtf16CodeUnits),
  };
}

export async function sweepUnreachableBlobs(
  blobsDir: string,
  reachable: ReadonlySet<string>,
  minAgeMs: number,
  now = Date.now()
): Promise<{ scanned: number; swept: number; bytes: number }> {
  const result = { scanned: 0, swept: 0, bytes: 0 };
  const shaRoot = path.join(blobsDir, "sha256");
  let firstLevel: fs.Dirent[];
  try {
    firstLevel = await fsp.readdir(shaRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const first of firstLevel) {
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/u.test(first.name)) continue;
    const firstPath = path.join(shaRoot, first.name);
    for (const second of await fsp.readdir(firstPath, { withFileTypes: true })) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/u.test(second.name)) continue;
      const secondPath = path.join(firstPath, second.name);
      for (const leaf of await fsp.readdir(secondPath, { withFileTypes: true })) {
        if (!leaf.isFile()) continue;
        const digest = `${first.name}${second.name}${leaf.name}`;
        if (!DIGEST_RE.test(digest)) continue;
        result.scanned += 1;
        if (reachable.has(digest)) continue;
        const filePath = path.join(secondPath, leaf.name);
        const stat = await fsp.stat(filePath);
        if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue;
        await fsp.unlink(filePath);
        result.swept += 1;
        result.bytes += stat.size;
      }
      await fsp.rmdir(secondPath).catch((error) => {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      });
    }
    await fsp.rmdir(firstPath).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    });
  }
  return result;
}

const DEFAULT_TREE_PAGE_SIZE = 1_000;
const MAX_TREE_PAGE_SIZE = 10_000;
const TREE_CURSOR_VERSION = 1;

interface TreeListCursorPayload {
  v: typeof TREE_CURSOR_VERSION;
  basisHash: string;
  after: string;
}

function sameTreeListBasis(left: TreeListBasis, right: TreeListBasis): boolean {
  return (
    left.ref === right.ref &&
    left.rootTreeHash === right.rootTreeHash &&
    left.prefix === right.prefix &&
    left.order === right.order
  );
}

function treeListBasisHash(basis: TreeListBasis): string {
  const canonicalBasis = JSON.stringify({
    ref: basis.ref,
    rootTreeHash: basis.rootTreeHash,
    prefix: basis.prefix,
    order: basis.order,
  });
  return createHash("sha256").update(canonicalBasis, "utf8").digest("hex");
}

/** A cursor is an opaque content-address of a canonical, fixed-order payload.
 * It is deliberately not an offset: `after` is the unique path emitted at the
 * page boundary. Cursors are integrity envelopes, not authorization tokens. */
function encodeTreeListCursor(payload: TreeListCursorPayload): string {
  const json = JSON.stringify({
    v: payload.v,
    basisHash: payload.basisHash,
    after: payload.after,
  });
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  return `tree-page-v1.${digest}.${encoded}`;
}

function decodeTreeListCursor(cursor: string): TreeListCursorPayload {
  if (cursor.length > TREE_LIST_CURSOR_MAX_CHARS) {
    throw new Error("listTree: invalid continuation cursor");
  }
  const match = /^tree-page-v1\.([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (!match) throw new Error("listTree: invalid continuation cursor");
  const [, expectedDigest, encoded] = match;
  if (!expectedDigest || !encoded) throw new Error("listTree: invalid continuation cursor");
  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("listTree: invalid continuation cursor");
  }
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  if (digest !== expectedDigest) throw new Error("listTree: corrupt continuation cursor");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("listTree: invalid continuation cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("listTree: invalid continuation cursor");
  }
  const record = value as Record<string, unknown>;
  if (
    record["v"] !== TREE_CURSOR_VERSION ||
    typeof record["basisHash"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record["basisHash"]) ||
    typeof record["after"] !== "string" ||
    record["after"].length === 0
  ) {
    throw new Error("listTree: invalid continuation cursor");
  }
  return {
    v: TREE_CURSOR_VERSION,
    basisHash: record["basisHash"],
    after: record["after"],
  };
}

/**
 * Exact keyset-paged recursive listing under `request.prefix` (whole tree
 * when omitted), in canonical tree preorder. Null means only that the root
 * object is absent. An absent prefix is an exact empty page; a missing or
 * corrupt interior node throws. A page reads tree nodes only until its first
 * unreturned entry, so it neither materializes later pages nor reads file
 * blobs.
 */
export async function listTree(
  blobsDir: string,
  ref: string,
  request: { prefix?: string; limit?: number; cursor?: string }
): Promise<TreeListPage | null> {
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) return null;
  const limit = request.limit ?? DEFAULT_TREE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TREE_PAGE_SIZE) {
    throw new Error(`listTree: limit must be between 1 and ${MAX_TREE_PAGE_SIZE}`);
  }
  const segments = splitTreePath(request.prefix ?? "");
  const normalizedPrefix = segments.join("/");
  const basis: TreeListBasis = {
    ref,
    rootTreeHash: rootHash,
    prefix: normalizedPrefix,
    order: TREE_LIST_ORDER,
  };
  const decodedCursor = request.cursor ? decodeTreeListCursor(request.cursor) : null;
  if (decodedCursor && decodedCursor.basisHash !== treeListBasisHash(basis)) {
    throw new Error("listTree: continuation cursor basis mismatch");
  }
  const after = decodedCursor?.after ?? null;

  let entries = await readTreeNode(blobsDir, rootHash);
  if (!entries) {
    // For a manifest ref this is the requested root object being absent. For
    // a state ref the requested pointer exists and names a missing interior
    // root manifest: that is corruption, never an empty/absent snapshot.
    if (STATE_HASH_RE.test(ref)) throw missingTreeObjectError(rootHash);
    return null;
  }
  for (const [i, segment] of segments.entries()) {
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) {
      if (after) {
        throw new Error("listTree: continuation cursor last key does not exist in its basis");
      }
      return { basis, entries: [], completeness: "complete" };
    }
    if (entry.kind === "file") {
      // The prefix itself names a file — list exactly that file.
      if (i === segments.length - 1) {
        const fileEntry: TreeListEntry = {
          path: normalizedPrefix,
          kind: "file",
          contentHash: entry.contentHash,
          mode: entry.mode,
        };
        if (after && after !== fileEntry.path) {
          throw new Error("listTree: continuation cursor last key does not exist in its basis");
        }
        return {
          basis,
          entries: after ? [] : [fileEntry],
          completeness: "complete",
        };
      }
      if (after) {
        throw new Error("listTree: continuation cursor last key does not exist in its basis");
      }
      return { basis, entries: [], completeness: "complete" };
    }
    const child = await readTreeNode(blobsDir, entry.childHash);
    if (!child) throw missingTreeObjectError(entry.childHash);
    entries = child;
  }

  interface WalkFrame {
    entries: ManifestHashEntry[];
    /** Next sibling in this node. This is a tree key position, never an
     * inventory offset serialized into the cursor. */
    index: number;
    prefixPath: string;
    prefixUtf8Bytes: number;
    depth: number;
  }

  const stack: WalkFrame[] = [];
  if (!after) {
    stack.push({
      entries,
      index: 0,
      prefixPath: normalizedPrefix,
      prefixUtf8Bytes: utf8ByteLength(normalizedPrefix),
      depth: segments.length,
    });
  } else {
    // Resume from the exact last path by descending only its ancestor chain.
    // Each saved frame points at the next sibling, which reconstructs the
    // preorder continuation in O(depth) reads instead of rescanning every
    // previously emitted node.
    const relativeAfter = normalizedPrefix
      ? after.startsWith(`${normalizedPrefix}/`)
        ? after.slice(normalizedPrefix.length + 1)
        : null
      : after;
    if (!relativeAfter) {
      throw new Error("listTree: continuation cursor last key does not exist in its basis");
    }
    const afterSegments = splitTreePath(relativeAfter);
    let currentEntries = entries;
    let currentPrefix = normalizedPrefix;
    let currentDepth = segments.length;
    for (const [index, segment] of afterSegments.entries()) {
      const entryIndex = currentEntries.findIndex((candidate) => candidate.name === segment);
      if (entryIndex < 0) {
        throw new Error("listTree: continuation cursor last key does not exist in its basis");
      }
      const entry = currentEntries[entryIndex];
      if (!entry) {
        throw new Error("listTree: continuation cursor last key does not exist in its basis");
      }
      const entryPath = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;
      stack.push({
        entries: currentEntries,
        index: entryIndex + 1,
        prefixPath: currentPrefix,
        prefixUtf8Bytes: utf8ByteLength(currentPrefix),
        depth: currentDepth,
      });
      const last = index === afterSegments.length - 1;
      if (entry.kind === "file") {
        if (!last) {
          throw new Error("listTree: continuation cursor last key does not exist in its basis");
        }
        continue;
      }
      currentDepth += 1;
      if (currentDepth > MAX_TREE_DEPTH) throw new Error("listTree: tree exceeds max depth");
      const child = await readTreeNode(blobsDir, entry.childHash);
      if (!child) throw missingTreeObjectError(entry.childHash);
      if (last) {
        // A directory key precedes its descendants in tree preorder.
        stack.push({
          entries: child,
          index: 0,
          prefixPath: entryPath,
          prefixUtf8Bytes: utf8ByteLength(entryPath),
          depth: currentDepth,
        });
      } else {
        currentEntries = child;
        currentPrefix = entryPath;
      }
    }
  }

  const out: TreeListEntry[] = [];
  let hasMore = false;
  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (!frame) break;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    if (out.length >= limit) {
      hasMore = true;
      break;
    }
    const entry = frame.entries[frame.index];
    frame.index += 1;
    if (!entry) throw new Error("listTree: corrupt traversal frame");
    const entryPath = frame.prefixPath ? `${frame.prefixPath}/${entry.name}` : entry.name;
    const entryPathUtf8Bytes =
      frame.prefixUtf8Bytes + (frame.prefixPath ? 1 : 0) + utf8ByteLength(entry.name);
    if (entryPathUtf8Bytes > MAX_TREE_PATH_UTF8_BYTES) {
      throw new Error(
        `listTree: tree path exceeds the canonical ${MAX_TREE_PATH_UTF8_BYTES}-byte projection bound`
      );
    }
    if (entry.kind === "file") {
      out.push({
        path: entryPath,
        kind: "file",
        contentHash: entry.contentHash,
        mode: entry.mode,
      });
      continue;
    }
    out.push({ path: entryPath, kind: "dir", treeHash: entry.childHash });
    const childDepth = frame.depth + 1;
    if (childDepth > MAX_TREE_DEPTH) throw new Error("listTree: tree exceeds max depth");
    const child = await readTreeNode(blobsDir, entry.childHash);
    if (!child) throw missingTreeObjectError(entry.childHash);
    stack.push({
      entries: child,
      index: 0,
      prefixPath: entryPath,
      prefixUtf8Bytes: entryPathUtf8Bytes,
      depth: childDepth,
    });
  }
  if (!hasMore) return { basis, entries: out, completeness: "complete" };
  const last = assertPresent(out.at(-1));
  return {
    basis,
    entries: out,
    completeness: "continuation",
    nextCursor: encodeTreeListCursor({
      v: TREE_CURSOR_VERSION,
      basisHash: treeListBasisHash(basis),
      after: last.path,
    }),
  };
}

/** Walk exact pages without accumulating them. Validation/root-minting drains
 * this iterator; full-snapshot consumers explicitly collect it. */
export async function* iterateExactTreePages(
  blobsDir: string,
  ref: string,
  options: { prefix?: string; pageSize?: number } = {}
): AsyncGenerator<TreeListPage, void, void> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedBasis: TreeListBasis | undefined;
  for (;;) {
    const page = await listTree(blobsDir, ref, {
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(options.pageSize ? { limit: options.pageSize } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (page === null) throw missingTreeObjectError(ref);
    if (!expectedBasis) {
      expectedBasis = page.basis;
    } else if (!sameTreeListBasis(expectedBasis, page.basis)) {
      throw new Error("collectExactTreeListing: tree basis changed between pages");
    }
    yield page;
    if (page.completeness === "complete") return;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("collectExactTreeListing: repeated continuation cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** Deliberately materialize a complete immutable tree inventory by following
 * the exact page iterator. Full-snapshot host consumers use this helper so no
 * caller can accidentally reinterpret one page as the whole tree. */
export async function collectExactTreeListing(
  blobsDir: string,
  ref: string,
  options: { prefix?: string; pageSize?: number; maxEntries?: number } = {}
): Promise<TreeListEntry[] | null> {
  // Preserve the meaningful absent-root result for inventory callers. Broken
  // state pointers and interiors still throw from the iterator/list method.
  if (!(await pathExists(blobPath(blobsDir, treeHashDigest(ref))))) return null;
  const entries: TreeListEntry[] = [];
  const pageSize =
    options.maxEntries === undefined
      ? options.pageSize
      : Math.min(options.pageSize ?? DEFAULT_TREE_PAGE_SIZE, options.maxEntries + 1);
  for await (const page of iterateExactTreePages(blobsDir, ref, {
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(pageSize ? { pageSize } : {}),
  })) {
    if (
      options.maxEntries !== undefined &&
      entries.length + page.entries.length > options.maxEntries
    ) {
      throw new ExactTreeListingLimitExceeded(options.maxEntries, options.maxEntries + 1);
    }
    entries.push(...page.entries);
  }
  return entries;
}

/**
 * Resolve a tree-relative file path to its content digest + mode, or null
 * when the path is absent (or names a directory) or the root object is
 * absent. Path segments are strictly validated (no traversal).
 */
export async function readFileAtTree(
  blobsDir: string,
  ref: string,
  filePath: string
): Promise<{ contentHash: string; mode: number } | null> {
  const segments = splitTreePath(filePath);
  if (segments.length === 0) return null;
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) return null;
  let entries = await readTreeNode(blobsDir, rootHash);
  if (!entries) return null;
  for (const [i, segment] of segments.entries()) {
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return null;
    const last = i === segments.length - 1;
    if (entry.kind === "file") {
      return last ? { contentHash: entry.contentHash, mode: entry.mode } : null;
    }
    if (last) return null; // path names a directory
    const child = await readTreeNode(blobsDir, entry.childHash);
    if (!child) throw missingTreeObjectError(entry.childHash);
    entries = child;
  }
  return null;
}

export type TreePathEntry =
  | { kind: "dir"; treeHash: string }
  | { kind: "file"; contentHash: string; mode: number };

/**
 * Resolve a tree-relative path to its content address: a directory resolves
 * to its `manifest:` tree hash, a file to its `{contentHash, mode}`, and the
 * empty path to the root tree itself. This IS the subtree-hash semantics of
 * `buildWorktreeManifest().subtreeHash`: a dir entry's childHash is the
 * subtree hash, a file entry's contentHash is the file's content address —
 * byte-identical to the reference implementation, so consumers deriving
 * cache keys from these hashes (buildV2 effective versions) are stable
 * across sources. Null when the path is absent
 * (or descends through/into a file) or the root object is absent; a missing
 * INTERIOR node throws (incomplete store). Path segments are strictly
 * validated (no traversal).
 */
export async function resolveTreePath(
  blobsDir: string,
  ref: string,
  treePath: string
): Promise<TreePathEntry | null> {
  const segments = splitTreePath(treePath);
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) return null;
  if (segments.length === 0) return { kind: "dir", treeHash: rootHash };
  let entries = await readTreeNode(blobsDir, rootHash);
  if (!entries) return null;
  for (const [i, segment] of segments.entries()) {
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return null;
    const last = i === segments.length - 1;
    if (entry.kind === "file") {
      return last ? { kind: "file", contentHash: entry.contentHash, mode: entry.mode } : null;
    }
    if (last) return { kind: "dir", treeHash: entry.childHash };
    const child = await readTreeNode(blobsDir, entry.childHash);
    if (!child) throw missingTreeObjectError(entry.childHash);
    entries = child;
  }
  return null;
}

/**
 * Authoritative diff between two trees: added/removed/changed file paths.
 * Merkle walk — identical subtree hashes are skipped wholesale, so the cost
 * is proportional to the CHANGE, not the tree. A path whose type flips
 * (file⇄dir) reports as removed + added. Throws when any referenced object
 * is missing — the store computes diffs only over trees it fully holds.
 */
export async function diffTrees(blobsDir: string, refA: string, refB: string): Promise<TreeDiff> {
  const rootA = await resolveTreeRef(blobsDir, refA);
  const rootB = await resolveTreeRef(blobsDir, refB);
  if (!rootA) throw missingTreeObjectError(refA);
  if (!rootB) throw missingTreeObjectError(refB);

  const diff: TreeDiff = { added: [], removed: [], changed: [] };
  const assertDiffCapacity = (): void => {
    if (diff.added.length + diff.removed.length + diff.changed.length >= MAX_TREE_DIFF_ENTRIES) {
      throw new Error(
        `diffTrees: change set exceeds the explicit ${MAX_TREE_DIFF_ENTRIES}-entry admission bound`
      );
    }
  };
  const appendFile = (bucket: TreeDiffFile[], entry: TreeDiffFile): void => {
    assertDiffCapacity();
    bucket.push(entry);
  };

  const collect = async (
    treeHash: string,
    prefixPath: string,
    bucket: TreeDiffFile[],
    depth: number
  ): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw new Error("diffTrees: tree exceeds max depth");
    const entries = await readTreeNode(blobsDir, treeHash);
    if (!entries) throw missingTreeObjectError(treeHash);
    for (const entry of entries) {
      const entryPath = prefixPath ? `${prefixPath}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        appendFile(bucket, { path: entryPath, contentHash: entry.contentHash, mode: entry.mode });
      } else {
        await collect(entry.childHash, entryPath, bucket, depth + 1);
      }
    }
  };

  const walk = async (
    hashA: string,
    hashB: string,
    prefixPath: string,
    depth: number
  ): Promise<void> => {
    if (hashA === hashB) return; // structural sharing: identical subtrees
    if (depth > MAX_TREE_DEPTH) throw new Error("diffTrees: tree exceeds max depth");
    const [entriesA, entriesB] = await Promise.all([
      readTreeNode(blobsDir, hashA),
      readTreeNode(blobsDir, hashB),
    ]);
    if (!entriesA) throw missingTreeObjectError(hashA);
    if (!entriesB) throw missingTreeObjectError(hashB);
    const byNameB = new Map(entriesB.map((entry) => [entry.name, entry]));

    for (const a of entriesA) {
      const b = byNameB.get(a.name);
      byNameB.delete(a.name);
      const entryPath = prefixPath ? `${prefixPath}/${a.name}` : a.name;
      if (!b) {
        if (a.kind === "file") {
          appendFile(diff.removed, {
            path: entryPath,
            contentHash: a.contentHash,
            mode: a.mode,
          });
        } else {
          await collect(a.childHash, entryPath, diff.removed, depth + 1);
        }
      } else if (a.kind === "file" && b.kind === "file") {
        if (a.contentHash !== b.contentHash || a.mode !== b.mode) {
          assertDiffCapacity();
          diff.changed.push({
            path: entryPath,
            fromContentHash: a.contentHash,
            toContentHash: b.contentHash,
            fromMode: a.mode,
            toMode: b.mode,
          });
        }
      } else if (a.kind === "dir" && b.kind === "dir") {
        await walk(a.childHash, b.childHash, entryPath, depth + 1);
      } else if (a.kind === "file") {
        // file → dir
        appendFile(diff.removed, {
          path: entryPath,
          contentHash: a.contentHash,
          mode: a.mode,
        });
        await collect((b as { childHash: string }).childHash, entryPath, diff.added, depth + 1);
      } else {
        // dir → file
        await collect(a.childHash, entryPath, diff.removed, depth + 1);
        const fileB = b as { contentHash: string; mode: number };
        appendFile(diff.added, {
          path: entryPath,
          contentHash: fileB.contentHash,
          mode: fileB.mode,
        });
      }
    }
    for (const b of byNameB.values()) {
      const entryPath = prefixPath ? `${prefixPath}/${b.name}` : b.name;
      if (b.kind === "file") {
        appendFile(diff.added, {
          path: entryPath,
          contentHash: b.contentHash,
          mode: b.mode,
        });
      } else {
        await collect(b.childHash, entryPath, diff.added, depth + 1);
      }
    }
  };

  await walk(rootA, rootB, "", 0);
  return diff;
}

/**
 * Resolve the on-disk root for `materializeTree`. The longest *existing* prefix
 * of `outDir` is realpath'd so a legitimately symlinked ancestor (e.g. `/tmp`
 * → `/private/tmp` on macOS) collapses to its canonical form and is not a false
 * positive; the not-yet-existing tail below it is returned verbatim so the
 * walker can create each component itself with a no-follow guard. Returns the
 * canonical existing root plus the tail segments still to be created.
 */
async function resolveMaterializeRoot(outDir: string): Promise<{ root: string; tail: string[] }> {
  const resolvedOutDir = path.resolve(outDir);
  try {
    const st = await fsp.lstat(resolvedOutDir);
    if (st.isSymbolicLink()) {
      throw new Error(
        `materializeTree: refusing to use symlink output directory ${JSON.stringify(outDir)}`
      );
    }
    if (!st.isDirectory()) {
      throw new Error(
        `materializeTree: refusing to use output path ${JSON.stringify(outDir)} because it is not a directory`
      );
    }
    return { root: await fsp.realpath(resolvedOutDir), tail: [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let cur = resolvedOutDir;
  const tail: string[] = [];
  for (;;) {
    try {
      const root = await fsp.realpath(cur);
      return { root, tail };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err; // filesystem root missing — cannot happen
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Create (idempotently) and verify a single directory component, refusing to
 * follow through a symlink. Mirrors the ancestor-symlink guard in
 * `gitInteropService.assertWorkspaceCreateTargetSafe`: any pre-existing symlink
 * at a directory component under the materialize root would silently redirect
 * writes outside the intended tree, so it is a loud error rather than a
 * follow-through. `lstat` is used deliberately (physical inode at the path, not
 * the symlink's target).
 */
async function mkdirNoFollow(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = await fsp.lstat(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`materializeTree: refusing to descend through symlink ${JSON.stringify(dir)}`);
  }
  if (!st.isDirectory()) {
    throw new Error(
      `materializeTree: refusing to descend: ${JSON.stringify(dir)} is not a directory`
    );
  }
}

/**
 * Project a tree onto disk at `outDir` (absolute). Non-executable files
 * hardlink from the CAS by default (`link: false` copies); executables are
 * always COPIED then chmod'd so the shared CAS inode's mode is never touched
 * (a chmod on a hardlink would flip every build-source checkout sharing the
 * blob). The outDir is treated as immutable-per-tree: an existing file is
 * skipped only when its byte size and content hash match the source blob.
 * Writes are tmp+rename so a crash never leaves a half-written file at a final path. Entry names
 * come from strictly-decoded nodes (no separators/`..`), so the tree cannot
 * write outside `outDir`. Directory descent is additionally no-follow: `outDir`
 * is realpath-resolved once up front and every directory component created or
 * traversed *below* that root is `lstat`-checked, so a pre-existing symlink at
 * any component cannot silently redirect writes outside the intended tree.
 */
export async function materializeTree(
  blobsDir: string,
  ref: string,
  outDir: string,
  opts?: { link?: boolean }
): Promise<{ written: number; unchanged: number }> {
  if (!path.isAbsolute(outDir)) {
    throw new Error(
      `materializeTree: outDir must be an absolute path, got ${JSON.stringify(outDir)}`
    );
  }
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) throw missingTreeObjectError(ref);
  for await (const _page of iterateExactTreePages(blobsDir, ref)) {
    // Validate cumulative projection bounds and every interior object before
    // creating any output path. The actual projector then streams file bodies.
  }
  const link = opts?.link ?? true;
  let written = 0;
  let unchanged = 0;

  // `dir` handed to `walk` is always an already-created, lstat-verified
  // (non-symlink) directory. Subdirectories are created + verified here before
  // descending so a pre-existing symlink at any component is a loud error.
  const walk = async (treeHash: string, dir: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw new Error("materializeTree: tree exceeds max depth");
    const entries = await readTreeNode(blobsDir, treeHash);
    if (!entries) throw missingTreeObjectError(treeHash);
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.kind === "dir") {
        await mkdirNoFollow(target);
        await walk(entry.childHash, target, depth + 1);
        continue;
      }
      const source = blobPath(blobsDir, entry.contentHash);
      if (!(await pathExists(source))) {
        throw new Error(
          `materializeTree: missing file blob ${entry.contentHash} for ${JSON.stringify(entry.name)}`
        );
      }
      const executable = entry.mode === TREE_EXEC_MODE;
      try {
        // `lstat` (not `stat`) on the target: we want what is *physically* at
        // the path. A symlink there reports `isFile() === false`, so it is
        // never trusted-and-skipped — it falls through and is replaced by a
        // real file below (rm removes the link itself, no-follow).
        const [sourceStat, targetStat] = await Promise.all([fsp.stat(source), fsp.lstat(target)]);
        if (targetStat.isFile() && targetStat.size === sourceStat.size) {
          const targetDigest = await sha256File(target);
          if (targetDigest === entry.contentHash) {
            unchanged += 1;
            continue;
          }
        }
      } catch {
        // Missing target — fall through to write.
      }
      const tmp = path.join(dir, `.${entry.name}.${process.pid}.${Date.now()}.tmp`);
      await fsp.rm(tmp, { force: true });
      let linked = false;
      if (link && !executable) {
        try {
          await fsp.link(source, tmp);
          linked = true;
        } catch {
          // Cross-device or unsupported — fall back to copy.
        }
      }
      if (!linked) {
        await fsp.copyFile(source, tmp);
        await fsp.chmod(tmp, executable ? 0o755 : 0o644);
      }
      // The target may exist as a directory (dir→file transition) — rename
      // onto a directory fails, so clear it first.
      await fsp.rm(target, { force: true, recursive: true }).catch(() => {});
      await fsp.rename(tmp, target);
      written += 1;
    }
  };

  // Resolve the root once (collapsing legitimately symlinked ancestors), then
  // create + verify every not-yet-existing component of `outDir` itself with
  // the same no-follow discipline before walking the tree.
  const { root, tail } = await resolveMaterializeRoot(outDir);
  let base = root;
  for (const seg of tail) {
    base = path.join(base, seg);
    await mkdirNoFollow(base);
  }
  await walk(rootHash, base, 0);
  return { written, unchanged };
}

export function createBlobstoreService(deps: BlobstoreServiceDeps): ServiceWithRoutes {
  const definition: ServiceDefinition = {
    name: "blobstore",
    description: "Per-workspace content-addressable blob storage",
    policy: READ_POLICY,
    methods: blobstoreMethods,
    handler: defineServiceHandler("blobstore", blobstoreMethods, {
      has: (_ctx, [hash]) => pathExists(blobPath(deps.blobsDir, hash)),
      stat: (_ctx, [hash]) => statBlob(deps.blobsDir, hash),
      putText: (_ctx, [text]) => putBytes(deps.blobsDir, Buffer.from(text, "utf8")),
      getText: async (_ctx, [hash]) => {
        const bytes = await getBytes(deps.blobsDir, hash);
        return bytes ? bytes.toString("utf8") : null;
      },
      getRange: async (_ctx, [hash, start, end]) => {
        const bytes = await getByteRange(deps.blobsDir, hash, start, end);
        return bytes ? bytes.toString("utf8") : null;
      },
      getRangeBytes: async (_ctx, [hash, start, end]) => {
        const bytes = await getByteRange(deps.blobsDir, hash, start, end);
        return bytes ? { bytesBase64: bytes.toString("base64") } : null;
      },
      grep: (_ctx, [hash, query, options]) => grepBlob(deps.blobsDir, hash, query, options ?? {}),
      putBase64: (_ctx, [content]) => putBytes(deps.blobsDir, Buffer.from(content, "base64")),
      getBase64: async (_ctx, [hash]) => {
        const bytes = await getBytes(deps.blobsDir, hash);
        return bytes ? bytes.toString("base64") : null;
      },
      putTree: (_ctx, [entries, options]) => putTree(deps.blobsDir, entries, options),
      getTree: (_ctx, [hash]) => getTree(deps.blobsDir, hash),
      listTree: (_ctx, [hash, options]) => listTree(deps.blobsDir, hash, options),
      readFileAtTree: (_ctx, [hash, filePath]) => readFileAtTree(deps.blobsDir, hash, filePath),
      diffTrees: (_ctx, [leftHash, rightHash]) => diffTrees(deps.blobsDir, leftHash, rightHash),
      materializeTree: (_ctx, [hash, outDir, options]) =>
        materializeTree(deps.blobsDir, hash, outDir, options),
      delete: async (_ctx, [hash]) => {
        const filePath = blobPath(deps.blobsDir, hash);
        try {
          await fsp.unlink(filePath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      list: (_ctx, [options]) => listBlobs(deps.blobsDir, options),
    }),
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "blobstore",
      path: "/blob",
      methods: ["PUT"],
      auth: "caller-token",
      handler: async (req, res) => {
        try {
          sendJson(res, 200, await putBlob(deps.blobsDir, req));
        } catch (error) {
          log.warn("Blob PUT failed:", error);
          sendText(res, 500, "Blob write failed");
        }
      },
    },
    {
      serviceName: "blobstore",
      path: "/blob/:digest",
      methods: ["GET"],
      auth: "caller-token",
      handler: async (_req, res, params) => {
        const digest = params["digest"] ?? "";
        if (!DIGEST_RE.test(digest)) {
          sendText(res, 400, "Malformed digest");
          return;
        }

        const filePath = blobPath(deps.blobsDir, digest);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            sendText(res, 404, "Blob not found");
            return;
          }
          log.warn("Blob stat failed:", error);
          sendText(res, 500, "Blob read failed");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
          ETag: `"${digest}"`,
          "Cache-Control": "max-age=31536000, immutable",
        });
        const stream = fs.createReadStream(filePath);
        stream.on("error", (error) => {
          log.warn("Blob read stream failed:", error);
          if (!res.headersSent) {
            sendText(res, 500, "Blob read failed");
          } else {
            res.destroy(error);
          }
        });
        stream.pipe(res);
      },
    },
  ];

  return {
    definition,
    routes,
    start() {
      ensureLayout(deps.blobsDir);
      const backingDir = backingCasDir(deps.blobsDir);
      ensureBlobCasLayout(backingDir);
      sweepTmp(deps.blobsDir);
    },
  };
}
