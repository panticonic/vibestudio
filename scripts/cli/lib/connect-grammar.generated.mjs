// Generated from packages/shared/src/connect.ts by scripts/generate-connect-grammar.mjs.
// Do not edit this dependency-free raw-node artifact by hand.
// packages/iroh-transport/src/alpn.ts
var VIBESTUDIO_IROH_ALPN_TEXT = "vibestudio-rpc/4";
var VIBESTUDIO_IROH_ALPN = Object.freeze([
  ...new TextEncoder().encode(VIBESTUDIO_IROH_ALPN_TEXT)
]);

// packages/iroh-transport/src/reach.ts
var IROH_REACH_VERSION = 4;
var MAX_RELAY_URLS = 8;
var MAX_RELAY_URL_BYTES = 512;
var CANONICAL_ENDPOINT_ID = /^[0-9a-f]{64}$/;
function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}
function assertIrohReach(reach) {
  if (reach.v !== IROH_REACH_VERSION) {
    throw new Error(`Unsupported Iroh reach version ${String(reach.v)}`);
  }
  if (!CANONICAL_ENDPOINT_ID.test(reach.endpointId)) {
    throw new Error("Iroh reach endpointId must be a canonical 32-byte lowercase hex key");
  }
  if (reach.relays.length === 0 || reach.relays.length > MAX_RELAY_URLS) {
    throw new Error(`Iroh reach must contain 1-${MAX_RELAY_URLS} relay URLs`);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const relay of reach.relays) {
    if (utf8Length(relay) > MAX_RELAY_URL_BYTES) {
      throw new Error(`Iroh relay URL exceeds ${MAX_RELAY_URL_BYTES} bytes`);
    }
    let parsed;
    try {
      parsed = new URL(relay);
    } catch {
      throw new Error(`Invalid Iroh relay URL: ${relay}`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`Iroh relay URL must be credential-free HTTPS: ${relay}`);
    }
    if (parsed.toString() !== relay) {
      throw new Error(`Iroh relay URL is not canonical: ${relay}`);
    }
    if (seen.has(relay)) throw new Error(`Duplicate Iroh relay URL: ${relay}`);
    seen.add(relay);
  }
}

// packages/iroh-transport/src/pairing.ts
var CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
var PAIR_LINK_ORIGIN = "https://vibestudio.app";
var PAIR_LINK_PATH = "/p";
var PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
var HEADER = IROH_REACH_VERSION << 4;
var FIXED_BYTES = 1 + 32 + 24 + 6 + 1;
var BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function encodeBase64Url(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const value = bytes[offset] << 16 | (remaining > 1 ? bytes[offset + 1] : 0) << 8 | (remaining > 2 ? bytes[offset + 2] : 0);
    output += BASE64URL[value >>> 18 & 63];
    output += BASE64URL[value >>> 12 & 63];
    if (remaining > 1) output += BASE64URL[value >>> 6 & 63];
    if (remaining > 2) output += BASE64URL[value & 63];
  }
  return output;
}
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const output = new Uint8Array(Math.floor(value.length * 6 / 8));
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
      output[index++] = accumulator >>> bits & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  return accumulator === 0 && index === output.length ? output : null;
}
function hexBytes(value) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}
function bytesHex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function encodeConnectPairing(pairing) {
  assertIrohReach(pairing);
  if (!PAIRING_CODE_PATTERN.test(pairing.code)) {
    throw new Error("Pairing code must be canonical 24-byte base64url");
  }
  const code = decodeBase64Url(pairing.code);
  if (!code || code.byteLength !== 24) throw new Error("Pairing code is not canonical base64url");
  if (!Number.isSafeInteger(pairing.exp) || pairing.exp <= 0 || pairing.exp > 281474976710655) {
    throw new Error("Pairing expiry has an unexpected format");
  }
  const relayBytes = pairing.relays.map((relay) => new TextEncoder().encode(relay));
  const total = FIXED_BYTES + relayBytes.reduce((sum, relay) => sum + 2 + relay.byteLength, 0);
  const output = new Uint8Array(total);
  output[0] = HEADER;
  output.set(hexBytes(pairing.endpointId), 1);
  output.set(code, 33);
  let expiry = pairing.exp;
  for (let index = 62; index >= 57; index -= 1) {
    output[index] = expiry % 256;
    expiry = Math.floor(expiry / 256);
  }
  output[63] = relayBytes.length;
  let offset = FIXED_BYTES;
  for (const relay of relayBytes) {
    output[offset] = relay.byteLength >>> 8;
    output[offset + 1] = relay.byteLength & 255;
    output.set(relay, offset + 2);
    offset += 2 + relay.byteLength;
  }
  return encodeBase64Url(output);
}
function decodeConnectPairing(payload, now = Date.now()) {
  const bytes = decodeBase64Url(payload);
  if (!bytes || bytes.byteLength < FIXED_BYTES) {
    return { kind: "error", reason: "Pairing link has malformed compact material" };
  }
  if (bytes[0] !== HEADER) {
    return {
      kind: "error",
      reason: `Old or unsupported pairing protocol version (expected v=${IROH_REACH_VERSION})`
    };
  }
  let exp = 0;
  for (let index = 57; index <= 62; index += 1) exp = exp * 256 + bytes[index];
  if (!Number.isSafeInteger(exp) || exp <= now) {
    return { kind: "error", reason: "This pairing link has expired" };
  }
  const relayCount = bytes[63];
  if (relayCount < 1 || relayCount > MAX_RELAY_URLS) {
    return { kind: "error", reason: "Pairing link has an invalid relay count" };
  }
  const relays = [];
  let offset = FIXED_BYTES;
  const decoder2 = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let index = 0; index < relayCount; index += 1) {
      if (offset + 2 > bytes.byteLength) throw new Error("truncated relay length");
      const length = bytes[offset] * 256 + bytes[offset + 1];
      offset += 2;
      if (length < 1 || length > MAX_RELAY_URL_BYTES || offset + length > bytes.byteLength) {
        throw new Error("invalid relay length");
      }
      relays.push(decoder2.decode(bytes.slice(offset, offset + length)));
      offset += length;
    }
  } catch {
    return { kind: "error", reason: "Pairing link has malformed relay data" };
  }
  if (offset !== bytes.byteLength) {
    return { kind: "error", reason: "Pairing link contains trailing compact data" };
  }
  const pairing = {
    endpointId: bytesHex(bytes.slice(1, 33)),
    code: encodeBase64Url(bytes.slice(33, 57)),
    exp,
    relays,
    v: IROH_REACH_VERSION
  };
  try {
    assertIrohReach(pairing);
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "ok", ...pairing };
}
function createConnectLink(pairing, carrier = "scheme") {
  const payload = encodeConnectPairing(pairing);
  return carrier === "https" ? `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${payload}` : `${CONNECT_DEEP_LINK_SCHEME}//connect/${payload}`;
}
function createConnectDeepLink(pairing) {
  return createConnectLink(pairing, "scheme");
}
function createConnectPairUrl(pairing) {
  return createConnectLink(pairing, "https");
}
function parseConnectLink(raw, now = Date.now()) {
  const schemePrefix = `${CONNECT_DEEP_LINK_SCHEME}//connect/`;
  let payload;
  if (raw.startsWith(schemePrefix)) {
    payload = raw.slice(schemePrefix.length);
    if (!payload || /[/?#]/u.test(payload)) {
      return { kind: "error", reason: "Deep link has malformed compact pairing material" };
    }
  } else {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "error", reason: "Not a Vibestudio connect link" };
    }
    if (url.origin !== PAIR_LINK_ORIGIN || url.pathname !== PAIR_LINK_PATH || url.search || !url.hash) {
      return { kind: "error", reason: "Not a Vibestudio pair URL" };
    }
    payload = url.hash.slice(1);
  }
  return decodeConnectPairing(payload, now);
}

// packages/iroh-transport/src/releaseSet.ts
var IROH_RELEASE_SET = Object.freeze({
  id: "iroh-ffi-1.1.0-core-1.0.2",
  bindingVersion: "1.1.0",
  bindingCommit: "5e451092dba0c1a09ee83ff6e5be37b1152a5c58",
  embeddedCoreVersion: "1.0.2",
  relayVersion: "1.0.2",
  npmIntegrity: "sha512-DlrJ4Sza5MiI+WwQg63lg+7eSbxlfQR2Bd+wVDjo7XTqenALD2OCRoSfPTuD12IhcvDbVHr4l7qH48DilocqYA==",
  iosXcframeworkSha256: "ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776",
  androidAarSha256: "ed747f627da6dad314b25b9ff17d38232d8d75cb31e663af348368e6be845ab8"
});
var IROH_NODE_OPTIONAL_PACKAGE_INTEGRITIES = Object.freeze({
  "@number0/iroh-android-arm-eabi": "sha512-PcrwZUGdqEnR0/tus0ehulEa68wVrJRJzFjZN5iBV1Jjhgy00oQ5hKtRdCam1lYAQp3jWmRGktLHF2ejj0xAMg==",
  "@number0/iroh-android-arm64": "sha512-wmnWLRNIHYARAecXbXPwZwduoFkmI+Bt75RSa+NZ3mdXiU+hBwWbHt7x0OEDtG8sMOgGgM22nqWemeU9r+UPqA==",
  "@number0/iroh-darwin-arm64": "sha512-CM6gaQ+6r9K0HRswc2gOKeGL8XYUHUbz7ESkgOltBFin9OsYKmIo+JVYFxlahH8C7ypGEKq1ybU22Ifcf2kXnQ==",
  "@number0/iroh-linux-arm-gnueabihf": "sha512-5K4Kaz4gzyPo5s5LLAFO0zLXc2F0EZ3BXeMKzQc5zuPaeHQt4XqdwxozXVtn0/3EiUYqFNH1JIowagpwahxAlw==",
  "@number0/iroh-linux-arm-musleabihf": "sha512-Bz/vWWauI9t96imq8Jq1a2La4u5K9jVTjuCgm6gjpcFIp7wivfv4syZ4HlbgVD61C3Aqjb89lnlhzMd5qE/w0w==",
  "@number0/iroh-linux-arm64-gnu": "sha512-AZHpCKQEcJdXya9llNld5u+S2Cz+ehWgGzILtpEJ1qljNYJAClDovzA+5ehUVaXEc+P7ZUNQ+pIjMcWXM0cAug==",
  "@number0/iroh-linux-arm64-musl": "sha512-4ZS/U2L4+zk2E5cn5WmxxuUDTkdwWiyxRq0NFArRQNFbuH7mjtQok2aDIbOIFOIrTTB4x1hwb4Gt0OJw4om4SQ==",
  "@number0/iroh-linux-x64-gnu": "sha512-P2mo734gUjrfJgwbma1fHAyfeWqtY5IHTx53b1peei2/05JKZ2JJ4LS/YzI4qYW20mVtLKD9GS0T3q/iFYVC9Q==",
  "@number0/iroh-linux-x64-musl": "sha512-GTnr8v59AeS5iGmXLyqcgLCsTAFW2w6tdfDzjyyCYr6iO3h4vZuBv9HG3CwaVU+vOzzig9ojDzauDLgl96nniw==",
  "@number0/iroh-win32-arm64-msvc": "sha512-LvG4Vcw8D7tFAxZpuZsh6rmyW1YmtS3McDIQjEUNhf9VNBFzQ7WHyEIxdr1GAg/HvC8rmPJ1MQBM24RCDbdUew==",
  "@number0/iroh-win32-x64-msvc": "sha512-1eSztLtesLu2tHdAgr9KNPBsSVdiz2+MDHNvCVDtH+UQAN8F+21YqAAbRJB0ctBvB5zcGeTwYawGaqVMTyRVJg=="
});
var IROH_RELAY_1_0_2_LINUX_ASSET_SHA256 = Object.freeze({
  "aarch64-unknown-linux-gnu": "5810cd3b0861640026deb4423a80d79af130242a34fe9b244d1bf4fd7fc1fdcd",
  "aarch64-unknown-linux-musl": "9a548087f7b1f3a25f5c932790bc0836dd3cb6ffb28d6104b63d18478ed2c51d",
  "x86_64-unknown-linux-gnu": "7faf12b2b0137b5993e8dd1fb7557b2e61fee1a53486db74bb80d5c96907af93",
  "x86_64-unknown-linux-musl": "3d6c37a66f8b21da620f9d83ce4682639aa2de9910bbf1e8e7981cf8478964ea"
});

// packages/iroh-transport/src/wire.ts
var MAX_CONTROL_FRAME_BYTES = 64 * 1024;
var MAX_ENVELOPE_FRAME_BYTES = 8 * 1024 * 1024;
var MAX_STREAM_CHUNK_BYTES = 256 * 1024;
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });

// packages/shared/src/connect.ts
var PAIRING_PROTOCOL_VERSION = IROH_REACH_VERSION;
var CONNECT_DEEP_LINK_SCHEME2 = "vibestudio:";
var CONNECT_DEEP_LINK_HOST = "connect";
var PAIR_LINK_ORIGIN2 = "https://vibestudio.app";
var PAIR_LINK_PATH2 = "/p";
var WORKSPACE_ROUTE_PREFIX = "/_workspace/";
function connectPairingFromLink(link) {
  const { kind: _kind, ...pairing } = link;
  return pairing;
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
function isLoopbackHost(host) {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}
export {
  CONNECT_DEEP_LINK_HOST,
  CONNECT_DEEP_LINK_SCHEME2 as CONNECT_DEEP_LINK_SCHEME,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIR_LINK_ORIGIN2 as PAIR_LINK_ORIGIN,
  PAIR_LINK_PATH2 as PAIR_LINK_PATH,
  WORKSPACE_ROUTE_PREFIX,
  appendServerPath,
  connectPairingFromLink,
  createConnectDeepLink,
  createConnectLink,
  createConnectPairUrl,
  isLoopbackHost,
  isSelectedWorkspaceUrl,
  parseConnectLink,
  selectedWorkspaceNameFromUrl,
  selectedWorkspacePath,
  selectedWorkspaceUrl,
  serverAuthRouteUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcStreamHttpUrl,
  serverRpcWsUrl
};
