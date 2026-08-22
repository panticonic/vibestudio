// Generated from packages/shared/src/connect.ts by scripts/generate-connect-grammar.mjs.
// Do not edit this dependency-free raw-node artifact by hand.
// packages/content-addressing/src/canonical-order.ts
function compareUtf16CodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// packages/content-addressing/src/canonical-json.ts
function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === "object") {
    const record = value;
    const sorted = {};
    for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
      const child = record[key];
      if (child !== void 0) sorted[key] = sortForCanonicalJson(child);
    }
    return sorted;
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

// packages/content-addressing/src/tree-paths.ts
var textEncoder = new TextEncoder();

// packages/content-addressing/src/worktree-hash.ts
var SHA256_K = [
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
];
function rotr32(value, shift) {
  return value >>> shift | value << 32 - shift;
}
function sha256Hex(data) {
  const bitLength = data.length * 8;
  const totalLength = Math.ceil((data.length + 9) / 64) * 64;
  const bytes = new Uint8Array(totalLength);
  bytes.set(data);
  bytes[data.length] = 128;
  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  view.setUint32(totalLength - 8, high, false);
  view.setUint32(totalLength - 4, low, false);
  const hash = [
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = e & f ^ ~e & g;
      const temp1 = h + s1 + ch + SHA256_K[i] + w[i] >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const temp2 = s0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    hash[0] = hash[0] + a >>> 0;
    hash[1] = hash[1] + b >>> 0;
    hash[2] = hash[2] + c >>> 0;
    hash[3] = hash[3] + d >>> 0;
    hash[4] = hash[4] + e >>> 0;
    hash[5] = hash[5] + f >>> 0;
    hash[6] = hash[6] + g >>> 0;
    hash[7] = hash[7] + h >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
function sha256HexSyncText(text) {
  return sha256Hex(new TextEncoder().encode(text));
}
function stableSha256Hex(value) {
  return sha256HexSyncText(canonicalJson(value));
}
function manifestHashForEntries(entries) {
  const sorted = [...entries].sort((a, b) => compareUtf16CodeUnits(a.name, b.name));
  return `manifest:${stableSha256Hex({ kind: "dir", entries: sorted })}`;
}
function stateHashForRoot(rootHash) {
  return `state:${stableSha256Hex({ manifestRootHash: rootHash })}`;
}
var EMPTY_MANIFEST_HASH = manifestHashForEntries([]);
var EMPTY_STATE_HASH = stateHashForRoot(EMPTY_MANIFEST_HASH);

// packages/content-addressing/src/snapshot-digest.ts
var MAGIC = new TextEncoder().encode("vibestudio-snapshot\0v1\0sha256\0");
var encoder = new TextEncoder();

// packages/shared/src/connect.ts
var CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
var CONNECT_DEEP_LINK_HOST = "connect";
var PAIR_LINK_ORIGIN = "https://vibestudio.app";
var PAIR_LINK_PATH = "/p";
var DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";
var PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
var WORKSPACE_ROUTE_PREFIX = "/_workspace/";
var PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
var FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
var PAIRING_PROTOCOL_VERSION = 3;
var COMPACT_HEADER_VERSION_SHIFT = 4;
var COMPACT_FLAG_RELAY = 1 << 0;
var COMPACT_FLAG_CUSTOM_SIGNALING = 1 << 1;
var COMPACT_KNOWN_FLAGS = COMPACT_FLAG_RELAY | COMPACT_FLAG_CUSTOM_SIGNALING;
var COMPACT_FIXED_BYTES = 1 + 32 + 24 + 6;
var MAX_CUSTOM_SIGNALING_BYTES = 2048;
var PAIRING_ROOM_DOMAIN = new TextEncoder().encode("vibestudio-pairing-room-v3\0");
function normalizeFingerprint(fp) {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}
function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
var BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function encodeBase64Url(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const value = bytes[offset] << 16 | (remaining > 1 ? bytes[offset + 1] : 0) << 8 | (remaining > 2 ? bytes[offset + 2] : 0);
    output += BASE64URL_ALPHABET[value >>> 18 & 63];
    output += BASE64URL_ALPHABET[value >>> 12 & 63];
    if (remaining > 1) output += BASE64URL_ALPHABET[value >>> 6 & 63];
    if (remaining > 2) output += BASE64URL_ALPHABET[value & 63];
  }
  return output;
}
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const output = new Uint8Array(Math.floor(value.length * 6 / 8));
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
      output[outputOffset++] = accumulator >>> bits & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0 || outputOffset !== output.length) return null;
  return output;
}
function bytesFromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
function hexFromBytes(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output.toUpperCase();
}
function derivePairingRoom(code) {
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error("Cannot derive pairing room: code has an unexpected format");
  }
  const codeBytes = decodeBase64Url(code);
  if (!codeBytes || codeBytes.length !== 24) {
    throw new Error("Cannot derive pairing room: code is not canonical base64url");
  }
  return sha256Hex(concatBytes(PAIRING_ROOM_DOMAIN, codeBytes));
}
function encodeCompactPairing(pairing) {
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
  if (!Number.isSafeInteger(pairing.exp) || pairing.exp <= 0 || pairing.exp > 281474976710655) {
    throw new Error("Cannot create pairing link: expiry has an unexpected format");
  }
  const customSignaling = signaling.url === DEFAULT_SIGNAL_URL ? new Uint8Array() : new TextEncoder().encode(signaling.url);
  if (customSignaling.length > MAX_CUSTOM_SIGNALING_BYTES) {
    throw new Error("Cannot create pairing link: signaling endpoint is too long");
  }
  const bytes = new Uint8Array(COMPACT_FIXED_BYTES + customSignaling.length);
  const flags = (pairing.ice === "relay" ? COMPACT_FLAG_RELAY : 0) | (customSignaling.length > 0 ? COMPACT_FLAG_CUSTOM_SIGNALING : 0);
  bytes[0] = PAIRING_PROTOCOL_VERSION << COMPACT_HEADER_VERSION_SHIFT | flags;
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
function createConnectLink(pairing, carrier = "scheme") {
  const payload = encodeCompactPairing(pairing);
  if (carrier === "https") {
    return `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${payload}`;
  }
  return `vibestudio://connect/${payload}`;
}
function connectPairingFromLink(link) {
  const { kind: _kind, ...pairing } = link;
  return pairing;
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
  if (raw.startsWith(`${prefix}?`) || raw.startsWith(`${PAIR_LINK_ORIGIN}/pair`)) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); generate a fresh link from an updated server`
    };
  }
  let compactPayload;
  if (raw.startsWith(`${prefix}/`)) {
    compactPayload = raw.slice(prefix.length + 1);
    if (!compactPayload || compactPayload.includes("/") || compactPayload.includes("?") || compactPayload.includes("#")) {
      return { kind: "error", reason: "Deep link has malformed compact pairing material" };
    }
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
  if (!bytes || bytes.length < COMPACT_FIXED_BYTES || bytes.length > COMPACT_FIXED_BYTES + MAX_CUSTOM_SIGNALING_BYTES) {
    return { kind: "error", reason: "Pairing link has malformed compact pairing material" };
  }
  const header = bytes[0];
  const version = header >>> COMPACT_HEADER_VERSION_SHIFT;
  const flags = header & (1 << COMPACT_HEADER_VERSION_SHIFT) - 1;
  if (version !== PAIRING_PROTOCOL_VERSION) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); generate a fresh link from an updated server`
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
  for (let index = 57; index < 63; index += 1) exp = exp * 256 + bytes[index];
  if (!Number.isSafeInteger(exp) || exp <= 0) {
    return { kind: "error", reason: "Pairing link expiry has an unexpected format" };
  }
  if (exp <= Date.now()) {
    return {
      kind: "error",
      reason: "This pairing link has expired \u2014 generate a new invite on the server"
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
    exp
  };
}
function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
  connectPairingFromLink,
  createConnectDeepLink,
  createConnectLink,
  createConnectPairUrl,
  derivePairingRoom,
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
