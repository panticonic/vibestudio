import { sha256Hex } from "@vibestudio/content-addressing";

export const CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIR_LINK_ORIGIN = "https://vibestudio.app";
export const PAIR_LINK_PATH = "/p";
export const DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";
/** Current pairing issuer output: exactly 24 random bytes encoded as base64url. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const WORKSPACE_ROUTE_PREFIX = "/_workspace/";
/** Signaling rendezvous room id (UUID or base64url token). */
export const PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** DTLS SHA-256 fingerprint after stripping colons: 32 bytes = 64 hex chars. */
const FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
/**
 * Current room-per-invite pairing protocol. Parsers require this exact version.
 */
export const PAIRING_PROTOCOL_VERSION = 3;

const COMPACT_HEADER_VERSION_SHIFT = 4;
const COMPACT_FLAG_RELAY = 1 << 0;
const COMPACT_FLAG_CUSTOM_SIGNALING = 1 << 1;
const COMPACT_KNOWN_FLAGS = COMPACT_FLAG_RELAY | COMPACT_FLAG_CUSTOM_SIGNALING;
const COMPACT_FIXED_BYTES = 1 + 32 + 24 + 6;
const MAX_CUSTOM_SIGNALING_BYTES = 2_048;
const PAIRING_ROOM_DOMAIN = new TextEncoder().encode("vibestudio-pairing-room-v3\0");

export type TurnPolicy = "all" | "relay";
export type ConnectLinkCarrier = "scheme" | "https";
export type SignalingResolutionSource = "flag" | "env" | "default";

/**
 * The exact WebRTC pairing payload carried in the QR / deep link. The shell
 * joins a signaling room and pins the server's DTLS fingerprint.
 */
export interface ReconnectReach {
  /** Unguessable signaling rendezvous room id. */
  room: string;
  /** Pinned server DTLS SHA-256 fingerprint (the QR `fp`). */
  fp: string;
  /** Signaling endpoint (decouples us from a hard-coded host). */
  sig: string;
  /** Exact current protocol version. */
  v: typeof PAIRING_PROTOCOL_VERSION;
  /** TURN policy — `relay` forces TURN-over-TLS:443 validation. */
  ice: TurnPolicy;
}

export interface ConnectPairing extends ReconnectReach {
  /** Pairing secret proving QR possession. */
  code: string;
  /** Invite expiry in epoch milliseconds; stale one-time links are rejected locally. */
  exp: number;
}

export type ConnectLink = ({ kind: "ok" } & ConnectPairing) | { kind: "error"; reason: string };
export type SignalingResolution = { url: string; source: SignalingResolutionSource };
/** Strip colons/whitespace and upper-case a DTLS fingerprint for comparison. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const value =
      (bytes[offset]! << 16) |
      ((remaining > 1 ? bytes[offset + 1]! : 0) << 8) |
      (remaining > 2 ? bytes[offset + 2]! : 0);
    output += BASE64URL_ALPHABET[(value >>> 18) & 63];
    output += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (remaining > 1) output += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (remaining > 2) output += BASE64URL_ALPHABET[value & 63];
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let outputOffset = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = accumulator * 64 + digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputOffset++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0 || outputOffset !== output.length) return null;
  return output;
}

function bytesFromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hexFromBytes(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output.toUpperCase();
}

/**
 * The signaling rendezvous is a one-way, domain-separated projection of the
 * invite secret. It therefore need not consume bytes in the user-facing link,
 * while the blind signaling service still never learns the redeemable secret.
 */
export function derivePairingRoom(code: string): string {
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error("Cannot derive pairing room: code has an unexpected format");
  }
  const codeBytes = decodeBase64Url(code);
  if (!codeBytes || codeBytes.length !== 24) {
    throw new Error("Cannot derive pairing room: code is not canonical base64url");
  }
  return sha256Hex(concatBytes(PAIRING_ROOM_DOMAIN, codeBytes));
}

function encodeCompactPairing(pairing: ConnectPairing): string {
  const signaling = parseSignalingEndpoint(pairing.sig);
  const fingerprint = normalizeFingerprint(pairing.fp);
  if (!FINGERPRINT_HEX_PATTERN.test(fingerprint)) {
    throw new Error("Cannot create pairing link: fingerprint must be SHA-256");
  }
  if (!PAIRING_CODE_PATTERN.test(pairing.code)) {
    throw new Error("Cannot create pairing link: code has an unexpected format");
  }
  if (pairing.room !== derivePairingRoom(pairing.code)) {
    throw new Error("Cannot create pairing link: room does not match the pairing code");
  }
  if (signaling.kind === "error") {
    throw new Error(`Cannot create pairing link: ${signaling.reason}`);
  }
  if (pairing.v !== PAIRING_PROTOCOL_VERSION) {
    throw new Error(`Cannot create pairing link: expected v=${PAIRING_PROTOCOL_VERSION}`);
  }
  if (pairing.ice !== "all" && pairing.ice !== "relay") {
    throw new Error("Cannot create pairing link: ice must be `all` or `relay`");
  }
  if (!Number.isSafeInteger(pairing.exp) || pairing.exp <= 0 || pairing.exp > 0xffffffffffff) {
    throw new Error("Cannot create pairing link: expiry has an unexpected format");
  }

  const customSignaling =
    signaling.url === DEFAULT_SIGNAL_URL
      ? new Uint8Array()
      : new TextEncoder().encode(signaling.url);
  if (customSignaling.length > MAX_CUSTOM_SIGNALING_BYTES) {
    throw new Error("Cannot create pairing link: signaling endpoint is too long");
  }
  const bytes = new Uint8Array(COMPACT_FIXED_BYTES + customSignaling.length);
  const flags =
    (pairing.ice === "relay" ? COMPACT_FLAG_RELAY : 0) |
    (customSignaling.length > 0 ? COMPACT_FLAG_CUSTOM_SIGNALING : 0);
  bytes[0] = (PAIRING_PROTOCOL_VERSION << COMPACT_HEADER_VERSION_SHIFT) | flags;
  bytes.set(bytesFromHex(fingerprint), 1);
  const codeBytes = decodeBase64Url(pairing.code);
  if (!codeBytes || codeBytes.length !== 24) {
    throw new Error("Cannot create pairing link: code is not canonical base64url");
  }
  bytes.set(codeBytes, 33);
  let expiry = pairing.exp;
  for (let index = 62; index >= 57; index -= 1) {
    bytes[index] = expiry % 256;
    expiry = Math.floor(expiry / 256);
  }
  bytes.set(customSignaling, COMPACT_FIXED_BYTES);
  return encodeBase64Url(bytes);
}

export function createConnectLink(
  pairing: ConnectPairing,
  carrier: ConnectLinkCarrier = "scheme"
): string {
  const payload = encodeCompactPairing(pairing);
  if (carrier === "https") {
    return `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${payload}`;
  }
  return `vibestudio://connect/${payload}`;
}

/**
 * The pairing carried by a parsed link, without the parse result's own tag.
 *
 * Callers used to retype the field list to strip `kind`, and every one of them
 * silently dropped `exp` when pairing links gained an expiry — which made the
 * pairing fail validation on the device after the server had already issued a
 * credential. Deriving the projection from the parse result means a field added
 * to the grammar cannot be missed here again.
 */
export function connectPairingFromLink(link: { kind: "ok" } & ConnectPairing): ConnectPairing {
  const { kind: _kind, ...pairing } = link;
  return pairing;
}

export function createConnectDeepLink(pairing: ConnectPairing): string {
  return createConnectLink(pairing, "scheme");
}

export function createConnectPairUrl(pairing: ConnectPairing): string {
  return createConnectLink(pairing, "https");
}

export function appendServerPath(baseUrl: string | URL, suffix: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = suffix.replace(/^\/+/, "");
  url.pathname = nextPath ? `${basePath}/${nextPath}` : basePath || "/";
  url.search = "";
  url.hash = "";
  return url;
}

// These take a BASE server URL (an origin, or a /_workspace/<name> selected-workspace URL) and
// append the canonical RPC path — the same contract as serverAuthRouteUrl.
// Never pass an already-suffixed URL; there is deliberately no idempotency, so a workspace literally
// named "rpc" (URL .../_workspace/rpc) is handled correctly instead of colliding with the suffix.
export function serverRpcHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc");
}

export function serverRpcStreamHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc/stream");
}

export function serverRpcWsUrl(baseUrl: string | URL): string {
  const url = serverRpcHttpUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function serverCdpHostWsUrl(baseUrl: string | URL, hostConnectionId: string): string {
  const url = appendServerPath(baseUrl, "/api/cdp-host");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostConnectionId", hostConnectionId);
  return url.toString();
}

export function serverAuthRouteUrl(baseUrl: string | URL, route: string): URL {
  return appendServerPath(baseUrl, `/_r/s/auth/${route.replace(/^\/+/, "")}`);
}

export function selectedWorkspacePath(workspaceName: string): string {
  return `${WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(workspaceName)}`;
}

export function selectedWorkspaceUrl(baseUrl: string | URL, workspaceName: string): URL {
  return appendServerPath(baseUrl, selectedWorkspacePath(workspaceName));
}

export function selectedWorkspaceNameFromUrl(rawUrl: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.toString());
  } catch {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const match = pathname.match(/^\/_workspace\/([^/]+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isSelectedWorkspaceUrl(rawUrl: string | URL): boolean {
  return selectedWorkspaceNameFromUrl(rawUrl) !== null;
}

export function parseConnectLink(raw: string): ConnectLink {
  if (typeof raw !== "string") {
    return { kind: "error", reason: "Deep link must be a string" };
  }

  const prefix = `${CONNECT_DEEP_LINK_SCHEME}//${CONNECT_DEEP_LINK_HOST}`;
  const httpsPrefix = `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}`;
  if (raw.startsWith(`${prefix}?`) || raw.startsWith(`${PAIR_LINK_ORIGIN}/pair`)) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); generate a fresh link from an updated server`,
    };
  }
  let compactPayload: string;
  if (raw.startsWith(`${prefix}/`)) {
    compactPayload = raw.slice(prefix.length + 1);
    if (
      !compactPayload ||
      compactPayload.includes("/") ||
      compactPayload.includes("?") ||
      compactPayload.includes("#")
    ) {
      return { kind: "error", reason: "Deep link has malformed compact pairing material" };
    }
  } else if (raw.startsWith(httpsPrefix)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "error", reason: "Pair URL is not a valid URL" };
    }
    if (url.origin !== PAIR_LINK_ORIGIN || url.pathname !== PAIR_LINK_PATH) {
      return { kind: "error", reason: "Not a Vibestudio pair URL" };
    }
    if (url.search) {
      return { kind: "error", reason: "Pair URL has unsupported query parameters" };
    }
    if (!url.hash || url.hash === "#") {
      return { kind: "error", reason: "Pair URL is missing pairing parameters" };
    }
    compactPayload = url.hash.slice(1);
  } else {
    return { kind: "error", reason: "Not a vibestudio://connect link or Vibestudio pair URL" };
  }

  const bytes = decodeBase64Url(compactPayload);
  if (
    !bytes ||
    bytes.length < COMPACT_FIXED_BYTES ||
    bytes.length > COMPACT_FIXED_BYTES + MAX_CUSTOM_SIGNALING_BYTES
  ) {
    return { kind: "error", reason: "Pairing link has malformed compact pairing material" };
  }
  const header = bytes[0]!;
  const version = header >>> COMPACT_HEADER_VERSION_SHIFT;
  const flags = header & ((1 << COMPACT_HEADER_VERSION_SHIFT) - 1);
  if (version !== PAIRING_PROTOCOL_VERSION) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); generate a fresh link from an updated server`,
    };
  }
  if ((flags & ~COMPACT_KNOWN_FLAGS) !== 0) {
    return { kind: "error", reason: "Pairing link uses unsupported compact flags" };
  }

  const hasCustomSignaling = (flags & COMPACT_FLAG_CUSTOM_SIGNALING) !== 0;
  if (!hasCustomSignaling && bytes.length !== COMPACT_FIXED_BYTES) {
    return { kind: "error", reason: "Pairing link contains trailing compact data" };
  }
  if (hasCustomSignaling && bytes.length === COMPACT_FIXED_BYTES) {
    return { kind: "error", reason: "Pairing link is missing its custom signaling endpoint" };
  }

  const fp = hexFromBytes(bytes.slice(1, 33));
  const code = encodeBase64Url(bytes.slice(33, 57));
  let exp = 0;
  for (let index = 57; index < 63; index += 1) exp = exp * 256 + bytes[index]!;
  if (!Number.isSafeInteger(exp) || exp <= 0) {
    return { kind: "error", reason: "Pairing link expiry has an unexpected format" };
  }
  if (exp <= Date.now()) {
    return {
      kind: "error",
      reason: "This pairing link has expired — generate a new invite on the server",
    };
  }

  let sig = DEFAULT_SIGNAL_URL;
  if (hasCustomSignaling) {
    const signalBytes = bytes.slice(COMPACT_FIXED_BYTES);
    sig = new TextDecoder().decode(signalBytes);
    if (!sig || !bytesEqual(new TextEncoder().encode(sig), signalBytes)) {
      return { kind: "error", reason: "Pairing link has an invalid signaling endpoint encoding" };
    }
  }
  const sigParsed = parseSignalingEndpoint(sig);
  if (sigParsed.kind === "error") return sigParsed;
  const room = derivePairingRoom(code);

  return {
    kind: "ok",
    room,
    fp,
    code,
    sig: sigParsed.url,
    v: PAIRING_PROTOCOL_VERSION,
    ice: (flags & COMPACT_FLAG_RELAY) !== 0 ? "relay" : "all",
    exp,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function resolveSignalingUrl(
  options: {
    flag?: string | null;
    env?: Record<string, string | undefined>;
    envKeys?: readonly string[];
    defaultUrl?: string;
  } = {}
): SignalingResolution {
  const envKeys = options.envKeys ?? ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];
  const env =
    options.env ??
    (typeof process === "undefined" ? {} : (process.env as Record<string, string | undefined>));
  const candidates: Array<{ value: string | null | undefined; source: SignalingResolutionSource }> =
    [
      { value: options.flag, source: "flag" },
      {
        value: envKeys.map((key) => env[key]).find((value) => value !== undefined && value !== ""),
        source: "env",
      },
      { value: options.defaultUrl ?? DEFAULT_SIGNAL_URL, source: "default" },
    ];
  const selected = candidates.find(
    (candidate) => candidate.value !== undefined && candidate.value !== ""
  );
  const raw = selected?.value ?? DEFAULT_SIGNAL_URL;
  const parsed = parseSignalingEndpoint(raw);
  if (parsed.kind === "error") {
    throw new Error(
      `Invalid WebRTC signaling endpoint from ${selected?.source ?? "default"}: ${parsed.reason}`
    );
  }
  return { url: parsed.url, source: selected?.source ?? "default" };
}

/** The signaling endpoint is a public wss/https URL (ws/http allowed for loopback dev). */
export function parseSignalingEndpoint(
  raw: string
): { kind: "ok"; url: string } | { kind: "error"; reason: string } {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return { kind: "error", reason: `Signaling endpoint is not parseable: ${raw}` };
  }
  const proto = endpoint.protocol;
  if (proto !== "wss:" && proto !== "https:" && proto !== "ws:" && proto !== "http:") {
    return {
      kind: "error",
      reason: `Signaling endpoint must be ws(s)/http(s) (got ${proto || "no scheme"})`,
    };
  }
  if ((proto === "ws:" || proto === "http:") && !isLoopbackHost(endpoint.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext signaling is only allowed for loopback. Use wss:// for ${endpoint.hostname}.`,
    };
  }
  return { kind: "ok", url: endpoint.toString() };
}

/**
 * Loopback-only cleartext gate (replaces the old isTrustedCleartextHost +
 * private-IP/Tailscale/single-label helpers, deleted with remote mode §8b). The
 * data plane no longer rides a cleartext LAN/Tailscale origin — remote is WebRTC
 * (DTLS-encrypted), local co-located mode is loopback. `10.0.2.2` is kept for
 * the Android emulator's host loopback alias.
 */
export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}
