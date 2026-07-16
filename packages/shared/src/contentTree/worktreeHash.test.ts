/** Golden vectors for the single runtime-neutral content-addressing kernel. */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  EMPTY_MANIFEST_HASH,
  EMPTY_STATE_HASH,
  buildWorktreeManifest,
  compareUtf16CodeUnits,
  manifestHashForEntries,
  sha256Hex,
  sha256HexSyncText,
  stableSha256Hex,
  stateHashForRoot,
} from "@vibestudio/content-addressing";

// Fixed fake content hashes (any 64-hex string; manifest hashing is over metadata).
const H1 = "aa".repeat(32);
const H2 = "bb".repeat(32);
const H3 = "cc".repeat(32);
const H4 = "dd".repeat(32);

describe("content addressing golden vectors", () => {
  it("pure-JS sha256 matches NIST vectors", () => {
    expect(sha256HexSyncText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256HexSyncText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // Multi-block message (1000 bytes spans many 64-byte blocks).
    expect(sha256HexSyncText("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
    // Non-ASCII text goes through UTF-8 encoding.
    expect(sha256HexSyncText("héllo wörld — 日本語 🦆")).toBe(
      "ca8f0d70dacbf170b5bdbd2a0782bd6ed3e689b039b38c0bd8c9f841606c89ff"
    );
  });

  it("hashes exact bytes identically to Node and WebCrypto", async () => {
    const fixtures = [
      new Uint8Array(),
      new Uint8Array([0, 1, 127, 128, 255]),
      new TextEncoder().encode("héllo wörld — 日本語 🦆"),
    ];
    expect(sha256Hex(fixtures[1]!)).toBe(
      "0150a92bb1212cd00516b65fde0704614760000963874fcbb11eaa734ee87809"
    );
    for (const bytes of fixtures) {
      const nodeDigest = createHash("sha256").update(bytes).digest("hex");
      const webDigest = Array.from(
        new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("");
      expect(sha256Hex(bytes)).toBe(nodeDigest);
      expect(sha256Hex(bytes)).toBe(webDigest);
    }
  });

  it("canonical JSON sorts keys recursively, preserves arrays, drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }], skip: undefined })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}'
    );
    expect(stableSha256Hex({ b: 1, a: [2, { d: 3, c: 4 }], skip: undefined })).toBe(
      "9da9574727f41f18e3a4ffeaa320b627d810e778f3685a63d22d8b3262962c6d"
    );
  });

  it("empty manifest/state constants match", () => {
    expect(EMPTY_MANIFEST_HASH).toBe(
      "manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526"
    );
    expect(EMPTY_STATE_HASH).toBe(
      "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7"
    );
  });

  it("single root file (vector 1)", () => {
    const manifest = buildWorktreeManifest([{ path: "hello.txt", contentHash: H1, mode: 33188 }]);
    expect(manifest.rootHash).toBe(
      "manifest:0f3bc383fb0a33bc37504b98cddab2e82fd50789d5e9feda8d2bdc4cbfe984a0"
    );
    expect(manifest.stateHash).toBe(
      "state:2f15b5b9ed3c669eb1f248dfe5ce41617b7a7892c891310b930b5df0a6eca2e4"
    );
  });

  it("nested tree with executable bit, unicode names, unsorted input (vector 2)", () => {
    const manifest = buildWorktreeManifest([
      { path: "src/z.ts", contentHash: H2, mode: 33188 },
      { path: "src/a.ts", contentHash: H1, mode: 33188 },
      { path: "bin/run.sh", contentHash: H3, mode: 33261 },
      { path: "README.md", contentHash: H4, mode: 33188 },
      { path: "docs/día/nota—1.md", contentHash: H1, mode: 33188 },
    ]);
    expect(manifest.rootHash).toBe(
      "manifest:2110894be15886d82b8733ec4369208c166f4a954051c04df5d314ab8bb64e4b"
    );
    expect(manifest.stateHash).toBe(
      "state:75184f8cd5240c4936a121a5b08f7e21324d299d5d5dcef1d1a92df0b8562a7f"
    );
    expect(manifest.subtreeHash("src")).toBe(
      "manifest:6202c5b37a04cf5aa0e313c8e272a30240a1040e717ee45a4718e0d264be46be"
    );
    expect(manifest.subtreeHash("bin")).toBe(
      "manifest:e7e8ae2a5fba8411cbbce9ca10fa244d9ef511f39c43d268bd9237ae40f1746d"
    );
    expect(manifest.subtreeHash("docs")).toBe(
      "manifest:a91c67cf6c08e020feda99951262d924dcd6684506f6a9263102c97320e2fc4e"
    );
    expect(manifest.subtreeHash("docs/día")).toBe(
      "manifest:f8bda2ae3ee1bdcf17c2a767373ae0ae3eb93e0b1edbe9e1d0945057509e6feb"
    );
    // A file path resolves to its plain content hash; the root to the root hash.
    expect(manifest.subtreeHash("src/a.ts")).toBe(H1);
    expect(manifest.subtreeHash("")).toBe(manifest.rootHash);
    expect(manifest.subtreeHash("nope")).toBeNull();
  });

  it("direct manifestHashForEntries over mixed unsorted entries (vector 3)", () => {
    const hash = manifestHashForEntries([
      { name: "zeta", kind: "file", contentHash: H2, mode: 33261 },
      {
        name: "alpha",
        kind: "dir",
        childHash: "manifest:6202c5b37a04cf5aa0e313c8e272a30240a1040e717ee45a4718e0d264be46be",
      },
      { name: "beta", kind: "file", contentHash: H1, mode: 33188 },
    ]);
    expect(hash).toBe("manifest:c20d5fbe7edd28ca5e6de9ddb6d31d4c53628e3c9eccbcc7d0fd957262654b60");
    expect(stateHashForRoot(hash)).toBe(
      "state:f3ebd06edd2fd3466ae74886026c5983632e8ef4f845620cb6f31d3b507ba32c"
    );
  });

  it("entry ordering is UTF-16 code-unit order, not locale or code-point order (vector 4)", () => {
    // Code-unit order: "B" (0x42) < "a" (0x61) < "ä" (0xE4) — localeCompare
    // would interleave differently and produce a different hash.
    const unsorted = manifestHashForEntries([
      { name: "ä", kind: "file", contentHash: H1, mode: 33188 },
      { name: "a", kind: "file", contentHash: H2, mode: 33188 },
      { name: "B", kind: "file", contentHash: H3, mode: 33188 },
    ]);
    expect(unsorted).toBe(
      "manifest:02999e7b28148f9c63887e7373ff3b72c69ccf6a54ca2f2e23c65519152512b8"
    );
    // Input order must not matter (sorting happens inside).
    const presorted = manifestHashForEntries([
      { name: "B", kind: "file", contentHash: H3, mode: 33188 },
      { name: "a", kind: "file", contentHash: H2, mode: 33188 },
      { name: "ä", kind: "file", contentHash: H1, mode: 33188 },
    ]);
    expect(presorted).toBe(unsorted);
  });

  it("exports locale-independent canonical text order for BMP and astral Unicode", () => {
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("protocol ordering must not consult locale collation");
      });
    try {
      expect(["ä", "a", "B"].sort(compareUtf16CodeUnits)).toEqual(["B", "a", "ä"]);
      // U+1F600 begins with the UTF-16 high surrogate D83D, which sorts before
      // the BMP private-use code unit E000 even though its Unicode code point is larger.
      expect(["\uE000", "😀"].sort(compareUtf16CodeUnits)).toEqual(["😀", "\uE000"]);
      expect(canonicalJson({ "\uE000": 1, "😀": 2 })).toBe('{"😀":2,"":1}');
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("structural sharing: identical subtrees at different paths share one hash", () => {
    const manifest = buildWorktreeManifest([
      { path: "left/lib/x.ts", contentHash: H1, mode: 33188 },
      { path: "right/lib/x.ts", contentHash: H1, mode: 33188 },
    ]);
    expect(manifest.subtreeHash("left")).toBe(manifest.subtreeHash("right"));
    expect(manifest.subtreeHash("left/lib")).toBe(manifest.subtreeHash("right/lib"));
  });
});
