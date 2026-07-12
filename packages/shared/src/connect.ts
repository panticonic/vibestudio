export const CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIR_LINK_ORIGIN = "https://vibestudio.app";
export const PAIR_LINK_PATH = "/pair";
export const DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";
/** Current pairing issuer output: exactly 24 random bytes encoded as base64url. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const WORKSPACE_ROUTE_PREFIX = "/_workspace/";
/** Signaling rendezvous room id (UUID or base64url token). */
export const PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** DTLS SHA-256 fingerprint after stripping colons: 32 bytes = 64 hex chars. */
const FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
const CONNECT_PARAMETER_KEYS = new Set(["room", "fp", "code", "sig", "v", "ice", "srv"]);
/**
 * Current room-per-invite pairing protocol. Parsers require this exact version.
 */
export const PAIRING_PROTOCOL_VERSION = 2;

export type TurnPolicy = "all" | "relay";
export type ConnectLinkCarrier = "scheme" | "https";
export type SignalingResolutionSource = "flag" | "env" | "default";

/**
 * The exact WebRTC pairing payload carried in the QR / deep link. The shell
 * joins a signaling room and pins the server's DTLS fingerprint.
 */
export interface ConnectPairing {
  /** Unguessable signaling rendezvous room id. */
  room: string;
  /** Pinned server DTLS SHA-256 fingerprint (the QR `fp`). */
  fp: string;
  /** Pairing secret proving QR possession. */
  code: string;
  /** Signaling endpoint (decouples us from a hard-coded host). */
  sig: string;
  /** Exact current protocol version. */
  v: typeof PAIRING_PROTOCOL_VERSION;
  /** TURN policy — `relay` forces TURN-over-TLS:443 validation. */
  ice: TurnPolicy;
  /** Optional server/workspace label to disambiguate servers. */
  srv?: string;
  /** Invite expiry in epoch milliseconds; clients reject stale QR links immediately. */
  exp?: number;
}

export type ConnectLink = ({ kind: "ok" } & ConnectPairing) | { kind: "error"; reason: string };
export type SignalingResolution = { url: string; source: SignalingResolutionSource };
type QueryParseResult =
  | { kind: "ok"; values: Map<string, string> }
  | { kind: "error"; reason: string };
type QueryDecodeResult = { kind: "ok"; value: string } | { kind: "error"; reason: string };

/** Strip colons/whitespace and upper-case a DTLS fingerprint for comparison. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

function encodeConnectParams(pairing: ConnectPairing): string {
  const signaling = parseSignalingEndpoint(pairing.sig);
  if (!PAIRING_ROOM_PATTERN.test(pairing.room)) {
    throw new Error("Cannot create pairing link: room has an unexpected format");
  }
  const fingerprint = normalizeFingerprint(pairing.fp);
  if (!FINGERPRINT_HEX_PATTERN.test(fingerprint)) {
    throw new Error("Cannot create pairing link: fingerprint must be SHA-256");
  }
  if (!PAIRING_CODE_PATTERN.test(pairing.code)) {
    throw new Error("Cannot create pairing link: code has an unexpected format");
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
  const params: string[] = [
    `room=${encodeURIComponent(pairing.room)}`,
    `fp=${encodeURIComponent(fingerprint)}`,
    `code=${encodeURIComponent(pairing.code)}`,
    `sig=${encodeURIComponent(signaling.url)}`,
    `v=${encodeURIComponent(String(pairing.v))}`,
    `ice=${encodeURIComponent(pairing.ice)}`,
  ];
  if (pairing.srv) params.push(`srv=${encodeURIComponent(pairing.srv)}`);
  if (pairing.exp) params.push(`exp=${encodeURIComponent(String(pairing.exp))}`);
  return params.join("&");
}

export function createConnectLink(
  pairing: ConnectPairing,
  carrier: ConnectLinkCarrier = "scheme"
): string {
  const params = encodeConnectParams(pairing);
  if (carrier === "https") {
    return `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${params}`;
  }
  return `vibestudio://connect?${params}`;
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
  // The prefix must be followed by a real delimiter — otherwise
  // `vibestudio://connect-anything?…` would parse as a connect link (the host is
  // exactly `connect`, no more).
  const afterScheme = raw.slice(prefix.length);
  const isSchemeLink =
    raw.startsWith(prefix) &&
    (afterScheme === "" ||
      afterScheme[0] === "?" ||
      afterScheme[0] === "/" ||
      afterScheme[0] === "#");
  let rawParams: string;
  if (isSchemeLink) {
    const queryStart = raw.indexOf("?");
    if (queryStart < 0) {
      return { kind: "error", reason: "Deep link is missing pairing parameters" };
    }
    // Manual (non-`new URL()`) query parse — the vibestudio: custom scheme is not
    // URL-parseable on RN/Hermes (asserted by connect.test.ts). Strip any
    // `#fragment` so it can't fold into the last query value.
    const fragmentStart = raw.indexOf("#", queryStart);
    rawParams =
      fragmentStart >= 0 ? raw.slice(queryStart + 1, fragmentStart) : raw.slice(queryStart + 1);
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
    if (!url.hash || url.hash === "#") {
      return { kind: "error", reason: "Pair URL is missing pairing parameters" };
    }
    rawParams = url.hash.slice(1);
  } else {
    return { kind: "error", reason: "Not a vibestudio://connect link or Vibestudio pair URL" };
  }

  const params = parseQuery(rawParams);
  if (params.kind === "error") return params;

  // Version gate first so an incompatible link gets one precise error.
  if (params.values.get("v") !== String(PAIRING_PROTOCOL_VERSION)) {
    return {
      kind: "error",
      reason: `Unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION})`,
    };
  }

  const room = params.values.get("room");
  const fp = params.values.get("fp");
  const code = params.values.get("code");
  const sig = params.values.get("sig");
  const ice = params.values.get("ice");
  if (!room || !fp || !code || !sig || !ice) {
    return { kind: "error", reason: "Deep link is missing `room`, `fp`, `code`, `sig`, or `ice`" };
  }

  if (!PAIRING_ROOM_PATTERN.test(room)) {
    return { kind: "error", reason: "Signaling room id has an unexpected format" };
  }
  if (!FINGERPRINT_HEX_PATTERN.test(normalizeFingerprint(fp).toLowerCase())) {
    return { kind: "error", reason: "DTLS fingerprint must be a SHA-256 (64 hex chars)" };
  }
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return { kind: "error", reason: "Pairing code has an unexpected format" };
  }
  const sigParsed = parseSignalingEndpoint(sig);
  if (sigParsed.kind === "error") return sigParsed;

  if (ice !== "all" && ice !== "relay") {
    return { kind: "error", reason: "TURN policy `ice` must be `all` or `relay`" };
  }
  const expRaw = params.values.get("exp");
  const exp = expRaw ? Number(expRaw) : undefined;
  if (expRaw && (!Number.isFinite(exp) || (exp ?? 0) <= 0)) {
    return { kind: "error", reason: "Pairing link expiry has an unexpected format" };
  }
  if (exp !== undefined && exp <= Date.now()) {
    return {
      kind: "error",
      reason: "This pairing link has expired — generate a new invite on the server",
    };
  }

  return {
    kind: "ok",
    room,
    fp,
    code,
    sig: sigParsed.url,
    v: PAIRING_PROTOCOL_VERSION,
    ice,
    srv: params.values.get("srv") || undefined,
    ...(exp !== undefined ? { exp } : {}),
  };
}

export function resolveSignalingUrl(options: {
  flag?: string | null;
  env?: Record<string, string | undefined>;
  envKeys?: readonly string[];
  defaultUrl?: string;
}): SignalingResolution {
  const envKeys = options.envKeys ?? ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];
  const env = options.env ?? {};
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

function parseQuery(raw: string): QueryParseResult {
  const values = new Map<string, string>();
  for (const part of raw.split("&")) {
    if (!part) return { kind: "error", reason: "Deep link contains an empty parameter" };
    const separator = part.indexOf("=");
    const key = separator >= 0 ? part.slice(0, separator) : part;
    const value = separator >= 0 ? part.slice(separator + 1) : "";
    const decodedKey = decodeQueryComponent(key);
    const decodedValue = decodeQueryComponent(value);
    if (decodedKey.kind === "error") return decodedKey;
    if (decodedValue.kind === "error") return decodedValue;
    if (!CONNECT_PARAMETER_KEYS.has(decodedKey.value)) {
      return {
        kind: "error",
        reason: `Deep link contains unsupported parameter \`${decodedKey.value}\``,
      };
    }
    if (values.has(decodedKey.value)) {
      return {
        kind: "error",
        reason: `Deep link contains duplicate parameter \`${decodedKey.value}\``,
      };
    }
    values.set(decodedKey.value, decodedValue.value);
  }
  return { kind: "ok", values };
}

function decodeQueryComponent(raw: string): QueryDecodeResult {
  try {
    return { kind: "ok", value: decodeURIComponent(raw.replace(/\+/g, " ")) };
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
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
