import * as fs from "node:fs";
import * as path from "node:path";
import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient, shellCallerId } from "../rpcClient.js";
import { isValidSessionName, loadAgentSession } from "../sessionStore.js";
import { AuthError, CliError, StaleSessionError, UsageError } from "../output.js";
import type { FlagSpec, ParsedInvocation } from "../commandTable.js";
import { normalizeServerBaseUrl, serverUrlsReferToSameBase } from "../serverUrl.js";

/**
 * Session/context scoping shared by the fs/vcs/eval command groups. Every
 * command targets one context and dispatches over one credential. The context
 * and credential are resolved once here, with an explicit precedence
 * (docs/claude-code-channels-plan.md §6.2, breaking change §9.3):
 *
 *   1. explicit `--context <id>` / `--session <name>` flags;
 *   2. env `VIBESTUDIO_CONTEXT_ID` (+ `VIBESTUDIO_AGENT_TOKEN` ⇒ the raw agent
 *      credential and `VIBESTUDIO_SERVER_URL`, caller kind `agent` — no device
 *      credential or session file is involved);
 *   3. cwd-upward search for `.vibestudio-context.json` (its contextId +
 *      serverUrl, dispatched over the paired device credential);
 *   4. the named default session file.
 *
 * The returned `session` is a {@link ScopeIdentity}: a session-file loaded from
 * disk in tier 4, or a synthesized identity (entity/scope from env or the
 * marker) in tiers 2/3 where no `AgentSession` file exists. All callers read
 * only the {@link ScopeIdentity} subset, so the shape is uniform across tiers.
 */

export const DEFAULT_SESSION = "default";

/** The host-owned per-context marker file written into every materialized
 *  context folder (WorkspaceVcs.ensureContextFolder). */
export const CONTEXT_MARKER_FILE = ".vibestudio-context.json";

/** Common --session flag for context-scoped commands. */
export const SESSION_FLAG: FlagSpec = {
  name: "session",
  takesValue: true,
  description: `Agent session name (default: "${DEFAULT_SESSION}")`,
};

/** Explicit --context flag: bind directly to a context id (tier 1). */
export const CONTEXT_FLAG: FlagSpec = {
  name: "context",
  takesValue: true,
  description: "Context id to scope the operation to (overrides env/marker/session)",
};

/** Scope-selection flags every fs/vcs/eval command accepts. Spread into a
 *  command's `flags` array so `--session` and `--context` are both recognized. */
export const SCOPE_FLAGS: FlagSpec[] = [SESSION_FLAG, CONTEXT_FLAG];

/**
 * The identity a scoped command runs under. A loaded {@link AgentSession}
 * structurally satisfies this (tier 4); tiers 2/3 synthesize it from env / the
 * context marker.
 */
export interface ScopeIdentity {
  /** Display name for the scope (session name, or a synthesized `context:<id>`). */
  name: string;
  /** RPC endpoint this scope targets. */
  serverUrl: string;
  /** Owner entity id for owner-scoped surfaces (eval). */
  entityId: string;
  /** The bound context id. */
  contextId: string;
  /** Persistent-scope key (eval subKey). */
  scopeKey: string;
}

export interface SessionScope {
  client: RpcClient;
  contextId: string;
  session: ScopeIdentity;
  /**
   * The server-derived principal this scope authenticates as (deviceId for a
   * device credential, `agent:<entityId>` for an agent credential). This is the
   * id the server routes push events to, so live subscribers (`channel tail`)
   * must subscribe under it for `channel:message` emits to reach them.
   */
  callerId: string;
}

/** Read + minimally validate a `.vibestudio-context.json` marker. */
interface ContextMarker {
  contextId: string;
  workspaceId?: string;
  serverUrl?: string;
}

function readContextMarker(filePath: string): ContextMarker | null {
  let parsed: Partial<ContextMarker>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ContextMarker>;
  } catch {
    return null;
  }
  const allowedKeys = new Set(["contextId", "workspaceId", "serverUrl"]);
  if (
    Object.keys(parsed).some((key) => !allowedKeys.has(key)) ||
    typeof parsed.contextId !== "string" ||
    parsed.contextId.length === 0 ||
    (parsed.workspaceId !== undefined &&
      (typeof parsed.workspaceId !== "string" || !parsed.workspaceId)) ||
    (parsed.serverUrl !== undefined && (typeof parsed.serverUrl !== "string" || !parsed.serverUrl))
  ) {
    return null;
  }
  return {
    contextId: parsed.contextId,
    ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    ...(parsed.serverUrl ? { serverUrl: parsed.serverUrl } : {}),
  };
}

/** Walk up from `start` (default cwd) looking for the nearest context marker. */
export function findContextMarker(start: string = process.cwd()): ContextMarker | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONTEXT_MARKER_FILE);
    if (fs.existsSync(candidate)) {
      const marker = readContextMarker(candidate);
      if (marker) return marker;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A synthesized per-context scope key (stable across invocations for a context). */
function scopeKeyForContext(contextId: string): string {
  return `ctx:${contextId}`;
}

/**
 * Tier 2 — env agent credential. `VIBESTUDIO_AGENT_TOKEN` selects the raw
 * `agent:<agentId>:<token>` credential and caller kind `agent`; scope comes
 * entirely from env (no device credential, no session file).
 */
function resolveAgentEnvScope(contextOverride: string | undefined): SessionScope {
  const token = process.env["VIBESTUDIO_AGENT_TOKEN"];
  if (!token) {
    // Caller only invokes this when a token is present; keep the guard honest.
    throw new CliError("VIBESTUDIO_AGENT_TOKEN is not set");
  }
  const rawUrl = process.env["VIBESTUDIO_SERVER_URL"];
  if (!rawUrl) {
    throw new AuthError(
      "VIBESTUDIO_AGENT_TOKEN is set but VIBESTUDIO_SERVER_URL is missing — cannot reach the workspace"
    );
  }
  const url = normalizeServerBaseUrl(rawUrl);
  const contextId = contextOverride ?? process.env["VIBESTUDIO_CONTEXT_ID"];
  if (!contextId) {
    throw new UsageError(
      "no context — set VIBESTUDIO_CONTEXT_ID (or pass --context <id>) alongside VIBESTUDIO_AGENT_TOKEN"
    );
  }
  const entityId = process.env["VIBESTUDIO_ENTITY_ID"] ?? scopeKeyForContext(contextId);
  const client = new RpcClient({ url, token });
  return {
    client,
    contextId,
    callerId: `agent:${entityId}`,
    session: {
      name: `agent:${contextId}`,
      serverUrl: url,
      entityId,
      contextId,
      scopeKey: scopeKeyForContext(contextId),
    },
  };
}

/** Load + validate the paired device credential (shared by tiers 3/4 and
 *  explicit `--context` without an agent token). */
function requireDeviceCredential(): NonNullable<ReturnType<typeof loadCliCredentials>> {
  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError(
      'not paired — run `vibestudio remote pair "vibestudio://connect?..."` first'
    );
  }
  if (!creds.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return creds;
}

/**
 * Tier 3 — cwd-upward context marker, dispatched over the paired device
 * credential. The marker names the context (+ optionally the server it belongs
 * to). A device credential is per-server, so we can only honor a marker whose
 * `serverUrl` matches the paired credential; a mismatch is refused rather than
 * silently dispatched to the wrong server. When the marker omits `serverUrl` we
 * fall back to the paired credential's url.
 */
function resolveMarkerScope(
  marker: ContextMarker,
  contextOverride: string | undefined
): SessionScope {
  const creds = requireDeviceCredential();
  if (marker.serverUrl && !serverUrlsReferToSameBase(marker.serverUrl, creds.url)) {
    throw new StaleSessionError(
      `context marker names server ${marker.serverUrl}, but the paired credential targets ${creds.url} — ` +
        "pair with that server, or pass --session/--context to override"
    );
  }
  const contextId = contextOverride ?? marker.contextId;
  const entityId = process.env["VIBESTUDIO_ENTITY_ID"] ?? scopeKeyForContext(contextId);
  const client = new RpcClient(creds);
  return {
    client,
    contextId,
    callerId: shellCallerId(creds.deviceId),
    session: {
      name: `context:${contextId}`,
      serverUrl: creds.url,
      entityId,
      contextId,
      scopeKey: scopeKeyForContext(contextId),
    },
  };
}

/** Explicit `--context <id>` over the device credential, when neither an agent
 *  token nor a marker applies. */
function resolveExplicitContextScope(contextId: string): SessionScope {
  const creds = requireDeviceCredential();
  const entityId = process.env["VIBESTUDIO_ENTITY_ID"] ?? scopeKeyForContext(contextId);
  const client = new RpcClient(creds);
  return {
    client,
    contextId,
    callerId: shellCallerId(creds.deviceId),
    session: {
      name: `context:${contextId}`,
      serverUrl: creds.url,
      entityId,
      contextId,
      scopeKey: scopeKeyForContext(contextId),
    },
  };
}

/** Tier 4 — the named session file. */
function resolveSessionFileScope(name: string): SessionScope {
  if (!isValidSessionName(name)) {
    throw new UsageError(`Invalid session name: ${name} (use letters, digits, "_", "-")`);
  }
  const session = loadAgentSession(name);
  if (!session) {
    throw new CliError(`no session named ${name} — run \`vibestudio agent attach ${name}\` first`);
  }
  const creds = requireDeviceCredential();
  if (session.serverUrl !== creds.url) {
    throw new StaleSessionError(
      `session ${name} was created for ${session.serverUrl}, but the stored credential targets ${creds.url}`
    );
  }
  return {
    client: new RpcClient(creds),
    contextId: session.contextId,
    session,
    callerId: shellCallerId(creds.deviceId),
  };
}

/**
 * Resolve the RPC client + context (+ owner identity) for an invocation,
 * applying the §6.2 precedence. See the module header for the tiers.
 */
export function resolveSessionScope(inv: ParsedInvocation): SessionScope {
  const explicitSession =
    typeof inv.flags["session"] === "string" ? inv.flags["session"] : undefined;
  const explicitContext =
    typeof inv.flags["context"] === "string" ? inv.flags["context"] : undefined;

  // Tier 1a: an explicit --session forces the named session file (§9.3).
  if (explicitSession !== undefined) {
    return resolveSessionFileScope(explicitSession);
  }

  // Tier 2: an env agent token selects the agent credential + env scope. An
  // explicit --context (tier 1) only overrides WHICH context, not the credential.
  if (process.env["VIBESTUDIO_AGENT_TOKEN"]) {
    return resolveAgentEnvScope(explicitContext);
  }

  // Tier 3: a cwd-upward context marker over the device credential.
  const marker = findContextMarker();
  if (marker) {
    return resolveMarkerScope(marker, explicitContext);
  }

  // Tier 1b: an explicit --context with no token/marker → device credential.
  if (explicitContext !== undefined) {
    return resolveExplicitContextScope(explicitContext);
  }

  // Tier 4: the default named session file.
  return resolveSessionFileScope(DEFAULT_SESSION);
}
