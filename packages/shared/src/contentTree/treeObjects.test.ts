import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  buildWorktreeManifest,
  isValidTreeEntryName,
  manifestHashForEntries,
  sha256HexSyncText,
  splitTreePath,
  stateHashForRoot,
  EMPTY_MANIFEST_HASH,
  EMPTY_STATE_HASH,
  type ManifestHashEntry,
  type WorktreeHashFile,
} from "@vibestudio/content-addressing";
import {
  decodeStateNode,
  decodeTreeNode,
  encodeStateNode,
  encodeTreeNode,
  encodeWorktreeTree,
  normalizeTreeEntries,
  treeHashDigest,
  STATE_HASH_RE,
  TREE_HASH_RE,
} from "./treeObjects.js";

const H1 = "aa".repeat(32);
const H2 = "bb".repeat(32);

const FILE = (name: string, hash = H1, mode = 33188): ManifestHashEntry => ({
  name,
  kind: "file",
  contentHash: hash,
  mode,
});

describe("contentTree/treeObjects", () => {
  it("encodeTreeNode: treeHash equals manifestHashForEntries, hex part is the digest of the stored bytes", () => {
    const entries: ManifestHashEntry[] = [
      FILE("b.txt", H2, 33261),
      FILE("a.txt", H1),
      { name: "sub", kind: "dir", childHash: encodeTreeNode([]).treeHash },
    ];
    const encoded = encodeTreeNode(entries);
    expect(encoded.treeHash).toBe(manifestHashForEntries(entries));
    expect(encoded.treeHash).toMatch(TREE_HASH_RE);
    // The addressing invariant that lets tree nodes live in the flat CAS:
    // manifest:<hex> where <hex> = sha256(canonical node JSON).
    expect(sha256HexSyncText(encoded.canonicalText)).toBe(treeHashDigest(encoded.treeHash));
    // Round trip.
    expect(decodeTreeNode(encoded.canonicalText)).toEqual(encoded.entries);
    // Entries come back codepoint-sorted.
    expect(encoded.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub"]);
  });

  it("encodeStateNode: stateHash matches stateHashForRoot and addresses its own bytes", () => {
    const root = encodeTreeNode([FILE("x")]).treeHash;
    const state = encodeStateNode(root);
    expect(state.stateHash).toBe(stateHashForRoot(root));
    expect(state.stateHash).toMatch(STATE_HASH_RE);
    expect(sha256HexSyncText(state.canonicalText)).toBe(treeHashDigest(state.stateHash));
    expect(decodeStateNode(state.canonicalText)).toBe(root);
  });

  it("rejects invalid entry names (traversal, separators, empties)", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(isValidTreeEntryName(bad)).toBe(false);
      expect(() => normalizeTreeEntries([FILE(bad)])).toThrow(/Invalid tree entry name/);
    }
    for (const ok of ["a", ".hidden", "with space", "ünïcode", "..twodots"]) {
      expect(isValidTreeEntryName(ok)).toBe(true);
    }
  });

  it("rejects duplicate names, bad hashes, bad modes, bad kinds", () => {
    expect(() => normalizeTreeEntries([FILE("a"), FILE("a", H2)])).toThrow(/Duplicate/);
    expect(() => normalizeTreeEntries([FILE("a", "nothex")])).toThrow(/contentHash/);
    expect(() => normalizeTreeEntries([FILE("a", H1, 0o644)])).toThrow(/Invalid file mode/);
    expect(() => normalizeTreeEntries([{ name: "d", kind: "dir", childHash: H1 }])).toThrow(
      /childHash/
    ); // plain digest is not a manifest: hash
    expect(() =>
      normalizeTreeEntries([{ name: "x", kind: "symlink" } as unknown as ManifestHashEntry])
    ).toThrow(/kind/);
  });

  it("decodeTreeNode rejects crafted non-canonical or malicious nodes", () => {
    // Not JSON.
    expect(() => decodeTreeNode("not json")).toThrow(/not valid JSON/);
    // Wrong shape.
    expect(() => decodeTreeNode('{"kind":"file"}')).toThrow(/expected/);
    expect(() => decodeTreeNode("[]")).toThrow(/expected/);
    // Traversal name smuggled into an otherwise well-formed node.
    const evil = canonicalJson({
      kind: "dir",
      entries: [{ contentHash: H1, kind: "file", mode: 33188, name: "../evil" }],
    });
    expect(() => decodeTreeNode(evil)).toThrow(/Invalid tree entry name/);
    // Unsorted entries (valid names, canonical keys) are rejected.
    const unsorted = canonicalJson({
      kind: "dir",
      entries: [
        { contentHash: H1, kind: "file", mode: 33188, name: "b" },
        { contentHash: H2, kind: "file", mode: 33188, name: "a" },
      ],
    });
    expect(() => decodeTreeNode(unsorted)).toThrow(/UTF-16 code-unit order/);
    // Duplicate names sort "equal" — also not strictly increasing.
    const dup = canonicalJson({
      kind: "dir",
      entries: [
        { contentHash: H1, kind: "file", mode: 33188, name: "a" },
        { contentHash: H2, kind: "file", mode: 33188, name: "a" },
      ],
    });
    expect(() => decodeTreeNode(dup)).toThrow(/UTF-16 code-unit order/);
    // Non-canonical byte form (extra whitespace) of a valid node.
    const canonical = encodeTreeNode([FILE("a")]).canonicalText;
    expect(() => decodeTreeNode(canonical.replace('"kind"', ' "kind"'))).toThrow(/canonical/);
    // Extra keys are dropped by canonicalization? No — canonicalJson keeps
    // them, so re-serialization differs from a node we would write... but an
    // extra key round-trips through canonicalJson identically. Guard shape:
    const extra = canonicalJson({
      entries: [{ contentHash: H1, extra: 1, kind: "file", mode: 33188, name: "a" }],
      kind: "dir",
    });
    // The entry re-serializes with its extra key, so canonical-form check
    // passes — but the HASH then covers the extra key too, which is exactly
    // the addressing contract: bytes at digest X decode to what hashed to X.
    expect(decodeTreeNode(extra).map((e) => e.name)).toEqual(["a"]);
  });

  it("decodeStateNode rejects junk and non-canonical forms", () => {
    expect(() => decodeStateNode("null")).toThrow(/expected/);
    expect(() => decodeStateNode('{"manifestRootHash":"deadbeef"}')).toThrow(/expected/);
    const root = encodeTreeNode([]).treeHash;
    const good = encodeStateNode(root).canonicalText;
    expect(() => decodeStateNode(` ${good}`)).toThrow(/canonical/);
    expect(() => encodeStateNode("state:" + "0".repeat(64))).toThrow(/Invalid tree root hash/);
  });

  it("splitTreePath validates every segment", () => {
    expect(splitTreePath("")).toEqual([]);
    expect(splitTreePath("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
    for (const bad of ["/a", "a//b", "a/../b", "a/./b", "a/", "..", "a\\b"]) {
      expect(() => splitTreePath(bad)).toThrow(/Invalid tree entry name/);
    }
  });

  it("treeHashDigest extracts the hex CAS address; rejects other strings", () => {
    expect(treeHashDigest(`manifest:${H1}`)).toBe(H1);
    expect(treeHashDigest(`state:${H2}`)).toBe(H2);
    expect(() => treeHashDigest(H1)).toThrow(/Not a tree\/state hash/);
    expect(() => treeHashDigest("manifest:XYZ")).toThrow(/Not a tree\/state hash/);
  });

  describe("encodeWorktreeTree", () => {
    const F = (path: string, contentHash = H1, mode = 33188): WorktreeHashFile => ({
      path,
      contentHash,
      mode,
    });

    it("is hash-identical to buildWorktreeManifest (root, state, and every subtree)", () => {
      const files = [
        F("README.md"),
        F("src/index.ts", H2),
        F("src/deep/nested/util.ts", H1, 33261),
        F("panels/chat/index.tsx", H2),
      ];
      const encoded = encodeWorktreeTree(files);
      const manifest = buildWorktreeManifest(files);
      expect(encoded.rootTreeHash).toBe(manifest.rootHash);
      expect(encoded.stateHash).toBe(manifest.stateHash);
      // Every emitted node's hash matches the manifest's subtree address.
      const nodeHashes = new Set(encoded.nodes.map((n) => n.treeHash));
      for (const sub of ["src", "src/deep", "src/deep/nested", "panels", "panels/chat"]) {
        const hash = manifest.subtreeHash(sub);
        expect(hash).not.toBeNull();
        expect(nodeHashes.has(hash!)).toBe(true);
      }
      expect(encoded.stateNode.stateHash).toBe(manifest.stateHash);
    });

    it("emits children strictly before parents (root last), deduplicated", () => {
      const files = [
        // Two structurally identical subtrees → one shared node.
        F("a/lib/x.ts"),
        F("b/lib/x.ts"),
        F("top.txt", H2),
      ];
      const encoded = encodeWorktreeTree(files);
      // Dedup: a/lib and b/lib collapse to one node; a and b likewise.
      const hashes = encoded.nodes.map((n) => n.treeHash);
      expect(new Set(hashes).size).toBe(hashes.length);
      // Root node is last; every dir child hash appears earlier in the list.
      expect(hashes[hashes.length - 1]).toBe(encoded.rootTreeHash);
      const seen = new Set<string>();
      for (const node of encoded.nodes) {
        for (const entry of node.entries) {
          if (entry.kind === "dir") expect(seen.has(entry.childHash)).toBe(true);
        }
        seen.add(node.treeHash);
      }
    });

    it("empty listing encodes to the canonical empty manifest/state hashes", () => {
      const encoded = encodeWorktreeTree([]);
      expect(encoded.rootTreeHash).toBe(EMPTY_MANIFEST_HASH);
      expect(encoded.stateHash).toBe(EMPTY_STATE_HASH);
      expect(encoded.nodes).toHaveLength(1);
      expect(decodeTreeNode(encoded.nodes[0]!.canonicalText)).toEqual([]);
    });

    it("rejects unsafe paths, invalid modes, and file/dir name collisions", () => {
      expect(() => encodeWorktreeTree([F("../evil")])).toThrow(/Invalid tree entry name/);
      expect(() => encodeWorktreeTree([F("a//b")])).toThrow(/Invalid tree entry name/);
      expect(() => encodeWorktreeTree([F("a\\b")])).toThrow(/Invalid tree entry name/);
      expect(() => encodeWorktreeTree([F("")])).toThrow(/empty file path/);
      expect(() => encodeWorktreeTree([F("ok.txt", H1, 0o644)])).toThrow(/Invalid file mode/);
      // `a` as both a file and a directory would put duplicate names in one node.
      expect(() => encodeWorktreeTree([F("a"), F("a/b.txt")])).toThrow(/Duplicate tree entry/);
    });
  });
});
