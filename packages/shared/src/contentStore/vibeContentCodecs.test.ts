import { describe, expect, it } from "vitest";
import { treeHashDigest } from "../contentTree/treeObjects.js";
import { bytesToHex } from "./exactContentStore.js";
import {
  contentStoreRefForSha256,
  inspectVibeContentObject,
  VIBE_BLOB_CODEC,
  VIBE_STATE_CODEC,
  VIBE_TREE_CODEC,
} from "./vibeContentCodecs.js";
import { VIBE_CONTENT_STORE_FIXTURES_V1 as FIXTURES } from "./vibeContentStoreFixtures.js";

const STORE_ID = new TextEncoder().encode("vibe-fixture-store");

describe("Vibe exact content-store codecs", () => {
  it("pins the existing empty Blob/Tree/State bytes and SHA-256 identities", () => {
    expect(VIBE_BLOB_CODEC).toEqual(FIXTURES.codecs.blob);
    expect(VIBE_TREE_CODEC).toEqual(FIXTURES.codecs.tree);
    expect(VIBE_STATE_CODEC).toEqual(FIXTURES.codecs.state);
    expect(treeHashDigest(FIXTURES.emptyTree.legacyRef)).toBe(FIXTURES.emptyTree.sha256);
    expect(treeHashDigest(FIXTURES.emptyState.legacyRef)).toBe(FIXTURES.emptyState.sha256);

    const tree = contentStoreRefForSha256(STORE_ID, VIBE_TREE_CODEC, FIXTURES.emptyTree.sha256);
    const state = contentStoreRefForSha256(STORE_ID, VIBE_STATE_CODEC, FIXTURES.emptyState.sha256);
    expect(bytesToHex(tree.contentId.digest)).toBe(FIXTURES.emptyTree.sha256);
    expect(bytesToHex(state.contentId.digest)).toBe(FIXTURES.emptyState.sha256);
    expect(
      inspectVibeContentObject(tree, new TextEncoder().encode(FIXTURES.emptyTree.bytesUtf8))
    ).toEqual([]);
    expect(
      inspectVibeContentObject(state, new TextEncoder().encode(FIXTURES.emptyState.bytesUtf8))
    ).toEqual([
      {
        role: "rootTree",
        target: tree,
      },
    ]);
  });

  it("treats legacy file hashes as opaque required children of canonical tree bytes", () => {
    const treeBytes = new TextEncoder().encode(FIXTURES.fileTree.bytesUtf8);
    const tree = contentStoreRefForSha256(
      STORE_ID,
      VIBE_TREE_CODEC,
      FIXTURES.fileTree.sha256
    );
    expect(inspectVibeContentObject(tree, treeBytes)).toEqual([
      {
        role: "file:empty.txt",
        target: contentStoreRefForSha256(
          STORE_ID,
          VIBE_BLOB_CODEC,
          FIXTURES.emptyBlob.sha256
        ),
      },
    ]);

    const directoryTree = contentStoreRefForSha256(
      STORE_ID,
      VIBE_TREE_CODEC,
      FIXTURES.directoryTree.sha256
    );
    expect(
      inspectVibeContentObject(
        directoryTree,
        new TextEncoder().encode(FIXTURES.directoryTree.bytesUtf8)
      )
    ).toEqual([
      {
        role: "directory:empty",
        target: contentStoreRefForSha256(
          STORE_ID,
          VIBE_TREE_CODEC,
          FIXTURES.emptyTree.sha256
        ),
      },
    ]);
  });

  it("rejects non-canonical tree bytes and unknown codec interpretations", () => {
    const tree = contentStoreRefForSha256(STORE_ID, VIBE_TREE_CODEC, "22".repeat(32));
    expect(() =>
      inspectVibeContentObject(
        tree,
        new TextEncoder().encode(' {"entries":[],"kind":"dir"}')
      )
    ).toThrow(/canonical/u);

    const unknown = contentStoreRefForSha256(
      STORE_ID,
      { number: 0x7fffffff, version: 1 },
      "22".repeat(32)
    );
    expect(() => inspectVibeContentObject(unknown, new Uint8Array())).toThrow(/Unknown/u);
  });

  it("enforces the exact frozen entry shapes and rejects unpaired surrogates", () => {
    const tree = contentStoreRefForSha256(STORE_ID, VIBE_TREE_CODEC, "33".repeat(32));
    expect(() =>
      inspectVibeContentObject(
        tree,
        new TextEncoder().encode(
          `{"entries":[{"contentHash":"${FIXTURES.emptyBlob.sha256}","extra":1,"kind":"file","mode":33188,"name":"a"}],"kind":"dir"}`
        )
      )
    ).toThrow(/frozen file shape/u);
    expect(() =>
      inspectVibeContentObject(
        tree,
        new TextEncoder().encode(
          `{"entries":[{"contentHash":"${FIXTURES.emptyBlob.sha256}","kind":"file","mode":33188,"name":"\\ud800"}],"kind":"dir"}`
        )
      )
    ).toThrow(/unpaired surrogate/u);

    const canonical = new TextEncoder().encode(FIXTURES.emptyTree.bytesUtf8);
    const withBom = new Uint8Array(canonical.byteLength + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(canonical, 3);
    expect(() => inspectVibeContentObject(tree, withBom)).toThrow(/UTF-8/u);
  });
});
