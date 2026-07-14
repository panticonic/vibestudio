import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import {
  bytesToHex,
  cloneObjectRef,
  objectRefKey,
  SHA2_256_HASH_ALGORITHM,
  type ContentStoreCodecId,
  type ContentStoreGetResult,
  type ContentStoreObjectRef,
  type ContentStorePutRequest,
  type ContentStorePutResult,
  type ContentStoreSealResult,
  type ExactContentStore,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  contentStoreRefForSha256,
  inspectVibeContentObject,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { blobCasPath, ensureBlobCasLayout, putBlobBytesWithStatus } from "./blobCas.js";

export interface VibeExactContentStoreOptions {
  rootDir: string;
  storeId: Uint8Array;
  maxSealObjects?: number;
}

/**
 * Exact-reference reducer adapter over Vibe's existing SHA-256 file CAS.
 *
 * It intentionally does not expose the workspace facade's list, prefix,
 * grep, materialization, deletion, or ref operations. Supplying the central
 * CAS root gives reducers exact access independent of workspace membership;
 * authorization and store routing remain responsibilities of the caller.
 */
export class VibeExactContentStore implements ExactContentStore {
  readonly #rootDir: string;
  readonly #storeId: Uint8Array;
  readonly #maxSealObjects: number;

  constructor(options: VibeExactContentStoreOptions) {
    if (options.storeId.byteLength === 0) throw new Error("Content store ID must not be empty");
    if (options.maxSealObjects !== undefined && options.maxSealObjects <= 0) {
      throw new Error("maxSealObjects must be positive");
    }
    this.#rootDir = options.rootDir;
    this.#storeId = options.storeId.slice();
    this.#maxSealObjects = options.maxSealObjects ?? 100_000;
    ensureBlobCasLayout(this.#rootDir);
  }

  identify(codec: ContentStoreCodecId, bytes: Uint8Array): ContentStoreObjectRef {
    const digest = createHash("sha256").update(bytes).digest("hex");
    return contentStoreRefForSha256(this.#storeId, codec, digest);
  }

  async has(objects: readonly ContentStoreObjectRef[]): Promise<boolean[]> {
    return Promise.all(objects.map(async (object) => (await this.#readValidated(object)) !== null));
  }

  async get(objects: readonly ContentStoreObjectRef[]): Promise<ContentStoreGetResult[]> {
    return Promise.all(
      objects.map(async (object) => ({
        object: cloneObjectRef(object),
        bytes: await this.#readValidated(object),
      }))
    );
  }

  async put(requests: readonly ContentStorePutRequest[]): Promise<ContentStorePutResult[]> {
    const results: ContentStorePutResult[] = [];
    for (const request of requests) {
      this.#requireLocalSha256Ref(request.object);
      const bytes = Buffer.from(request.bytes);
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      const expectedDigest = bytesToHex(request.object.contentId.digest);
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `Content hash mismatch: expected ${expectedDigest}, received ${actualDigest}`
        );
      }
      inspectVibeContentObject(request.object, bytes);
      const stored = await putBlobBytesWithStatus(this.#rootDir, bytes);
      if (stored.digest !== expectedDigest) throw new Error("Blob CAS returned a different digest");

      // The primitive's existing-object fast path is intentionally cheap.
      // Validate the durable bytes here so a corrupted file cannot satisfy an
      // exact put merely because its digest-shaped path already exists.
      await this.#requireValidated(request.object);
      results.push({
        object: cloneObjectRef(request.object),
        status: stored.insertedContent ? "inserted" : "alreadyPresent",
      });
    }
    return results;
  }

  async seal(root: ContentStoreObjectRef): Promise<ContentStoreSealResult> {
    this.#requireLocalSha256Ref(root);
    const pending = [cloneObjectRef(root)];
    const visited = new Set<string>();
    const missing: ContentStoreObjectRef[] = [];

    while (pending.length > 0) {
      const object = pending.pop();
      if (!object) throw new Error("Content traversal queue invariant violated");
      const key = objectRefKey(object);
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > this.#maxSealObjects) {
        throw new Error(`Content closure exceeds ${this.#maxSealObjects} objects`);
      }

      const bytes = await this.#readValidated(object);
      if (bytes === null) {
        missing.push(cloneObjectRef(object));
        continue;
      }
      for (const edge of inspectVibeContentObject(object, bytes)) {
        pending.push(cloneObjectRef(edge.target));
      }
    }

    return {
      root: cloneObjectRef(root),
      missingRequiredDescendants: missing,
      visitedObjectCount: visited.size,
    };
  }

  async #requireValidated(object: ContentStoreObjectRef): Promise<Uint8Array> {
    const bytes = await this.#readValidated(object);
    if (bytes === null) throw new Error("Content disappeared while it was being stored");
    return bytes;
  }

  async #readValidated(object: ContentStoreObjectRef): Promise<Uint8Array | null> {
    this.#requireLocalSha256Ref(object);
    const expectedDigest = bytesToHex(object.contentId.digest);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(blobCasPath(this.#rootDir, expectedDigest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Corrupt content object: expected ${expectedDigest}, received ${actualDigest}`
      );
    }
    inspectVibeContentObject(object, bytes);
    return Uint8Array.from(bytes);
  }

  #requireLocalSha256Ref(object: ContentStoreObjectRef): void {
    if (!(object.storeId instanceof Uint8Array) || object.storeId.byteLength === 0) {
      throw new Error("Malformed content store ID");
    }
    if (
      !Number.isInteger(object.codec.number) ||
      object.codec.number <= 0 ||
      object.codec.number > 0xffffffff ||
      !Number.isInteger(object.codec.version) ||
      object.codec.version <= 0 ||
      object.codec.version > 0xffff
    ) {
      throw new Error("Malformed content codec ID");
    }
    if (bytesToHex(object.storeId) !== bytesToHex(this.#storeId)) {
      throw new Error("Content object belongs to a different store");
    }
    if (object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM) {
      throw new Error("Vibestudio host content store supports only SHA2-256");
    }
    if (
      !(object.contentId.digest instanceof Uint8Array) ||
      object.contentId.digest.byteLength !== 32
    ) {
      throw new Error("SHA2-256 content digest must contain 32 bytes");
    }
  }
}
