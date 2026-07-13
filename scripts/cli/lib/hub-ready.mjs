import {
  normalizeFingerprint,
  parseConnectLink,
  parseSignalingEndpoint,
} from "./connect-grammar.generated.mjs";

const READY_KEYS = new Set([
  "mode",
  "gatewayUrl",
  "connectUrl",
  "rootInvites",
  "serverId",
  "serverBootId",
  "gatewayPort",
  "pid",
  "version",
  "workspaces",
]);
const INVITE_KEYS = new Set([
  "room",
  "fp",
  "sig",
  "v",
  "ice",
  "srv",
  "code",
  "deepLink",
  "pairUrl",
  "expiresInMs",
  "expiresAt",
  "serverId",
  "serverBootId",
]);
const INVITE_REQUIRED_KEYS = [...INVITE_KEYS].filter((key) => key !== "srv");
const WORKSPACE_KEYS = new Set(["workspaceId", "name", "lastOpened", "running", "ephemeral"]);

function objectRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, allowed, required, label) {
  const keys = Object.keys(value);
  const unsupported = keys.filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unsupported.join(", ")}`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertHttpUrl(value, label) {
  assertNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
}

function parseInvite(value, label, ready) {
  const invite = objectRecord(value, label);
  assertExactKeys(invite, INVITE_KEYS, INVITE_REQUIRED_KEYS, label);
  if (typeof invite.room !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(invite.room)) {
    throw new Error(`${label}.room has an unexpected format`);
  }
  if (typeof invite.fp !== "string" || !/^[0-9A-F]{64}$/.test(normalizeFingerprint(invite.fp))) {
    throw new Error(`${label}.fp must be a SHA-256 DTLS fingerprint`);
  }
  if (typeof invite.code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(invite.code)) {
    throw new Error(`${label}.code has an unexpected format`);
  }
  if (typeof invite.sig !== "string") throw new Error(`${label}.sig must be a string`);
  const signaling = parseSignalingEndpoint(invite.sig);
  if (signaling.kind === "error") throw new Error(`${label}.sig: ${signaling.reason}`);
  if (invite.v !== 2) throw new Error(`${label}.v must be 2`);
  if (invite.ice !== "all" && invite.ice !== "relay") {
    throw new Error(`${label}.ice must be all or relay`);
  }
  if (invite.srv !== undefined) assertNonEmptyString(invite.srv, `${label}.srv`);
  for (const [field, pattern] of [
    ["serverId", /^srv_[A-Za-z0-9_-]{24}$/],
    ["serverBootId", /^boot_[A-Za-z0-9_-]{24}$/],
  ]) {
    if (typeof invite[field] !== "string" || !pattern.test(invite[field])) {
      throw new Error(`${label}.${field} has an unexpected format`);
    }
    if (invite[field] !== ready[field]) {
      throw new Error(`${label}.${field} does not match the ready file`);
    }
  }
  for (const field of ["expiresInMs", "expiresAt"]) {
    if (!Number.isSafeInteger(invite[field]) || invite[field] <= 0) {
      throw new Error(`${label}.${field} must be a positive integer`);
    }
  }

  for (const [field, prefix] of [
    ["deepLink", "vibestudio://connect?"],
    ["pairUrl", "https://vibestudio.app/pair#"],
  ]) {
    const link = invite[field];
    if (typeof link !== "string" || !link.startsWith(prefix)) {
      throw new Error(`${label}.${field} is not the canonical pairing-link carrier`);
    }
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") throw new Error(`${label}.${field}: ${parsed.reason}`);
    if (
      parsed.room !== invite.room ||
      normalizeFingerprint(parsed.fp) !== normalizeFingerprint(invite.fp) ||
      parsed.code !== invite.code ||
      parsed.sig !== signaling.url ||
      parsed.v !== invite.v ||
      parsed.ice !== invite.ice ||
      parsed.srv !== invite.srv
    ) {
      throw new Error(`${label}.${field} does not match the invite coordinates`);
    }
  }
  return invite;
}

function parseWorkspace(value, index) {
  const label = `hub ready workspace ${index}`;
  const workspace = objectRecord(value, label);
  assertExactKeys(
    workspace,
    WORKSPACE_KEYS,
    ["workspaceId", "name", "lastOpened", "running"],
    label
  );
  assertNonEmptyString(workspace.workspaceId, `${label}.workspaceId`);
  assertNonEmptyString(workspace.name, `${label}.name`);
  if (!Number.isFinite(workspace.lastOpened) || workspace.lastOpened < 0) {
    throw new Error(`${label}.lastOpened must be a non-negative number`);
  }
  if (typeof workspace.running !== "boolean") throw new Error(`${label}.running must be boolean`);
  if (workspace.ephemeral !== undefined && typeof workspace.ephemeral !== "boolean") {
    throw new Error(`${label}.ephemeral must be boolean`);
  }
  return workspace;
}

/** Parse the one current hub process handoff. Old or extended shapes fail closed. */
export function parseHubReadyPayload(value) {
  const ready = objectRecord(value, "hub ready file");
  assertExactKeys(ready, READY_KEYS, [...READY_KEYS], "hub ready file");
  if (ready.mode !== "hub") throw new Error("hub ready file mode must be hub");
  assertHttpUrl(ready.gatewayUrl, "hub ready file gatewayUrl");
  assertHttpUrl(ready.connectUrl, "hub ready file connectUrl");
  if (typeof ready.serverId !== "string" || !/^srv_[A-Za-z0-9_-]{24}$/.test(ready.serverId)) {
    throw new Error("hub ready file serverId has an unexpected format");
  }
  if (
    typeof ready.serverBootId !== "string" ||
    !/^boot_[A-Za-z0-9_-]{24}$/.test(ready.serverBootId)
  ) {
    throw new Error("hub ready file serverBootId has an unexpected format");
  }
  assertNonEmptyString(ready.version, "hub ready file version");
  if (
    !Number.isSafeInteger(ready.gatewayPort) ||
    ready.gatewayPort < 1 ||
    ready.gatewayPort > 65_535
  ) {
    throw new Error("hub ready file gatewayPort must be an integer from 1 to 65535");
  }
  if (!Number.isSafeInteger(ready.pid) || ready.pid <= 0) {
    throw new Error("hub ready file pid must be a positive integer");
  }
  if (!Array.isArray(ready.workspaces))
    throw new Error("hub ready file workspaces must be an array");
  ready.workspaces.forEach(parseWorkspace);

  if (ready.rootInvites !== null) {
    const invites = objectRecord(ready.rootInvites, "hub ready file rootInvites");
    assertExactKeys(
      invites,
      new Set(["desktop", "mobile"]),
      ["desktop", "mobile"],
      "hub ready file rootInvites"
    );
    parseInvite(invites.desktop, "hub ready file rootInvites.desktop", ready);
    parseInvite(invites.mobile, "hub ready file rootInvites.mobile", ready);
  }
  return ready;
}
