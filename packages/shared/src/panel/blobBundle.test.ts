import { describe, expect, it } from "vitest";
import {
  BLOB_RECORD_HEADER_BYTES,
  BlobBundleError,
  createBlobBundleReader,
  encodeBlobRecord,
} from "./blobBundle.js";

const digest = (fill: string): string => fill.repeat(64).slice(0, 64);
const A = digest("a");
const B = digest("b");
const C = digest("0123456789abcdef");
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

describe("blob bundle", () => {
  it("round-trips several blobs in one stream", () => {
    const reader = createBlobBundleReader();
    const blobs = reader.push(
      concat(
        encodeBlobRecord(A, bytes(1, 2, 3)),
        encodeBlobRecord(B, new Uint8Array(0)),
        encodeBlobRecord(C, bytes(9))
      )
    );
    reader.end();
    expect(blobs.map((blob) => blob.digest)).toEqual([A, B, C]);
    expect([...blobs[0]!.bytes]).toEqual([1, 2, 3]);
    expect(blobs[1]!.bytes.byteLength).toBe(0);
    expect([...blobs[2]!.bytes]).toEqual([9]);
  });

  it("yields each blob as soon as it completes, not at the end", () => {
    // The point of streaming: a reader must be able to commit blob 1 while blob
    // 2 is still arriving, so a multi-MB transfer does not sit in memory.
    const reader = createBlobBundleReader();
    const first = encodeBlobRecord(A, bytes(1, 2, 3, 4));
    expect(reader.push(first)).toHaveLength(1);
    expect(reader.push(encodeBlobRecord(B, bytes(5)))).toHaveLength(1);
    reader.end();
  });

  it("reassembles records split across arbitrary chunk boundaries", () => {
    const stream = concat(encodeBlobRecord(A, bytes(1, 2, 3, 4, 5)), encodeBlobRecord(B, bytes(6)));
    for (const size of [1, 7, 33, 68, 69, 100]) {
      const reader = createBlobBundleReader();
      const seen: string[] = [];
      for (let offset = 0; offset < stream.byteLength; offset += size) {
        for (const blob of reader.push(stream.subarray(offset, offset + size))) {
          seen.push(blob.digest);
        }
      }
      reader.end();
      expect(seen).toEqual([A, B]);
    }
  });

  it("holds a partial record instead of emitting it", () => {
    const reader = createBlobBundleReader();
    const record = encodeBlobRecord(A, bytes(1, 2, 3, 4));
    expect(reader.push(record.subarray(0, record.byteLength - 1))).toEqual([]);
    expect(reader.pendingBytes()).toBe(record.byteLength - 1);
    expect(reader.push(record.subarray(record.byteLength - 1))).toHaveLength(1);
    reader.end();
  });

  it("fails loud when the stream is cut short", () => {
    // A truncated transfer must not look like a complete answer — the caller
    // would otherwise treat missing assets as "the server does not have them".
    const reader = createBlobBundleReader();
    const record = encodeBlobRecord(A, bytes(1, 2, 3, 4));
    reader.push(record.subarray(0, 40));
    expect(() => reader.end()).toThrow(/ended mid-record/);
  });

  it("keeps payloads valid after later pushes", () => {
    // The buffer is reallocated as the stream advances, so an emitted blob must
    // own its bytes rather than view into it.
    const reader = createBlobBundleReader();
    const [first] = reader.push(encodeBlobRecord(A, bytes(7, 7, 7)));
    reader.push(encodeBlobRecord(B, new Uint8Array(1000).fill(3)));
    reader.end();
    expect([...first!.bytes]).toEqual([7, 7, 7]);
  });

  it("refuses a record claiming more than the cap", () => {
    const reader = createBlobBundleReader({ maxBlobBytes: 16 });
    const oversized = encodeBlobRecord(A, new Uint8Array(32));
    expect(() => reader.push(oversized)).toThrow(BlobBundleError);
  });

  it("refuses a header that is not a sha256 digest", () => {
    const reader = createBlobBundleReader();
    const record = encodeBlobRecord(A, bytes(1));
    record[0] = "Z".charCodeAt(0);
    expect(() => reader.push(record)).toThrow(/not a sha256 hex digest/);
  });

  it("refuses to encode a malformed digest", () => {
    expect(() => encodeBlobRecord("abc", bytes(1))).toThrow(BlobBundleError);
    expect(() => encodeBlobRecord(A.toUpperCase(), bytes(1))).toThrow(BlobBundleError);
  });

  it("frames a record with a constant-size header", () => {
    expect(encodeBlobRecord(A, bytes(1, 2, 3)).byteLength).toBe(BLOB_RECORD_HEADER_BYTES + 3);
  });

  it("carries the payload's own digest beside the artifact's", () => {
    // What makes a compressed transfer verifiable: the receiver stores the blob
    // under `digest` but can only check the bytes it actually received.
    const reader = createBlobBundleReader();
    const [blob] = reader.push(encodeBlobRecord(A, bytes(1, 2, 3), B));
    reader.end();
    expect(blob).toMatchObject({ digest: A, payloadDigest: B });
  });

  it("reports an identity record by making both digests equal", () => {
    // This equality IS the signal that a record was not compressed — a gzip
    // payload cannot hash to the digest of the bytes it encodes — so a bundle
    // can mix the two without any per-record encoding field.
    const reader = createBlobBundleReader();
    const [blob] = reader.push(encodeBlobRecord(A, bytes(1, 2, 3)));
    reader.end();
    expect(blob!.payloadDigest).toBe(blob!.digest);
  });

  it("refuses a record whose payload digest is malformed", () => {
    expect(() => encodeBlobRecord(A, bytes(1), "nope")).toThrow(BlobBundleError);
    const reader = createBlobBundleReader();
    const record = encodeBlobRecord(A, bytes(1), B);
    record[70] = "Z".charCodeAt(0);
    expect(() => reader.push(record)).toThrow(/not a sha256 hex digest/);
  });

  it("stays linear when the stream arrives in many small chunks", () => {
    // The pipe delivers 16 KiB messages, so a reader that re-concatenates its
    // residual per push is O(n^2) across a multi-MB transfer — on the phone's JS
    // thread, which is the resource this whole feature exists to stop spending.
    const blobCount = 40;
    const payload = new Uint8Array(4096).fill(7);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < blobCount; i++) {
      parts.push(encodeBlobRecord(digest(String(i % 10)), payload));
    }
    const stream = concat(...parts);

    const reader = createBlobBundleReader();
    let seen = 0;
    const started = Date.now();
    for (let offset = 0; offset < stream.byteLength; offset += 512) {
      seen += reader.push(stream.subarray(offset, offset + 512)).length;
    }
    reader.end();
    expect(seen).toBe(blobCount);
    // Generous: this is a shape check, not a benchmark. Quadratic behaviour on
    // ~160 KiB in 512-byte pushes blows well past this.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
