/**
 * RPC wire JSON codec — the one place binary values cross a JSON transport.
 *
 * RPC arguments and results may contain `Uint8Array` (including Node `Buffer`)
 * or `ArrayBuffer` values anywhere in their structure. Every transport that
 * serializes envelopes as JSON (HTTP, WebSocket, Iroh, process channels,
 * workerd dispatch) encodes with {@link encodeRpcJson} and decodes with
 * {@link decodeRpcJson}, so services and callers see real bytes on both sides
 * and validate them as bytes. Structured-clone transports (in-process, Electron
 * IPC, `postMessage`) carry bytes natively and need no codec.
 *
 * Encoding: a byte value becomes `{ "\u0000bytes": "<base64>" }`. The tag key
 * begins with NUL, and every user object key that begins with NUL is escaped by
 * prefixing one more NUL (and unescaped on decode), so no user value can ever be
 * reinterpreted as bytes, and every user value round-trips exactly. A decoded
 * byte value is always a `Uint8Array`.
 *
 * Large byte payloads belong on the streaming frames (`protocol/streamCodec`),
 * not inline in an envelope.
 */

import { base64ToBytes, bytesToBase64 } from "./base64.js";

const TAG = "\u0000";
const BYTES_TAG = `${TAG}bytes`;

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function typedArrayName(value: ArrayBufferView): string | null {
  const getter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag
  )?.get;
  try {
    return getter?.call(value) ?? null;
  } catch {
    return null;
  }
}

function isArrayBuffer(value: object): value is ArrayBuffer {
  const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
  try {
    return typeof getter?.call(value) === "number";
  } catch {
    return false;
  }
}

/**
 * The bytes a value carries over RPC: a `Uint8Array` from any realm (including
 * Node `Buffer`) as itself, an `ArrayBuffer` as a view of it, anything else
 * `null`. Detection reads internal slots, so `Symbol.toStringTag` cannot forge it.
 */
export function rpcBytesOf(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== "object") return null;
  if (ArrayBuffer.isView(value)) {
    return typedArrayName(value) === "Uint8Array" ? (value as Uint8Array) : null;
  }
  return isArrayBuffer(value) ? new Uint8Array(value) : null;
}

function escapeObjectKeys(value: Record<string, unknown>): Record<string, unknown> {
  let needsEscape = false;
  for (const key of Object.keys(value)) {
    if (key.startsWith(TAG)) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape) return value;
  const escaped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    defineEntry(escaped, key.startsWith(TAG) ? `${TAG}${key}` : key, entry);
  }
  return escaped;
}

function defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Serialize an RPC wire value (an envelope or transport message) to JSON text. */
export function encodeRpcJson(value: unknown): string {
  const encoded = JSON.stringify(
    value,
    function (this: Record<string, unknown>, key: string, encoded: unknown): unknown {
      // `this[key]` is the value before `toJSON` (Node Buffers define one).
      const raw = this[key];
      if (raw === null || typeof raw !== "object") return encoded;
      const bytes = rpcBytesOf(raw);
      if (bytes) return { [BYTES_TAG]: bytesToBase64(bytes) };
      if (ArrayBuffer.isView(raw)) {
        throw new TypeError(
          `RPC values carry bytes as Uint8Array or ArrayBuffer; ${typedArrayName(raw) ?? tagOf(raw).slice(8, -1)} is not supported`
        );
      }
      if (encoded !== null && typeof encoded === "object" && !Array.isArray(encoded)) {
        return escapeObjectKeys(encoded as Record<string, unknown>);
      }
      return encoded;
    }
  );
  if (encoded === undefined) {
    throw new TypeError("RPC wire value is not JSON serializable");
  }
  return encoded;
}

function decodeObject(value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  let tagged = false;
  for (const key of keys) {
    if (key.startsWith(TAG)) {
      tagged = true;
      break;
    }
  }
  if (!tagged) return value;
  if (keys.length === 1 && keys[0] === BYTES_TAG) {
    const data = value[BYTES_TAG];
    if (typeof data !== "string") throw new TypeError("Malformed RPC byte value");
    const bytes = base64ToBytes(data);
    if (bytesToBase64(bytes) !== data) throw new TypeError("Malformed RPC byte value");
    return bytes;
  }
  const decoded: Record<string, unknown> = {};
  for (const key of keys) {
    if (!key.startsWith(TAG)) {
      defineEntry(decoded, key, value[key]);
    } else if (key.startsWith(`${TAG}${TAG}`)) {
      defineEntry(decoded, key.slice(1), value[key]);
    } else {
      throw new TypeError(
        `Malformed RPC wire value: unescaped reserved key ${JSON.stringify(key)}`
      );
    }
  }
  return decoded;
}

/** Parse JSON text produced by {@link encodeRpcJson}, restoring byte values. */
export function decodeRpcJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? decodeObject(value as Record<string, unknown>)
      : value
  );
}
