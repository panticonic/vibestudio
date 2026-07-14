import {
  SHA2_256_HASH_ALGORITHM,
  bytesToHex,
  sameObjectRef,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  VIBE_BLOB_CODEC,
  VIBE_STATE_CODEC,
  VIBE_TREE_CODEC,
  contentStoreRefForSha256,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import {
  TREE_EXEC_MODE,
  TREE_FILE_MODE,
  encodeWorktreeTree,
  treeHashDigest,
  type EncodedWorktreeTree,
} from "@vibestudio/shared/contentTree/treeObjects";
import type { GadFileRowV1 } from "./schema.js";

export interface GadProjectedObjectV1 {
  object: ContentStoreObjectRef;
  bytes: Uint8Array;
}

export interface GadWorktreeProjectionV1 extends EncodedWorktreeTree {
  kind: "gad.vibeWorktreeProjection";
  projectorVersion: 1;
  rootObject: ContentStoreObjectRef;
  stateObject: ContentStoreObjectRef;
  /** Directory nodes child-first followed by the state node. */
  objects: GadProjectedObjectV1[];
}

function sameCodec(
  left: ContentStoreObjectRef["codec"],
  right: ContentStoreObjectRef["codec"]
): boolean {
  return left.number === right.number && left.version === right.version;
}

/**
 * Deterministically project authoritative `vcs_files` rows with the existing
 * Vibe tree codec. No independent tree algorithm or second source of truth is
 * introduced here.
 */
export function projectGadFilesToVibeWorktreeV1(
  files: readonly GadFileRowV1[],
  options: { emptyStoreId?: Uint8Array } = {}
): GadWorktreeProjectionV1 {
  const byPath = new Set<string>();
  const byId = new Set<string>();
  let storeId: Uint8Array | null = options.emptyStoreId?.slice() ?? null;
  if (storeId?.byteLength === 0) throw new Error("Projection content-store ID must not be empty");
  for (const file of files) {
    if (byPath.has(file.path)) throw new Error(`Duplicate authoritative file path: ${file.path}`);
    if (byId.has(file.fileId)) throw new Error(`Duplicate authoritative file ID: ${file.fileId}`);
    byPath.add(file.path);
    byId.add(file.fileId);
    if (file.blobRef.storeId.byteLength === 0) {
      throw new Error(`File ${file.path} has an empty content-store ID`);
    }
    if (!sameCodec(file.blobRef.codec, VIBE_BLOB_CODEC)) {
      throw new Error(`File ${file.path} does not use the frozen Vibe blob codec`);
    }
    if (file.blobRef.contentId.algorithm !== SHA2_256_HASH_ALGORITHM) {
      throw new Error(`File ${file.path} does not use SHA2-256`);
    }
    if (file.blobRef.contentId.digest.byteLength !== 32) {
      throw new Error(`File ${file.path} has a non-256-bit digest`);
    }
    if (file.mode !== TREE_FILE_MODE && file.mode !== TREE_EXEC_MODE) {
      throw new Error(`File ${file.path} has an unsupported worktree mode ${file.mode}`);
    }
    if (storeId === null) storeId = file.blobRef.storeId.slice();
    else {
      const comparison: ContentStoreObjectRef = {
        ...file.blobRef,
        storeId,
      };
      if (!sameObjectRef(comparison, file.blobRef)) {
        throw new Error("A Vibe worktree projection cannot span content stores");
      }
    }
  }
  if (storeId === null)
    throw new Error("Projection requires an explicit store via at least one file");

  const encoded = encodeWorktreeTree(
    files.map((file) => ({
      path: file.path,
      contentHash: bytesToHex(file.blobRef.contentId.digest),
      mode: file.mode,
    }))
  );
  const utf8 = new TextEncoder();
  const objects: GadProjectedObjectV1[] = encoded.nodes.map((node) => ({
    object: contentStoreRefForSha256(storeId, VIBE_TREE_CODEC, treeHashDigest(node.treeHash)),
    bytes: utf8.encode(node.canonicalText),
  }));
  const stateObject = contentStoreRefForSha256(
    storeId,
    VIBE_STATE_CODEC,
    treeHashDigest(encoded.stateHash)
  );
  objects.push({ object: stateObject, bytes: utf8.encode(encoded.stateNode.canonicalText) });

  return {
    kind: "gad.vibeWorktreeProjection",
    projectorVersion: 1,
    ...encoded,
    rootObject: contentStoreRefForSha256(
      storeId,
      VIBE_TREE_CODEC,
      treeHashDigest(encoded.rootTreeHash)
    ),
    stateObject,
    objects,
  };
}
