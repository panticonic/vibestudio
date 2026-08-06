import { compareUtf16CodeUnits } from "./canonical-order.js";
import { sha256Hex } from "./worktree-hash.js";

export const CANONICAL_SNAPSHOT_DIGEST_PREFIX = "v1-sha256:" as const;
export type CanonicalSnapshotDigest = `${typeof CANONICAL_SNAPSHOT_DIGEST_PREFIX}${string}`;

export interface CanonicalSnapshotEntry {
  path: string;
  /** Normalized Git file mode: 0o100644 or 0o100755. */
  mode: number;
  /** Exact byte length of the content addressed by `contentHash`. */
  size: number;
  /** Lowercase plain SHA-256 content hash. */
  contentHash: string;
}

const MAGIC = new TextEncoder().encode("vibestudio-snapshot\0v1\0sha256\0");
const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`Canonical snapshot integer is outside uint32: ${value}`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Canonical snapshot byte length is invalid: ${value}`);
  }
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(4, value >>> 0, false);
  return bytes;
}

function hexBytes(value: string): Uint8Array {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`Canonical snapshot content hash is not lowercase SHA-256: ${value}`);
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/**
 * Canonical binary encoding used by external repository pins.
 *
 * Encoding:
 * - fixed protocol magic;
 * - uint32 entry count;
 * - entries in UTF-16 code-unit path order;
 * - per entry: uint32 path-byte length, UTF-8 path, uint32 mode,
 *   uint64 content length, and raw 32-byte SHA-256 content hash.
 *
 * Every variable-width field is length framed and numeric fields are
 * big-endian. The digest covers the complete admitted entry set.
 */
export function canonicalSnapshotDigest(
  entries: readonly CanonicalSnapshotEntry[]
): CanonicalSnapshotDigest {
  const sorted = [...entries].sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const seen = new Set<string>();
  const parts: Uint8Array[] = [MAGIC, u32(sorted.length)];
  for (const entry of sorted) {
    if (seen.has(entry.path)) {
      throw new Error(`Canonical snapshot contains duplicate path ${JSON.stringify(entry.path)}`);
    }
    seen.add(entry.path);
    if (entry.path.length === 0) throw new Error("Canonical snapshot path cannot be empty");
    if (entry.mode !== 0o100644 && entry.mode !== 0o100755) {
      throw new Error(`Canonical snapshot mode is not a regular file mode: ${entry.mode}`);
    }
    const pathBytes = encoder.encode(entry.path);
    parts.push(u32(pathBytes.byteLength), pathBytes, u32(entry.mode), u64(entry.size));
    parts.push(hexBytes(entry.contentHash));
  }
  return `${CANONICAL_SNAPSHOT_DIGEST_PREFIX}${sha256Hex(concat(parts))}`;
}

export function isCanonicalSnapshotDigest(value: string): value is CanonicalSnapshotDigest {
  return /^v1-sha256:[0-9a-f]{64}$/.test(value);
}

export function assertCanonicalSnapshotDigest(
  value: string
): asserts value is CanonicalSnapshotDigest {
  if (!isCanonicalSnapshotDigest(value)) {
    throw new Error(
      `Expected canonical snapshot digest v1-sha256:<64 lowercase hex>, got ${value}`
    );
  }
}
