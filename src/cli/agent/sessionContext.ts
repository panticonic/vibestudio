import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient, shellCallerId } from "../rpcClient.js";
import { isValidSessionName, loadAgentSession } from "../sessionStore.js";
import { AuthError, CliError, StaleSessionError, UsageError } from "../output.js";
import type { FlagSpec, ParsedInvocation } from "../commandTable.js";
import {
  assertBindingWorkspace,
  findContextBinding,
  type ContextBinding,
} from "../contextBinding.js";

/**
 * Session/context scoping shared by the fs/vcs/eval command groups. Every
 * command targets one context and dispatches over one credential. The context
 * and credential are resolved once here, with an explicit precedence
 * (docs/claude-code-channels-plan.md §6.2, breaking change §9.3):
 *
 *   1. explicit `--context <id>` / `--session <name>` flags;
 *   2. ambient `VIBESTUDIO_CONTEXT_ID`, dispatched over the canonical CLI
 *      credential (it never supplies authentication);
 *   3. cwd-upward search for `.vibestudio-context.json` (stable workspace +
 *      context identity, dispatched over the canonical CLI credential);
 *   4. the named default session file.
 *
 * The returned `session` is a {@link ScopeIdentity}: a session-file loaded from
 * disk in tier 4, or a synthesized identity from the selected context and
 * credential in tiers 2/3 where no `AgentSession` file exists. All callers read
 * only the {@link ScopeIdentity} subset, so the shape is uniform across tiers.
 */

export const DEFAULT_SESSION = "default";

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
  description: "Context id to scope the operation to (overrides env/binding/session)",
};

/** Scope-selection flags every fs/vcs/eval command accepts. Spread into a
 *  command's `flags` array so `--session` and `--context` are both recognized. */
export const SCOPE_FLAGS: FlagSpec[] = [SESSION_FLAG, CONTEXT_FLAG];

/**
 * The identity a scoped command runs under. A loaded {@link AgentSession}
 * structurally satisfies this (tier 4); tiers 2/3 synthesize it from env / the
 * context binding.
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
   * device credential, `agent:<entityId>` for an agent credential). Channel
   * subscriptions bind their response resource to this authenticated delivery
   * identity; clients never assert a separate subscription session.
   */
  callerId: string;
}

export { findContextBinding };

/** A synthesized per-context scope key (stable across invocations for a context). */
function scopeKeyForContext(contextId: string): string {
  return `ctx:${contextId}`;
}

/** Load the canonical device or agent credential for workspace commands. */
function requireWorkspaceCredential(): NonNullable<ReturnType<typeof loadCliCredentials>> {
  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError("not signed in — pair a device or use a managed agent profile");
  }
  if (!creds.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return creds;
}

/**
 * Tier 3 — cwd-upward context binding, dispatched over the canonical CLI
 * credential. The binding is accepted only when its durable workspace id
 * matches the selected credential. Reachability always comes from that
 * credential's current Iroh/hub route.
 */
function resolveBindingScope(
  binding: ContextBinding,
  contextOverride: string | undefined
): SessionScope {
  const creds = requireWorkspaceCredential();
  try {
    assertBindingWorkspace(binding, creds);
  } catch (error) {
    throw new StaleSessionError(error instanceof Error ? error.message : String(error));
  }
  const contextId = contextOverride ?? binding.contextId;
  if (creds.kind === "agent" && contextId !== creds.contextId) {
    throw new StaleSessionError(
      `agent credential is bound to context ${creds.contextId}, not ${contextId}`
    );
  }
  const entityId = creds.kind === "agent" ? creds.entityId : scopeKeyForContext(contextId);
  const client = new RpcClient(creds);
  return {
    client,
    contextId,
    callerId: creds.kind === "agent" ? `agent:${creds.entityId}` : shellCallerId(creds.deviceId),
    session: {
      name: `context:${contextId}`,
      serverUrl: creds.url,
      entityId,
      contextId,
      scopeKey: scopeKeyForContext(contextId),
    },
  };
}

/** Explicit `--context <id>` over the canonical CLI credential. */
function resolveExplicitContextScope(contextId: string): SessionScope {
  const creds = requireWorkspaceCredential();
  if (creds.kind === "agent" && contextId !== creds.contextId) {
    throw new StaleSessionError(
      `agent credential is bound to context ${creds.contextId}, not ${contextId}`
    );
  }
  const entityId = creds.kind === "agent" ? creds.entityId : scopeKeyForContext(contextId);
  const client = new RpcClient(creds);
  return {
    client,
    contextId,
    callerId: creds.kind === "agent" ? `agent:${creds.entityId}` : shellCallerId(creds.deviceId),
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
  // Pairing is the prerequisite for session lookup. Checking it first avoids
  // sending a brand-new user through a misleading attach-then-not-paired chain.
  const creds = requireWorkspaceCredential();
  const session = loadAgentSession(name);
  if (!session) {
    throw new CliError(
      `no session named ${name} — run \`vibestudio agent attach ${name}\`, pass --context <id>, ` +
        `or run the command inside a folder created by \`vibestudio context mirror\``
    );
  }
  if (session.serverId !== creds.serverId || session.workspaceId !== creds.workspaceId) {
    throw new StaleSessionError(
      `session ${name} belongs to ${session.serverId}/${session.workspaceId}, but the stored ` +
        `credential targets ${creds.serverId}/${creds.workspaceId}`
    );
  }
  if (
    creds.kind === "agent" &&
    (session.entityId !== creds.entityId || session.contextId !== creds.contextId)
  ) {
    throw new StaleSessionError(
      `session ${name} does not match agent ${creds.entityId}/${creds.contextId}`
    );
  }
  return {
    client: new RpcClient(creds),
    contextId: session.contextId,
    session: { ...session, serverUrl: creds.url },
    callerId: creds.kind === "agent" ? `agent:${creds.entityId}` : shellCallerId(creds.deviceId),
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

  // Tier 1b: explicit context uses the canonical credential. Authentication
  // never comes from environment variables.
  if (explicitContext !== undefined) {
    return resolveExplicitContextScope(explicitContext);
  }

  // Tier 2: a managed launch may provide a non-secret context coordinate.
  const ambientContext = process.env["VIBESTUDIO_CONTEXT_ID"];
  if (ambientContext) {
    return resolveExplicitContextScope(ambientContext);
  }

  // Tier 3: a cwd-upward stable context binding over the canonical credential.
  const binding = findContextBinding();
  if (binding) {
    return resolveBindingScope(binding, undefined);
  }

  // Tier 4: the default named session file.
  return resolveSessionFileScope(DEFAULT_SESSION);
}
