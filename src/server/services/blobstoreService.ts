import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { createDevLogger } from "@vibez1/dev-log";
import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import {
  BLOBSTORE_READ_POLICY as READ_POLICY,
  DIGEST_RE,
  blobstoreMethods,
} from "@vibez1/shared/serviceSchemas/blobstore";
import {
  decodeStateNode,
  decodeTreeNode,
  encodeStateNode,
  encodeTreeNode,
  encodeWorktreeTree,
  splitTreePath,
  treeHashDigest,
  STATE_HASH_RE,
  TREE_HASH_RE,
  TREE_EXEC_MODE,
} from "@vibez1/shared/contentTree/treeObjects";
import type { ManifestHashEntry, WorktreeHashFile } from "@vibez1/shared/contentTree/worktreeHash";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../serviceWithHttpRoutes.js";
import { assertPresent } from "../../lintHelpers";

const log = createDevLogger("BlobstoreService");

export interface BlobstoreServiceDeps {
  blobsDir: string;
}

export interface BlobStat {
  size: number;
  mtime: number;
}

export function ensureLayout(blobsDir: string): void {
  fs.mkdirSync(path.join(blobsDir, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(blobsDir, "sha256"), { recursive: true });
}

function sweepTmp(blobsDir: string): void {
  const tmpDir = path.join(blobsDir, "tmp");
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
}

function validateDigest(digest: string): void {
  if (!DIGEST_RE.test(digest)) {
    throw new Error("Invalid sha256 digest");
  }
}

export function blobPath(blobsDir: string, digest: string): string {
  validateDigest(digest);
  return path.join(blobsDir, "sha256", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
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
    const finalPath = blobPath(blobsDir, digest);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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
  const digest = createHash("sha256").update(bytes).digest("hex");
  const finalPath = blobPath(blobsDir, digest);
  if (await pathExists(finalPath)) {
    return { digest, size: bytes.byteLength };
  }

  const tmpPath = path.join(blobsDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmpPath, bytes, { flag: "wx" });
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await fsp.unlink(tmpPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return { digest, size: bytes.byteLength };
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
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
    const finalPath = blobPath(blobsDir, digest);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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

  for (const first of firstDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/.test(first.name)) continue;
    if (prefix.length >= 2 && first.name !== prefix.slice(0, 2)) continue;
    if (prefix.length < 2 && !first.name.startsWith(prefix)) continue;

    const secondDirPath = path.join(shaDir, first.name);
    const secondDirs = await fsp.readdir(secondDirPath, { withFileTypes: true });
    for (const second of secondDirs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/.test(second.name)) continue;
      const firstFour = first.name + second.name;
      if (prefix.length >= 4 && firstFour !== prefix.slice(0, 4)) continue;
      if (prefix.length < 4 && !firstFour.startsWith(prefix)) continue;

      const leafDir = path.join(secondDirPath, second.name);
      const files = await fsp.readdir(leafDir, { withFileTypes: true });
      for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
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

function isTreeObjectBytes(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  try {
    decodeTreeNode(text);
    return true;
  } catch {
    // Not a directory node; try the state root-pointer shape below.
  }
  try {
    decodeStateNode(text);
    return true;
  } catch {
    return false;
  }
}

export async function pruneUnreferencedTreeObjects(
  blobsDir: string,
  opts: { referenced: string[]; dryRun?: boolean; olderThanMs?: number; limit?: number }
): Promise<{ deleted: string[]; kept: number; dryRun: boolean }> {
  const referenced = new Set(opts.referenced);
  const all = await listBlobs(blobsDir, { limit: opts.limit });
  const deleted: string[] = [];
  let kept = 0;
  const now = Date.now();
  for (const digest of all) {
    if (referenced.has(digest)) {
      kept++;
      continue;
    }
    const stat = await statBlob(blobsDir, digest);
    if (!stat) continue;
    if (opts.olderThanMs != null && now - stat.mtime < opts.olderThanMs) {
      kept++;
      continue;
    }
    const bytes = await getBytes(blobsDir, digest);
    if (!bytes || !isTreeObjectBytes(bytes)) {
      kept++;
      continue;
    }
    deleted.push(digest);
    if (!opts.dryRun) {
      await fsp.unlink(blobPath(blobsDir, digest)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  return { deleted, kept, dryRun: opts.dryRun === true };
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
// @vibez1/shared/contentTree/treeObjects; this section binds it to the disk
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
 * `buildWorktreeManifest`, i.e. to the gad-store DO) and writes every distinct
 * directory node bottom-up, then the `state:` root pointer LAST — so the state
 * node's presence implies the complete tree beneath it is present, which is
 * exactly the cheap already-mirrored fast path here.
 *
 * `expectStateHash` is the integrity check for listings fetched from the gad
 * store: when the re-encoded state hash disagrees (truncated/corrupt listing),
 * this throws BEFORE writing anything.
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
    treeDigests: [...treeDigests].sort(),
    contentDigests: [...contentDigests].sort(),
  };
}

/**
 * Recursive listing of every file and directory under `opts.prefix` (whole
 * tree when omitted), in depth-first traversal order (name-sorted within each
 * directory). Null when the root object is absent; an absent prefix path
 * yields an empty listing; a missing INTERIOR node throws (incomplete store).
 */
export async function listTree(
  blobsDir: string,
  ref: string,
  opts?: { prefix?: string; limit?: number }
): Promise<TreeListEntry[] | null> {
  const rootHash = await resolveTreeRef(blobsDir, ref);
  if (!rootHash) return null;
  const limit = Math.max(1, Math.min(opts?.limit ?? 10_000, 100_000));
  const segments = splitTreePath(opts?.prefix ?? "");

  let entries = await readTreeNode(blobsDir, rootHash);
  if (!entries) return null;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return [];
    if (entry.kind === "file") {
      // The prefix itself names a file — list exactly that file.
      if (i === segments.length - 1) {
        return [
          {
            path: segments.join("/"),
            kind: "file",
            contentHash: entry.contentHash,
            mode: entry.mode,
          },
        ];
      }
      return [];
    }
    const child = await readTreeNode(blobsDir, entry.childHash);
    if (!child) throw missingTreeObjectError(entry.childHash);
    entries = child;
  }

  const out: TreeListEntry[] = [];
  const walk = async (
    dirEntries: ManifestHashEntry[],
    prefixPath: string,
    depth: number
  ): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw new Error("listTree: tree exceeds max depth");
    for (const entry of dirEntries) {
      if (out.length >= limit) return;
      const entryPath = prefixPath ? `${prefixPath}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({
          path: entryPath,
          kind: "file",
          contentHash: entry.contentHash,
          mode: entry.mode,
        });
      } else {
        out.push({ path: entryPath, kind: "dir", treeHash: entry.childHash });
        const child = await readTreeNode(blobsDir, entry.childHash);
        if (!child) throw missingTreeObjectError(entry.childHash);
        await walk(child, entryPath, depth + 1);
      }
    }
  };
  await walk(entries, segments.join("/"), 0);
  return out;
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
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
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
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
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
        bucket.push({ path: entryPath, contentHash: entry.contentHash, mode: entry.mode });
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
          diff.removed.push({ path: entryPath, contentHash: a.contentHash, mode: a.mode });
        } else {
          await collect(a.childHash, entryPath, diff.removed, depth + 1);
        }
      } else if (a.kind === "file" && b.kind === "file") {
        if (a.contentHash !== b.contentHash || a.mode !== b.mode) {
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
        diff.removed.push({ path: entryPath, contentHash: a.contentHash, mode: a.mode });
        await collect((b as { childHash: string }).childHash, entryPath, diff.added, depth + 1);
      } else {
        // dir → file
        await collect(a.childHash, entryPath, diff.removed, depth + 1);
        const fileB = b as { contentHash: string; mode: number };
        diff.added.push({ path: entryPath, contentHash: fileB.contentHash, mode: fileB.mode });
      }
    }
    for (const b of byNameB.values()) {
      const entryPath = prefixPath ? `${prefixPath}/${b.name}` : b.name;
      if (b.kind === "file") {
        diff.added.push({ path: entryPath, contentHash: b.contentHash, mode: b.mode });
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
  let cur = path.resolve(outDir);
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
 * blob). The outDir is treated as immutable-per-tree: an existing file whose
 * size matches the source blob is trusted and skipped. Writes are tmp+rename
 * so a crash never leaves a half-written file at a final path. Entry names
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
          unchanged += 1;
          continue;
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
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "has":
          return pathExists(blobPath(deps.blobsDir, args[0] as string));
        case "stat":
          return statBlob(deps.blobsDir, args[0] as string);
        case "putText":
          return putBytes(deps.blobsDir, Buffer.from(args[0] as string, "utf8"));
        case "getText": {
          const bytes = await getBytes(deps.blobsDir, args[0] as string);
          return bytes ? bytes.toString("utf8") : null;
        }
        case "getRange": {
          const bytes = await getByteRange(
            deps.blobsDir,
            args[0] as string,
            args[1] as number,
            args[2] as number
          );
          return bytes ? bytes.toString("utf8") : null;
        }
        case "getRangeBytes": {
          const bytes = await getByteRange(
            deps.blobsDir,
            args[0] as string,
            args[1] as number,
            args[2] as number
          );
          return bytes ? { bytesBase64: bytes.toString("base64") } : null;
        }
        case "grep": {
          return grepBlob(
            deps.blobsDir,
            args[0] as string,
            args[1] as string,
            (args[2] as {
              caseInsensitive?: boolean;
              contextLines?: number;
              maxMatches?: number;
            }) ?? {}
          );
        }
        case "putBase64":
          return putBytes(deps.blobsDir, Buffer.from(args[0] as string, "base64"));
        case "getBase64": {
          const bytes = await getBytes(deps.blobsDir, args[0] as string);
          return bytes ? bytes.toString("base64") : null;
        }
        case "putTree":
          return putTree(
            deps.blobsDir,
            args[0] as ManifestHashEntry[],
            args[1] as { root?: boolean } | undefined
          );
        case "getTree":
          return getTree(deps.blobsDir, args[0] as string);
        case "listTree":
          return listTree(
            deps.blobsDir,
            args[0] as string,
            args[1] as { prefix?: string; limit?: number } | undefined
          );
        case "readFileAtTree":
          return readFileAtTree(deps.blobsDir, args[0] as string, args[1] as string);
        case "diffTrees":
          return diffTrees(deps.blobsDir, args[0] as string, args[1] as string);
        case "materializeTree":
          return materializeTree(
            deps.blobsDir,
            args[0] as string,
            args[1] as string,
            args[2] as { link?: boolean } | undefined
          );
        case "delete": {
          const filePath = blobPath(deps.blobsDir, args[0] as string);
          try {
            await fsp.unlink(filePath);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        }
        case "list":
          return listBlobs(
            deps.blobsDir,
            args[0] as { prefix?: string; limit?: number } | undefined
          );
        default:
          throw new Error(`Unknown blobstore method '${method}'`);
      }
    },
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
      sweepTmp(deps.blobsDir);
    },
  };
}
