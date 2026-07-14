/**
 * Portable, transport-neutral shape of the reducer content-store protocol.
 *
 * This surface is deliberately limited to operations on caller-supplied exact
 * references. Workspace discovery, prefix scans, search, materialization, and
 * mutable refs belong to Vibestudio's separately authorized application APIs.
 */

export const SHA2_256_HASH_ALGORITHM = 0x12;

export interface ContentStoreCodecId {
  number: number;
  version: number;
}

export interface ContentStoreContentId {
  algorithm: number;
  digest: Uint8Array;
}

export interface ContentStoreObjectRef {
  storeId: Uint8Array;
  codec: ContentStoreCodecId;
  contentId: ContentStoreContentId;
}

export interface ContentStorePutRequest {
  object: ContentStoreObjectRef;
  bytes: Uint8Array;
}

export interface ContentStorePutResult {
  object: ContentStoreObjectRef;
  status: "inserted" | "alreadyPresent";
}

export interface ContentStoreGetResult {
  object: ContentStoreObjectRef;
  bytes: Uint8Array | null;
}

export interface ContentStoreSealResult {
  root: ContentStoreObjectRef;
  missingRequiredDescendants: ContentStoreObjectRef[];
  visitedObjectCount: number;
}

export interface ExactContentStore {
  has(objects: readonly ContentStoreObjectRef[]): Promise<boolean[]>;
  get(objects: readonly ContentStoreObjectRef[]): Promise<ContentStoreGetResult[]>;
  put(requests: readonly ContentStorePutRequest[]): Promise<ContentStorePutResult[]>;
  seal(root: ContentStoreObjectRef): Promise<ContentStoreSealResult>;
}

export interface ContentStoreRequiredEdge {
  role: string;
  target: ContentStoreObjectRef;
}

export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(hex)) {
    throw new Error("Invalid lowercase hexadecimal bytes");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function cloneObjectRef(object: ContentStoreObjectRef): ContentStoreObjectRef {
  return {
    storeId: object.storeId.slice(),
    codec: { ...object.codec },
    contentId: {
      algorithm: object.contentId.algorithm,
      digest: object.contentId.digest.slice(),
    },
  };
}

export function sameObjectRef(
  left: ContentStoreObjectRef,
  right: ContentStoreObjectRef
): boolean {
  return (
    bytesToHex(left.storeId) === bytesToHex(right.storeId) &&
    left.codec.number === right.codec.number &&
    left.codec.version === right.codec.version &&
    left.contentId.algorithm === right.contentId.algorithm &&
    bytesToHex(left.contentId.digest) === bytesToHex(right.contentId.digest)
  );
}

export function objectRefKey(object: ContentStoreObjectRef): string {
  return [
    bytesToHex(object.storeId),
    `${object.codec.number}:${object.codec.version}`,
    `${object.contentId.algorithm}:${bytesToHex(object.contentId.digest)}`,
  ].join("/");
}
