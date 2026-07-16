// Generated from packages/shared/src/connect.ts by scripts/generate-connect-grammar.mjs.
// Do not edit this dependency-free raw-node artifact by hand.
// packages/shared/src/connect.ts
var CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
var CONNECT_DEEP_LINK_HOST = "connect";
var PAIR_LINK_ORIGIN = "https://vibestudio.app";
var PAIR_LINK_PATH = "/pair";
var DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";
var PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
var WORKSPACE_ROUTE_PREFIX = "/_workspace/";
var PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
var FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
var CONNECT_PARAMETER_KEYS = /* @__PURE__ */ new Set(["room", "fp", "code", "sig", "v", "ice", "exp"]);
var PAIRING_PROTOCOL_VERSION = 2;
function normalizeFingerprint(fp) {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}
function encodeConnectParams(pairing) {
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
  const params = [
    `room=${encodeURIComponent(pairing.room)}`,
    `fp=${encodeURIComponent(fingerprint)}`,
    `code=${encodeURIComponent(pairing.code)}`,
    `sig=${encodeURIComponent(signaling.url)}`,
    `v=${encodeURIComponent(String(pairing.v))}`,
    `ice=${encodeURIComponent(pairing.ice)}`
  ];
  if (pairing.exp) params.push(`exp=${encodeURIComponent(String(pairing.exp))}`);
  return params.join("&");
}
function createConnectLink(pairing, carrier = "scheme") {
  const params = encodeConnectParams(pairing);
  if (carrier === "https") {
    return `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${params}`;
  }
  return `vibestudio://connect?${params}`;
}
function createConnectDeepLink(pairing) {
  return createConnectLink(pairing, "scheme");
}
function createConnectPairUrl(pairing) {
  return createConnectLink(pairing, "https");
}
function appendServerPath(baseUrl, suffix) {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = suffix.replace(/^\/+/, "");
  url.pathname = nextPath ? `${basePath}/${nextPath}` : basePath || "/";
  url.search = "";
  url.hash = "";
  return url;
}
function serverRpcHttpUrl(baseUrl) {
  return appendServerPath(baseUrl, "/rpc");
}
function serverRpcStreamHttpUrl(baseUrl) {
  return appendServerPath(baseUrl, "/rpc/stream");
}
function serverRpcWsUrl(baseUrl) {
  const url = serverRpcHttpUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
function serverCdpHostWsUrl(baseUrl, hostConnectionId) {
  const url = appendServerPath(baseUrl, "/api/cdp-host");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostConnectionId", hostConnectionId);
  return url.toString();
}
function serverAuthRouteUrl(baseUrl, route) {
  return appendServerPath(baseUrl, `/_r/s/auth/${route.replace(/^\/+/, "")}`);
}
function selectedWorkspacePath(workspaceName) {
  return `${WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(workspaceName)}`;
}
function selectedWorkspaceUrl(baseUrl, workspaceName) {
  return appendServerPath(baseUrl, selectedWorkspacePath(workspaceName));
}
function selectedWorkspaceNameFromUrl(rawUrl) {
  let url;
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
function isSelectedWorkspaceUrl(rawUrl) {
  return selectedWorkspaceNameFromUrl(rawUrl) !== null;
}
function parseConnectLink(raw) {
  if (typeof raw !== "string") {
    return { kind: "error", reason: "Deep link must be a string" };
  }
  const prefix = `${CONNECT_DEEP_LINK_SCHEME}//${CONNECT_DEEP_LINK_HOST}`;
  const httpsPrefix = `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}`;
  const afterScheme = raw.slice(prefix.length);
  const isSchemeLink = raw.startsWith(prefix) && (afterScheme === "" || afterScheme[0] === "?" || afterScheme[0] === "/" || afterScheme[0] === "#");
  let rawParams;
  if (isSchemeLink) {
    const queryStart = raw.indexOf("?");
    if (queryStart < 0) {
      return { kind: "error", reason: "Deep link is missing pairing parameters" };
    }
    const fragmentStart = raw.indexOf("#", queryStart);
    rawParams = fragmentStart >= 0 ? raw.slice(queryStart + 1, fragmentStart) : raw.slice(queryStart + 1);
  } else if (raw.startsWith(httpsPrefix)) {
    let url;
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
  if (params.values.get("v") !== String(PAIRING_PROTOCOL_VERSION)) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); re-pair this device with a fresh link`
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
  const exp = expRaw ? Number(expRaw) : void 0;
  if (expRaw && (!Number.isFinite(exp) || (exp ?? 0) <= 0)) {
    return { kind: "error", reason: "Pairing link expiry has an unexpected format" };
  }
  if (exp !== void 0 && exp <= Date.now()) {
    return {
      kind: "error",
      reason: "This pairing link has expired \u2014 generate a new invite on the server"
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
    ...exp !== void 0 ? { exp } : {}
  };
}
function resolveSignalingUrl(options = {}) {
  const envKeys = options.envKeys ?? ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const candidates = [
    { value: options.flag, source: "flag" },
    {
      value: envKeys.map((key) => env[key]).find((value) => value !== void 0 && value !== ""),
      source: "env"
    },
    { value: options.defaultUrl ?? DEFAULT_SIGNAL_URL, source: "default" }
  ];
  const selected = candidates.find(
    (candidate) => candidate.value !== void 0 && candidate.value !== ""
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
function parseSignalingEndpoint(raw) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    return { kind: "error", reason: `Signaling endpoint is not parseable: ${raw}` };
  }
  const proto = endpoint.protocol;
  if (proto !== "wss:" && proto !== "https:" && proto !== "ws:" && proto !== "http:") {
    return {
      kind: "error",
      reason: `Signaling endpoint must be ws(s)/http(s) (got ${proto || "no scheme"})`
    };
  }
  if ((proto === "ws:" || proto === "http:") && !isLoopbackHost(endpoint.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext signaling is only allowed for loopback. Use wss:// for ${endpoint.hostname}.`
    };
  }
  return { kind: "ok", url: endpoint.toString() };
}
function parseQuery(raw) {
  const values = /* @__PURE__ */ new Map();
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
        reason: `Deep link contains unsupported parameter \`${decodedKey.value}\``
      };
    }
    if (values.has(decodedKey.value)) {
      return {
        kind: "error",
        reason: `Deep link contains duplicate parameter \`${decodedKey.value}\``
      };
    }
    values.set(decodedKey.value, decodedValue.value);
  }
  return { kind: "ok", values };
}
function decodeQueryComponent(raw) {
  try {
    return { kind: "ok", value: decodeURIComponent(raw.replace(/\+/g, " ")) };
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
}
function isLoopbackHost(host) {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}
export {
  CONNECT_DEEP_LINK_HOST,
  CONNECT_DEEP_LINK_SCHEME,
  DEFAULT_SIGNAL_URL,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  PAIR_LINK_ORIGIN,
  PAIR_LINK_PATH,
  WORKSPACE_ROUTE_PREFIX,
  appendServerPath,
  createConnectDeepLink,
  createConnectLink,
  createConnectPairUrl,
  isLoopbackHost,
  isSelectedWorkspaceUrl,
  normalizeFingerprint,
  parseConnectLink,
  parseSignalingEndpoint,
  resolveSignalingUrl,
  selectedWorkspaceNameFromUrl,
  selectedWorkspacePath,
  selectedWorkspaceUrl,
  serverAuthRouteUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcStreamHttpUrl,
  serverRpcWsUrl
};
