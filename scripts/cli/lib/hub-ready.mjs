import { PAIRING_PROTOCOL_VERSION, parseConnectLink } from "./connect-grammar.generated.mjs";

const READY_KEYS = new Set([
  "mode",
  "gatewayUrl",
  "rootInvite",
  "serverId",
  "serverBootId",
  "gatewayPort",
  "pid",
  "version",
  "buildId",
  "workspaces",
]);
const INVITE_KEYS = new Set([
  "endpointId",
  "relays",
  "v",
  "code",
  "exp",
  "deepLink",
  "pairUrl",
  "expiresInMs",
  "expiresAt",
  "serverId",
  "serverBootId",
]);
const INVITE_REQUIRED_KEYS = [...INVITE_KEYS];
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
  if (typeof invite.endpointId !== "string" || !/^[0-9a-f]{64}$/.test(invite.endpointId)) {
    throw new Error(`${label}.endpointId must be a canonical Iroh Endpoint ID`);
  }
  if (typeof invite.code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(invite.code)) {
    throw new Error(`${label}.code has an unexpected format`);
  }
  if (
    !Array.isArray(invite.relays) ||
    invite.relays.length < 1 ||
    invite.relays.length > 4 ||
    invite.relays.some((relay) => {
      try {
        const url = new URL(relay);
        return url.protocol !== "https:" || url.toString() !== relay;
      } catch {
        return true;
      }
    })
  )
    throw new Error(`${label}.relays must be one to four canonical HTTPS relay URLs`);
  if (invite.v !== PAIRING_PROTOCOL_VERSION) {
    throw new Error(`${label}.v must be ${PAIRING_PROTOCOL_VERSION}`);
  }
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
  for (const field of ["exp", "expiresInMs", "expiresAt"]) {
    if (!Number.isSafeInteger(invite[field]) || invite[field] <= 0) {
      throw new Error(`${label}.${field} must be a positive integer`);
    }
  }
  if (invite.exp !== invite.expiresAt) {
    throw new Error(`${label}.exp must match expiresAt`);
  }

  for (const [field, prefix] of [
    ["deepLink", "vibestudio://connect/"],
    ["pairUrl", "https://vibestudio.app/p#"],
  ]) {
    const link = invite[field];
    if (typeof link !== "string" || !link.startsWith(prefix)) {
      throw new Error(`${label}.${field} is not the canonical pairing-link carrier`);
    }
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") throw new Error(`${label}.${field}: ${parsed.reason}`);
    if (
      parsed.endpointId !== invite.endpointId ||
      JSON.stringify(parsed.relays) !== JSON.stringify(invite.relays) ||
      parsed.code !== invite.code ||
      parsed.exp !== invite.exp ||
      parsed.v !== invite.v
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
  if (typeof ready.buildId !== "string" || !/^[a-f0-9]{64}$/.test(ready.buildId)) {
    throw new Error("hub ready file buildId must be a lowercase SHA-256 digest");
  }
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

  if (ready.rootInvite !== null) parseInvite(ready.rootInvite, "hub ready file rootInvite", ready);
  return ready;
}
