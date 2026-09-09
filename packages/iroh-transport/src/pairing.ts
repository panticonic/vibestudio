import {
  assertIrohReach,
  DEFAULT_IROH_RELAYS,
  IROH_REACH_VERSION,
  MAX_RELAY_URL_BYTES,
  MAX_RELAY_URLS,
  type IrohReach,
} from "./reach.js";

export const CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
export const PAIR_LINK_ORIGIN = "https://vibestudio.app";
export const PAIR_LINK_PATH = "/p";
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

const VERSION_HEADER = IROH_REACH_VERSION << 4;
const VERSION_MASK = 0xf0;
const RELAY_PROFILE_MASK = 0x0f;
const FIXED_BYTES = 1 + 32 + 16;
const DEFAULT_RELAY_PROFILE = 0;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface ConnectPairing extends IrohReach {
  code: string;
}

export type ConnectLink = ({ kind: "ok" } & ConnectPairing) | { kind: "error"; reason: string };

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const value =
      (bytes[offset]! << 16) |
      ((remaining > 1 ? bytes[offset + 1]! : 0) << 8) |
      (remaining > 2 ? bytes[offset + 2]! : 0);
    output += BASE64URL[(value >>> 18) & 63];
    output += BASE64URL[(value >>> 12) & 63];
    if (remaining > 1) output += BASE64URL[(value >>> 6) & 63];
    if (remaining > 2) output += BASE64URL[value & 63];
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) return null;
    accumulator = accumulator * 64 + digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[index++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  return accumulator === 0 && index === output.length ? output : null;
}

function hexBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeConnectPairing(pairing: ConnectPairing): string {
  assertIrohReach(pairing);
  if (!PAIRING_CODE_PATTERN.test(pairing.code)) {
    throw new Error("Pairing code must be canonical 16-byte base64url");
  }
  const code = decodeBase64Url(pairing.code);
  if (!code || code.byteLength !== 16) throw new Error("Pairing code is not canonical base64url");
  const usesDefaultRelays =
    pairing.relays.length === DEFAULT_IROH_RELAYS.length &&
    pairing.relays.every((relay, index) => relay === DEFAULT_IROH_RELAYS[index]);
  const relayBytes = usesDefaultRelays
    ? []
    : pairing.relays.map((relay) => new TextEncoder().encode(relay));
  const total = FIXED_BYTES + relayBytes.reduce((sum, relay) => sum + 2 + relay.byteLength, 0);
  const output = new Uint8Array(total);
  output[0] = VERSION_HEADER | (usesDefaultRelays ? DEFAULT_RELAY_PROFILE : relayBytes.length);
  output.set(hexBytes(pairing.endpointId), 1);
  output.set(code, 33);
  let offset = FIXED_BYTES;
  for (const relay of relayBytes) {
    output[offset] = relay.byteLength >>> 8;
    output[offset + 1] = relay.byteLength & 0xff;
    output.set(relay, offset + 2);
    offset += 2 + relay.byteLength;
  }
  return encodeBase64Url(output);
}

export function decodeConnectPairing(payload: string): ConnectLink {
  const bytes = decodeBase64Url(payload);
  if (!bytes || bytes.byteLength < FIXED_BYTES) {
    return { kind: "error", reason: "Pairing link has malformed compact material" };
  }
  if ((bytes[0]! & VERSION_MASK) !== VERSION_HEADER) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${IROH_REACH_VERSION})`,
    };
  }
  const relayProfile = bytes[0]! & RELAY_PROFILE_MASK;
  if (relayProfile > MAX_RELAY_URLS) {
    return { kind: "error", reason: "Pairing link has an invalid relay count" };
  }
  const relays: string[] = relayProfile === DEFAULT_RELAY_PROFILE ? [...DEFAULT_IROH_RELAYS] : [];
  let offset = FIXED_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let index = 0; index < relayProfile; index += 1) {
      if (offset + 2 > bytes.byteLength) throw new Error("truncated relay length");
      const length = bytes[offset]! * 256 + bytes[offset + 1]!;
      offset += 2;
      if (length < 1 || length > MAX_RELAY_URL_BYTES || offset + length > bytes.byteLength) {
        throw new Error("invalid relay length");
      }
      relays.push(decoder.decode(bytes.slice(offset, offset + length)));
      offset += length;
    }
  } catch {
    return { kind: "error", reason: "Pairing link has malformed relay data" };
  }
  if (offset !== bytes.byteLength) {
    return { kind: "error", reason: "Pairing link contains trailing compact data" };
  }
  const pairing: ConnectPairing = {
    endpointId: bytesHex(bytes.slice(1, 33)),
    code: encodeBase64Url(bytes.slice(33, 49)),
    relays,
    v: IROH_REACH_VERSION,
  };
  try {
    assertIrohReach(pairing);
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "ok", ...pairing };
}

export function createConnectLink(
  pairing: ConnectPairing,
  carrier: "scheme" | "https" = "scheme"
): string {
  const payload = encodeConnectPairing(pairing);
  return carrier === "https"
    ? `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${payload}`
    : `${CONNECT_DEEP_LINK_SCHEME}//connect/${payload}`;
}

export function createConnectDeepLink(pairing: ConnectPairing): string {
  return createConnectLink(pairing, "scheme");
}

export function createConnectPairUrl(pairing: ConnectPairing): string {
  return createConnectLink(pairing, "https");
}

export function parseConnectLink(raw: string): ConnectLink {
  const schemePrefix = `${CONNECT_DEEP_LINK_SCHEME}//connect/`;
  let payload: string;
  if (raw.startsWith(schemePrefix)) {
    payload = raw.slice(schemePrefix.length);
    if (!payload || /[/?#]/u.test(payload)) {
      return { kind: "error", reason: "Deep link has malformed compact pairing material" };
    }
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "error", reason: "Not a Vibestudio connect link" };
    }
    if (
      url.origin !== PAIR_LINK_ORIGIN ||
      url.pathname !== PAIR_LINK_PATH ||
      url.search ||
      !url.hash
    ) {
      return { kind: "error", reason: "Not a Vibestudio pair URL" };
    }
    payload = url.hash.slice(1);
  }
  return decodeConnectPairing(payload);
}
