import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sameObjectRef } from "@vibestudio/shared/contentStore/exactContentStore";
import {
  contentStoreRefForSha256,
  VIBE_BLOB_CODEC,
  VIBE_STATE_CODEC,
  VIBE_TREE_CODEC,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { VIBE_CONTENT_STORE_FIXTURES_V1 as FIXTURES } from "@vibestudio/shared/contentStore/vibeContentStoreFixtures";
import { encodeStateNode, encodeTreeNode } from "@vibestudio/shared/contentTree/treeObjects";
import { blobCasPath, putBlobBytes } from "./blobCas.js";
import { VibeExactContentStore } from "./vibeExactContentStore.js";

const STORE_ID = new TextEncoder().encode("vibe-central-cas-v1");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("VibeExactContentStore", () => {
  let rootDir: string;
  let store: VibeExactContentStore;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vibe-exact-content-store-"));
    store = new VibeExactContentStore({ rootDir, storeId: STORE_ID });
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it("reads legacy CAS bytes through exact refs without rewriting their identity", async () => {
    const bytes = Buffer.from(FIXTURES.emptyTree.bytesUtf8, "utf8");
    const legacy = await putBlobBytes(rootDir, bytes);
    expect(legacy.digest).toBe(FIXTURES.emptyTree.sha256);

    const object = contentStoreRefForSha256(STORE_ID, VIBE_TREE_CODEC, legacy.digest);
    await expect(store.has([object])).resolves.toEqual([true]);
    const [result] = await store.get([object]);
    expect(Buffer.from(result!.bytes!)).toEqual(bytes);
    expect(sameObjectRef(result!.object, object)).toBe(true);
  });

  it("allows parent-first upload and makes missing closure repairable", async () => {
    const fileBytes = new TextEncoder().encode("hello from the legacy blob codec\n");
    const fileDigest = digest(fileBytes);
    const treeNode = encodeTreeNode([
      { name: "hello.txt", kind: "file", contentHash: fileDigest, mode: 33188 },
    ]);
    const treeBytes = new TextEncoder().encode(treeNode.canonicalText);
    const stateNode = encodeStateNode(treeNode.treeHash);
    const stateBytes = new TextEncoder().encode(stateNode.canonicalText);
    const file = store.identify(VIBE_BLOB_CODEC, fileBytes);
    const tree = store.identify(VIBE_TREE_CODEC, treeBytes);
    const state = store.identify(VIBE_STATE_CODEC, stateBytes);

    await expect(
      store.put([
        { object: state, bytes: stateBytes },
        { object: tree, bytes: treeBytes },
      ])
    ).resolves.toMatchObject([{ status: "inserted" }, { status: "inserted" }]);
    const incomplete = await store.seal(state);
    expect(incomplete.visitedObjectCount).toBe(3);
    expect(incomplete.missingRequiredDescendants).toHaveLength(1);
    expect(sameObjectRef(incomplete.missingRequiredDescendants[0]!, file)).toBe(true);

    await store.put([{ object: file, bytes: fileBytes }]);
    await expect(store.seal(state)).resolves.toMatchObject({
      missingRequiredDescendants: [],
      visitedObjectCount: 3,
    });
  });

  it("keeps physical identity codec-independent while validating every typed use", async () => {
    const bytes = new TextEncoder().encode(FIXTURES.emptyTree.bytesUtf8);
    const tree = store.identify(VIBE_TREE_CODEC, bytes);
    const blob = store.identify(VIBE_BLOB_CODEC, bytes);
    expect(tree.contentId.digest).toEqual(blob.contentId.digest);

    await expect(store.put([{ object: tree, bytes }])).resolves.toMatchObject([
      { status: "inserted" },
    ]);
    await expect(store.get([blob])).resolves.toMatchObject([{ bytes }]);

    const arbitraryBytes = new TextEncoder().encode("not a canonical tree");
    const wronglyTyped = store.identify(VIBE_TREE_CODEC, arbitraryBytes);
    await expect(store.put([{ object: wronglyTyped, bytes: arbitraryBytes }])).rejects.toThrow(
      /tree node/u
    );
  });

  it("reports exactly one insertion for concurrent identical puts", async () => {
    const bytes = new TextEncoder().encode("deduplicated");
    const object = store.identify(VIBE_BLOB_CODEC, bytes);
    const results = await Promise.all([
      store.put([{ object, bytes }]),
      store.put([{ object, bytes }]),
    ]);
    expect(
      results
        .flat()
        .map((result) => result.status)
        .sort()
    ).toEqual(["alreadyPresent", "inserted"]);
  });

  it("rejects corrupt existing bytes, foreign stores, and unsupported hashes", async () => {
    const expectedBytes = new TextEncoder().encode("expected");
    const object = store.identify(VIBE_BLOB_CODEC, expectedBytes);
    const filePath = blobCasPath(rootDir, digest(expectedBytes));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "corrupt");
    await expect(store.put([{ object, bytes: expectedBytes }])).rejects.toThrow(/Corrupt/u);

    const foreign = contentStoreRefForSha256(
      new TextEncoder().encode("another-store"),
      VIBE_BLOB_CODEC,
      digest(expectedBytes)
    );
    await expect(store.has([foreign])).rejects.toThrow(/different store/u);

    const unsupported = {
      ...object,
      contentId: { ...object.contentId, algorithm: 0x1e },
    };
    await expect(store.get([unsupported])).rejects.toThrow(/only SHA2-256/u);
  });

  it("does not add enumeration or mutable-ref methods to the reducer-facing adapter", () => {
    expect("list" in store).toBe(false);
    expect("scan" in store).toBe(false);
    expect("delete" in store).toBe(false);
    expect("updateRef" in store).toBe(false);
  });
});
