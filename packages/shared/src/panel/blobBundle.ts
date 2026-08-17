/**
 * blobBundle — a length-framed stream of content-addressed blobs.
 *
 * A cold panel load costs one RPC round trip per subresource. Measured on a
 * device: ~92 requests for ~1.4 MB, ~6 ms of server work each and ~560 ms
 * observed each, so essentially the whole cost is the number of trips rather
 * than anything either end does. Shipping the missing blobs together turns that
 * into one transfer — but nothing in the codebase framed multiple payloads in
 * one stream (the native bundle path moves a single artifact via ranged gzip),
 * so this is that framing and nothing more.
 *
 * Wire shape, repeated until the stream ends:
 *
 * ```
 * [digest: 64 bytes ASCII hex][byteLength: u32 BE][payload: byteLength bytes]
 * ```
 *
 * Deliberately minimal:
 *
 *  - **No index header.** A reader can act on each blob as it arrives instead of
 *    waiting for the whole transfer, which matters when the transfer is several
 *    MB over a phone link. It also means the sender never has to know the total
 *    up front and can stream straight from disk.
 *  - **No compression here.** The pipe already negotiates gzip per response, and
 *    panel artifacts are already-compressed derivatives in the common case;
 *    compressing again would cost CPU on both ends for nothing.
 *  - **Fixed-width digest.** SHA-256 hex is always 64 chars, so a record header
 *    is a constant 68 bytes and needs no varint decoding. The digest is the
 *    identity the receiver stores under, so it must be on the wire rather than
 *    implied by order — a truncated transfer must never be able to mis-attribute
 *    a payload to the wrong digest.
 *
 * VERIFICATION IS THE RECEIVER'S JOB, and it is not free by accident. The mobile
 * store hashes what it was given and names the blob after that — it never
 * compares against a claimed digest, so nothing here or there rejects a
 * mislabeled payload on its own. Hashing again in Hermes would cost more CPU
 * than the transfer saves (and starving that thread is what breaks keepalives),
 * so the receiver should instead compare the digest the native commit returns
 * against the digest this record claimed, and discard on mismatch.
 */

/** `[digest: 64][byteLength: u32]` */
export const BLOB_RECORD_HEADER_BYTES = 68;
const DIGEST_HEX_BYTES = 64;

/** A blob is refused rather than truncated: a payload we cannot frame is a bug. */
export class BlobBundleError extends Error {
  readonly code = "BLOB_BUNDLE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "BlobBundleError";
  }
}

const HEX = /^[0-9a-f]{64}$/u;

/** Encode one record. `digest` is lowercase SHA-256 hex, without any prefix. */
export function encodeBlobRecord(digest: string, payload: Uint8Array): Uint8Array {
  if (!HEX.test(digest)) {
    throw new BlobBundleError(`blob digest must be 64 lowercase hex chars (got ${digest.length})`);
  }
  const record = new Uint8Array(BLOB_RECORD_HEADER_BYTES + payload.byteLength);
  for (let index = 0; index < DIGEST_HEX_BYTES; index++) {
    record[index] = digest.charCodeAt(index);
  }
  new DataView(record.buffer).setUint32(DIGEST_HEX_BYTES, payload.byteLength);
  record.set(payload, BLOB_RECORD_HEADER_BYTES);
  return record;
}

export interface DecodedBlob {
  digest: string;
  bytes: Uint8Array;
}

export interface BlobBundleReader {
  /**
   * Feed received bytes; returns every blob completed by this chunk. Bytes that
   * complete no record are retained until the rest arrives.
   */
  push(chunk: Uint8Array): DecodedBlob[];
  /**
   * Assert the stream ended on a record boundary. A trailing partial record
   * means the transfer was cut short, and the caller must not treat what it
   * already committed as a complete answer to its request.
   */
  end(): void;
  /** Bytes held awaiting the rest of their record — for diagnostics. */
  pendingBytes(): number;
}

/**
 * Incremental reader over a blob-bundle stream.
 *
 * Buffers only the current partial record, so peak memory is one blob rather
 * than the whole transfer — the reason this is a reader and not a `decodeAll`.
 */
export function createBlobBundleReader(options?: {
  /** Refuse a record claiming more than this many bytes (default 64 MiB). */
  maxBlobBytes?: number;
}): BlobBundleReader {
  const maxBlobBytes = options?.maxBlobBytes ?? 64 * 1024 * 1024;
  // A growable buffer with a read cursor, rather than re-concatenating the
  // residual on every push. The pipe delivers this stream in 16 KiB messages, so
  // a naive concat would copy the whole pending remainder per message — O(n²)
  // over a multi-megabyte transfer, on the phone's JS thread, which is precisely
  // the resource this feature exists to stop spending.
  let store = new Uint8Array(0);
  let size = 0;
  let readOffset = 0;

  const available = (): number => size - readOffset;

  const append = (chunk: Uint8Array): void => {
    // Reclaim consumed bytes before growing; a long stream of small records
    // would otherwise keep extending a buffer that is mostly already read.
    if (readOffset > 0 && (readOffset >= size || readOffset > store.byteLength / 2)) {
      store.copyWithin(0, readOffset, size);
      size -= readOffset;
      readOffset = 0;
    }
    if (size + chunk.byteLength > store.byteLength) {
      let capacity = Math.max(store.byteLength, 1024);
      while (capacity < size + chunk.byteLength) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(store.subarray(0, size), 0);
      store = grown;
    }
    store.set(chunk, size);
    size += chunk.byteLength;
  };

  return {
    push(chunk) {
      append(chunk);
      const blobs: DecodedBlob[] = [];
      for (;;) {
        if (available() < BLOB_RECORD_HEADER_BYTES) break;
        const view = new DataView(store.buffer, store.byteOffset + readOffset, available());
        const byteLength = view.getUint32(DIGEST_HEX_BYTES);
        if (byteLength > maxBlobBytes) {
          throw new BlobBundleError(
            `blob record claims ${byteLength} bytes, above the ${maxBlobBytes}-byte cap`
          );
        }
        const total = BLOB_RECORD_HEADER_BYTES + byteLength;
        if (available() < total) break;
        let digest = "";
        for (let index = 0; index < DIGEST_HEX_BYTES; index++) {
          digest += String.fromCharCode(store[readOffset + index]!);
        }
        if (!HEX.test(digest)) {
          throw new BlobBundleError(`blob record header is not a sha256 hex digest`);
        }
        blobs.push({
          digest,
          // Copy: the caller may retain these past the next push, and the buffer
          // is compacted and regrown as the stream advances.
          bytes: store.slice(readOffset + BLOB_RECORD_HEADER_BYTES, readOffset + total),
        });
        readOffset += total;
      }
      return blobs;
    },
    end() {
      if (available() !== 0) {
        throw new BlobBundleError(
          `blob bundle ended mid-record with ${available()} trailing byte(s)`
        );
      }
    },
    pendingBytes: () => available(),
  };
}
