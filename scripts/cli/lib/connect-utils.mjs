import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

// Standalone, dependency-free mirror of the WebRTC pairing grammar in
// packages/shared/src/connect.ts. This file must run under raw `node` with no
// workspace deps, so the logic is vendored here. connect.ts and this file are
// held in lockstep by the parity test in packages/shared/src/connect.test.ts —
// keep the create/parse/validate behavior byte-identical (any divergence is a
// pairing-security bug, e.g. an over-permissive loopback or fingerprint match).

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
export const PAIR_LINK_ORIGIN = "https://vibestudio.app";
export const PAIR_LINK_PATH = "/pair";
export const DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";
// Current room-per-invite pairing protocol. Parsers require this exact version.
const PAIRING_PROTOCOL_VERSION = 2;
const CONNECT_PARAMETER_KEYS = new Set(["room", "fp", "code", "sig", "v", "ice", "srv"]);

/** Strip colons/whitespace and upper-case a DTLS fingerprint for comparison. */
export function normalizeFingerprint(fp) {
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
    `ice=${encodeURIComponent(pairing.ice)}`,
  ];
  if (pairing.srv) params.push(`srv=${encodeURIComponent(pairing.srv)}`);
  return params.join("&");
}

export function createConnectLink(pairing, carrier = "scheme") {
  const params = encodeConnectParams(pairing);
  if (carrier === "https") return `${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}#${params}`;
  return `vibestudio://connect?${params}`;
}

export function createConnectDeepLink(pairing) {
  return createConnectLink(pairing, "scheme");
}

export function createConnectPairUrl(pairing) {
  return createConnectLink(pairing, "https");
}

export function parseConnectLink(rawUrl) {
  if (typeof rawUrl !== "string") return { kind: "error", reason: "Deep link must be a string" };
  const prefix = "vibestudio://connect";
  // The prefix must be followed by a real delimiter — otherwise
  // `vibestudio://connect-anything?…` would parse as a connect link (the host is
  // exactly `connect`, no more).
  const afterScheme = rawUrl.slice(prefix.length);
  const isSchemeLink =
    rawUrl.startsWith(prefix) &&
    (afterScheme === "" ||
      afterScheme[0] === "?" ||
      afterScheme[0] === "/" ||
      afterScheme[0] === "#");
  let rawParams;
  if (isSchemeLink) {
    const queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) {
      return { kind: "error", reason: "Deep link is missing pairing parameters" };
    }
    // Strip any `#fragment` so it can't fold into the last query value.
    const fragmentStart = rawUrl.indexOf("#", queryStart);
    rawParams =
      fragmentStart >= 0
        ? rawUrl.slice(queryStart + 1, fragmentStart)
        : rawUrl.slice(queryStart + 1);
  } else if (rawUrl.startsWith(`${PAIR_LINK_ORIGIN}${PAIR_LINK_PATH}`)) {
    let url;
    try {
      url = new URL(rawUrl);
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
      reason: `Old or unsupported pairing protocol version (expected v=${PAIRING_PROTOCOL_VERSION}); re-pair this device with a fresh link`,
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

  return {
    kind: "ok",
    room,
    fp,
    code,
    sig: sigParsed.url,
    v: PAIRING_PROTOCOL_VERSION,
    ice,
    srv: params.values.get("srv") || undefined,
  };
}

export function resolveSignalingUrl(options = {}) {
  const envKeys = options.envKeys ?? ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];
  const env = options.env ?? process.env;
  const candidates = [
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
export function parseSignalingEndpoint(raw) {
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

function parseQuery(raw) {
  const values = new Map();
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

function decodeQueryComponent(raw) {
  try {
    return { kind: "ok", value: decodeURIComponent(raw.replace(/\+/g, " ")) };
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
}

/**
 * Loopback-only cleartext gate (mirror of connect.ts isLoopbackHost). The data
 * plane no longer rides a cleartext LAN/Tailscale origin — remote is WebRTC
 * (DTLS-encrypted), local co-located mode is loopback. `10.0.2.2` is kept for
 * the Android emulator's host loopback alias.
 */
export function isLoopbackHost(host) {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}

export function printConnectBanner({
  title,
  invite,
  qrInvite = invite,
  deepLinkLabel = "Deep link",
  instructions = "Open the QR code with the Android camera. Vibestudio will confirm and save the connection.",
}) {
  for (const [label, value] of [
    ["invite.room", invite?.room],
    ["invite.fp", invite?.fp],
    ["invite.sig", invite?.sig],
    ["invite.code", invite?.code],
    ["invite.pairUrl", invite?.pairUrl],
    ["qrInvite.pairUrl", qrInvite?.pairUrl],
  ]) {
    if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  }
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Room:        ${invite.room}`);
  console.log(`  Fingerprint: ${invite.fp}`);
  console.log(`  Signaling:   ${invite.sig}`);
  console.log(`  Pair code:   ${invite.code}`);
  if (qrInvite.code !== invite.code) {
    console.log(`  QR code:     ${qrInvite.code}`);
  }
  console.log(`  ${deepLinkLabel}:  ${invite.pairUrl}`);
  if (qrInvite.pairUrl !== invite.pairUrl) {
    console.log(`  QR ${deepLinkLabel}:  ${qrInvite.pairUrl}`);
  }
  console.log();
  qrcode.generate(qrInvite.pairUrl, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}
