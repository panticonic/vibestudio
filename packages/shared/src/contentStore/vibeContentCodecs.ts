import {
  SHA2_256_HASH_ALGORITHM,
  bytesFromHex,
  type ContentStoreCodecId,
  type ContentStoreObjectRef,
  type ContentStoreRequiredEdge,
} from "./exactContentStore.js";
import { decodeStateNode, decodeTreeNode, treeHashDigest } from "../contentTree/treeObjects.js";

/** Same generic opaque-blob assignment as the reducer content-store protocol. */
export const VIBE_BLOB_CODEC: ContentStoreCodecId = { number: 0x300001, version: 1 };
/** Private application codec number whose bytes spell `VBT1`. */
export const VIBE_TREE_CODEC: ContentStoreCodecId = { number: 0x56425431, version: 1 };
/** Private application codec number whose bytes spell `VBS1`. */
export const VIBE_STATE_CODEC: ContentStoreCodecId = { number: 0x56425331, version: 1 };

export function contentStoreRefForSha256(
  storeId: Uint8Array,
  codec: ContentStoreCodecId,
  digestHex: string
): ContentStoreObjectRef {
  const digest = bytesFromHex(digestHex);
  if (storeId.byteLength === 0) throw new Error("Content store ID must not be empty");
  if (digest.byteLength !== 32) throw new Error("SHA2-256 content digest must contain 32 bytes");
  return {
    storeId: storeId.slice(),
    codec: { ...codec },
    contentId: { algorithm: SHA2_256_HASH_ALGORITHM, digest },
  };
}

function sameCodec(left: ContentStoreCodecId, right: ContentStoreCodecId): boolean {
  return left.number === right.number && left.version === right.version;
}

function decodeCanonicalUtf8(bytes: Uint8Array, kind: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const roundTrip = new TextEncoder().encode(text);
    if (
      roundTrip.byteLength !== bytes.byteLength ||
      roundTrip.some((byte, index) => byte !== bytes[index])
    ) {
      throw new Error(`Corrupt ${kind}: bytes are not canonical UTF-8`);
    }
    return text;
  } catch {
    throw new Error(`Corrupt ${kind}: bytes are not valid UTF-8`);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertFrozenVibeTreeEntryShapes(
  entries: ReturnType<typeof decodeTreeNode>
): void {
  for (const entry of entries) {
    const actualKeys = Object.keys(entry).sort();
    const expectedKeys =
      entry.kind === "file"
        ? ["contentHash", "kind", "mode", "name"]
        : ["childHash", "kind", "name"];
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new Error(`Corrupt Vibe tree node: entry does not have the frozen ${entry.kind} shape`);
    }
    if (hasUnpairedSurrogate(entry.name)) {
      throw new Error("Corrupt Vibe tree node: entry name contains an unpaired surrogate");
    }
  }
}

/**
 * Validate one Vibe typed interpretation and return all of its required CAS
 * edges. The stored bytes are the pre-existing canonical JSON bytes; codecs
 * add validation and graph meaning without wrapping or rewriting them.
 */
export function inspectVibeContentObject(
  object: ContentStoreObjectRef,
  bytes: Uint8Array
): ContentStoreRequiredEdge[] {
  if (object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM) {
    throw new Error("Vibestudio content codecs require SHA2-256 identity");
  }
  if (sameCodec(object.codec, VIBE_BLOB_CODEC)) return [];

  if (sameCodec(object.codec, VIBE_TREE_CODEC)) {
    const entries = decodeTreeNode(decodeCanonicalUtf8(bytes, "Vibe tree node"));
    assertFrozenVibeTreeEntryShapes(entries);
    return entries.map((entry) => ({
      role: entry.kind === "file" ? `file:${entry.name}` : `directory:${entry.name}`,
      target: contentStoreRefForSha256(
        object.storeId,
        entry.kind === "file" ? VIBE_BLOB_CODEC : VIBE_TREE_CODEC,
        entry.kind === "file" ? entry.contentHash : treeHashDigest(entry.childHash)
      ),
    }));
  }

  if (sameCodec(object.codec, VIBE_STATE_CODEC)) {
    const root = decodeStateNode(decodeCanonicalUtf8(bytes, "Vibe state node"));
    return [
      {
        role: "rootTree",
        target: contentStoreRefForSha256(
          object.storeId,
          VIBE_TREE_CODEC,
          treeHashDigest(root)
        ),
      },
    ];
  }

  throw new Error(`Unknown Vibestudio content codec ${object.codec.number}:${object.codec.version}`);
}
