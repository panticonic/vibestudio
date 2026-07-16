/**
 * Content-store tree objects — the pure (no-fs) half of first-class immutable
 * trees in the generic blob CAS.
 *
 * A tree node is stored as a canonical-JSON blob in the SAME CAS as file
 * blobs (one substrate, so blob GC sees tree nodes), and is addressed by its
 * manifest hash: `manifestHashForEntries(entries)` is exactly
 * `manifest:<sha256 of the canonical node JSON>`, so the hex suffix of a tree
 * hash IS the blob digest of the node's bytes. Likewise a state root pointer
 * `{manifestRootHash}` is stored at the hex suffix of its `state:` hash.
 * The hash protocol is owned by the runtime-neutral
 * `@vibestudio/content-addressing` package.
 *
 * Decoding is strict by design: blob writes are unauthenticated content, so
 * ANY bytes can exist at a digest. `decodeTreeNode` therefore refuses
 * anything that is not the exact canonical serialization of a valid,
 * UTF-16-code-unit-sorted, safely-named entry list — a crafted "tree node" with
 * `../` names or junk shape can never flow into list/read/materialize.
 */

import {
  assertValidTreeEntryName,
  canonicalJson,
  compareUtf16CodeUnits,
  manifestHashForEntries,
  splitTreePath,
  stateHashForRoot,
  type ManifestHashEntry,
  type WorktreeHashFile,
} from "@vibestudio/content-addressing";

export const TREE_HASH_RE = /^manifest:[0-9a-f]{64}$/;
export const STATE_HASH_RE = /^state:[0-9a-f]{64}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/** Git-style regular-file mode. */
export const TREE_FILE_MODE = 33188;
/** Git-style executable-file mode. */
export const TREE_EXEC_MODE = 33261;

/** Hex blob digest a `manifest:`/`state:` hash's node object is stored at. */
export function treeHashDigest(hash: string): string {
  if (TREE_HASH_RE.test(hash)) return hash.slice("manifest:".length);
  if (STATE_HASH_RE.test(hash)) return hash.slice("state:".length);
  throw new Error(`Not a tree/state hash: ${JSON.stringify(hash)}`);
}

function assertValidEntry(entry: ManifestHashEntry): void {
  assertValidTreeEntryName(entry.name);
  if (entry.kind === "file") {
    if (!CONTENT_HASH_RE.test(entry.contentHash)) {
      throw new Error(
        `Invalid file contentHash for ${JSON.stringify(entry.name)}: expected 64-hex sha256`
      );
    }
    if (entry.mode !== TREE_FILE_MODE && entry.mode !== TREE_EXEC_MODE) {
      throw new Error(
        `Invalid file mode ${entry.mode} for ${JSON.stringify(entry.name)}: expected ${TREE_FILE_MODE} (regular) or ${TREE_EXEC_MODE} (executable)`
      );
    }
  } else if (entry.kind === "dir") {
    if (!TREE_HASH_RE.test(entry.childHash)) {
      throw new Error(
        `Invalid dir childHash for ${JSON.stringify(entry.name)}: expected manifest:<64-hex>`
      );
    }
  } else {
    throw new Error(
      `Invalid tree entry kind: ${JSON.stringify((entry as { kind: unknown }).kind)}`
    );
  }
}

/**
 * Validate a caller-supplied entry list and return it UTF-16-code-unit-sorted (the
 * canonical node order). Throws on invalid names/hashes/modes/kinds and on
 * duplicate names.
 */
export function normalizeTreeEntries(entries: ManifestHashEntry[]): ManifestHashEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    assertValidEntry(entry);
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate tree entry name: ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);
  }
  return [...entries].sort((a, b) => compareUtf16CodeUnits(a.name, b.name));
}

export interface EncodedTreeNode {
  /** `manifest:<hex>` — also the CAS address (hex part) of `canonicalText`. */
  treeHash: string;
  /** Canonical JSON bytes to store in the CAS. */
  canonicalText: string;
  /** Validated, UTF-16-code-unit-sorted entries. */
  entries: ManifestHashEntry[];
}

/** Encode a validated entry list into its canonical stored node. */
export function encodeTreeNode(entries: ManifestHashEntry[]): EncodedTreeNode {
  const sorted = normalizeTreeEntries(entries);
  const treeHash = manifestHashForEntries(sorted);
  const canonicalText = canonicalJson({ kind: "dir", entries: sorted });
  return { treeHash, canonicalText, entries: sorted };
}

/**
 * Strictly decode a stored tree-node blob. Rejects anything that is not the
 * exact canonical serialization of a valid sorted entry list — shape, entry
 * validity, UTF-16 code-unit sort order, and byte-for-byte canonical form are all
 * enforced, so `manifest:<digest of these bytes>` is guaranteed to equal
 * `manifestHashForEntries(entries)`.
 */
export function decodeTreeNode(text: string): ManifestHashEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Corrupt tree node: not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { kind?: unknown }).kind !== "dir" ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error('Corrupt tree node: expected {"kind":"dir","entries":[...]}');
  }
  const entries = (parsed as { entries: unknown[] }).entries as ManifestHashEntry[];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Corrupt tree node: entry is not an object");
    }
    assertValidEntry(entry);
  }
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1]!.name;
    const next = entries[i]!.name;
    if (compareUtf16CodeUnits(prev, next) >= 0) {
      throw new Error(
        `Corrupt tree node: entries not in UTF-16 code-unit order (${JSON.stringify(prev)} !< ${JSON.stringify(next)})`
      );
    }
  }
  // Canonical-form check: the stored bytes must be exactly what we would
  // write. This rejects extra keys, non-sorted key order, whitespace, and
  // number-formatting variants in one shot.
  const canonical = canonicalJson({ kind: "dir", entries });
  if (canonical !== text) {
    throw new Error("Corrupt tree node: not in canonical JSON form");
  }
  return entries;
}

export interface EncodedStateNode {
  /** `state:<hex>` — also the CAS address (hex part) of `canonicalText`. */
  stateHash: string;
  canonicalText: string;
}

/** Encode a root pointer object for a tree root (`state:` scheme). */
export function encodeStateNode(rootTreeHash: string): EncodedStateNode {
  if (!TREE_HASH_RE.test(rootTreeHash)) {
    throw new Error(`Invalid tree root hash: ${JSON.stringify(rootTreeHash)}`);
  }
  const stateHash = stateHashForRoot(rootTreeHash);
  const canonicalText = canonicalJson({ manifestRootHash: rootTreeHash });
  return { stateHash, canonicalText };
}

export interface EncodedWorktreeTree {
  /** `manifest:` hash of the root directory node. */
  rootTreeHash: string;
  /** `state:` hash of the root pointer — the gad worktree-state hash. */
  stateHash: string;
  /**
   * Every DISTINCT directory node of the tree, children strictly before
   * parents (the root node last), deduplicated by tree hash. Writing them to
   * a CAS in this order means a parent node never exists before its children.
   */
  nodes: EncodedTreeNode[];
  stateNode: EncodedStateNode;
}

/**
 * Encode a full worktree file listing into its content-store tree objects —
 * the pure half of mirroring a gad worktree state into the blob CAS. The
 * resulting `stateHash`/`rootTreeHash` are byte-identical to
 * `buildWorktreeManifest(files)` (both reduce to `manifestHashForEntries` /
 * `stateHashForRoot` over the same recursive structure), so a listing fetched
 * from the gad store re-encodes to the exact state hash the store minted.
 *
 * Stricter than `buildWorktreeManifest` by design: every path flows through
 * {@link splitTreePath}, so a listing with traversal/separator/NUL tricks in
 * a segment (or a path that is both a file and a directory, which would
 * produce duplicate entry names in one node) throws instead of encoding an
 * unmaterializable tree.
 */
export function encodeWorktreeTree(files: WorktreeHashFile[]): EncodedWorktreeTree {
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: Map<string, { contentHash: string; mode: number }>;
  }
  const root: DirNode = { dirs: new Map(), files: new Map() };
  for (const file of files) {
    const segments = splitTreePath(file.path);
    if (segments.length === 0) {
      throw new Error("encodeWorktreeTree: empty file path");
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, {
      contentHash: file.contentHash,
      mode: file.mode,
    });
  }

  const nodes: EncodedTreeNode[] = [];
  const seen = new Set<string>();
  const build = (node: DirNode): string => {
    const entries: ManifestHashEntry[] = [];
    for (const [name, child] of node.dirs) {
      entries.push({ name, kind: "dir", childHash: build(child) });
    }
    for (const [name, file] of node.files) {
      entries.push({ name, kind: "file", contentHash: file.contentHash, mode: file.mode });
    }
    const encoded = encodeTreeNode(entries);
    if (!seen.has(encoded.treeHash)) {
      seen.add(encoded.treeHash);
      nodes.push(encoded);
    }
    return encoded.treeHash;
  };
  const rootTreeHash = build(root);
  const stateNode = encodeStateNode(rootTreeHash);
  return { rootTreeHash, stateHash: stateNode.stateHash, nodes, stateNode };
}

/** Strictly decode a stored state-pointer blob into its root tree hash. */
export function decodeStateNode(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Corrupt state node: not valid JSON");
  }
  const rootHash = (parsed as { manifestRootHash?: unknown } | null)?.manifestRootHash;
  if (typeof rootHash !== "string" || !TREE_HASH_RE.test(rootHash)) {
    throw new Error('Corrupt state node: expected {"manifestRootHash":"manifest:<hex>"}');
  }
  if (canonicalJson({ manifestRootHash: rootHash }) !== text) {
    throw new Error("Corrupt state node: not in canonical JSON form");
  }
  return rootHash;
}
