/**
 * `workspacePresence` service — WP8 §4 host workspace-USER presence.
 *
 * Answers "who is connected to THIS workspace" from facts the host already
 * owns: the live RPC connection registry, tagged with each caller's
 * host-verified `subject.userId` (WP4). "User X is present in workspace W" ⟺ X
 * holds ≥1 live HUMAN connection to W's child. This is transport liveness
 * projected to the user level — a fact the host may surface.
 *
 * ZERO channel coupling (INV-1/INV-2). This file imports NO `workspace/`,
 * pubsub-channel, roster, or conversation concept — `pnpm check:host-boundary`
 * guards it. Channel presence (§3, "who's in this CONVERSATION") is a wholly
 * separate userland system; the two are never derived from each other.
 *
 * Keying (WP8 §4.1): presence is the LOGICAL `user:<userId>`, not the device.
 * A person on a phone AND a laptop is ONE present user with `endpoints: 2`,
 * going offline only when the last live human connection drops. Only human
 * runtime kinds (shell/panel/app) count; agent/worker/do deputies carry an
 * inherited userId (WP0 §6) but are excluded, as is the synthetic `system`
 * subject (WP0 §5.4).
 *
 * Identity (WP8 §4.2): `handle`/`displayName`/`color` are resolved LIVE from
 * the shared identity DB (read-only, WP0 §3.7) on every read — never frozen —
 * so a profile edit re-renders everywhere. Attribution for a mutually-trusting
 * team, not a security boundary (plan §0.0).
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { IdentityDb } from "@vibestudio/identity/identityDb";
import type { WorkspacePresenceEntry } from "@vibestudio/shared/workspacePresence";
import { workspacePresenceMethods } from "@vibestudio/service-schemas/workspacePresence";

export type { WorkspacePresenceEntry } from "@vibestudio/shared/workspacePresence";

/**
 * The synthetic in-process principal (WP0 §5.4). It carries `userId: "system"`
 * so every ServiceContext has a subject, but it is NOT a person and is excluded
 * from presence. Kept as a local constant (not imported from rpcServer) so this
 * boundary-clean service pulls in no ws-server module.
 */
const SYSTEM_USER_ID = "system";

/**
 * Runtime kinds that represent a HUMAN at a client (WP8 §4.1, WP4 §8-Q2).
 * agent/worker/do are code deputies acting under an inherited userId — real,
 * but not "a person in the workspace"; server/extension are infrastructure.
 */
const HUMAN_KINDS: ReadonlySet<CallerKind> = new Set<CallerKind>(["shell", "panel", "app"]);

/**
 * How long a departed user lingers on the presence surface as `online: false`
 * with a last-seen time before dropping off entirely (WP8 §8 decision 3: a
 * bounded window; the account identity itself persists in the identity DB).
 */
const LAST_SEEN_RETENTION_MS = 5 * 60_000;

/**
 * Minimal projection of a live connection this service reads — just the owning
 * user and the runtime kind. Structurally satisfied by the host's
 * `WsClientState` so the RpcServer's connection accessors plug straight in,
 * while tests can pass plain objects.
 */
export interface PresenceConnection {
  readonly userId: string;
  readonly caller: { readonly runtime: { readonly id: string; readonly kind: CallerKind } };
  /** Principal that issued a panel/app connection grant (normally the device shell). */
  readonly authorizedBy?: string;
  /** Stable physical client session when the transport supplies one. */
  readonly clientSessionId?: string;
}

/**
 * The slice of the host connection registry (WP4) this service consumes. The
 * RpcServer instance satisfies it directly. Pure `{userId}`-level transport
 * facts — no channel/roster concept crosses this interface (INV-1).
 */
export interface PresenceConnectionRegistry {
  /** userIds with ≥1 OPEN connection (of any kind) to this workspace child. */
  listUsersWithLiveConnections(): string[];
  /** All OPEN connections owned by `userId`, flattened across its callerIds. */
  getUserConnections(userId: string): readonly PresenceConnection[];
  /** Fires on connection add/drop + session-expiry; returns an unsubscribe fn. */
  onConnectionsChanged(listener: () => void): () => void;
}

/** The identity read this service needs (shared DB, read-only — WP0 §3.7). */
export type PresenceIdentityResolver = Pick<IdentityDb, "resolveUsers">;

/**
 * The event sink — `EventService.emit` satisfies this for the
 * `workspace-presence-changed` event registered in `events.ts`.
 */
export interface PresenceEventSink {
  emit(event: "workspace-presence-changed", data: WorkspacePresenceEntry[]): void;
}

export interface WorkspacePresenceDeps {
  connectionRegistry: PresenceConnectionRegistry;
  identityDb: PresenceIdentityResolver;
  eventService: PresenceEventSink;
  /** Child→hub projection of ONLINE users only (WP8 §4.4). */
  onOnlineChanged?: (users: Array<{ userId: string; endpoints: number }>) => void;
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface WorkspacePresenceService {
  /** The RPC service definition to register with the dispatcher. */
  definition: ServiceDefinition;
  /** Current presence rows (live identity + live session facts). */
  list(): WorkspacePresenceEntry[];
  /** Stop reacting to connection changes (call on shutdown). */
  dispose(): void;
}

/** Internal per-user liveness state; identity is resolved lazily at read time. */
interface UserPresenceState {
  online: boolean;
  /** Live client/device endpoint count while online; 0 once offline. */
  endpoints: number;
  /** Epoch ms: "seen now" while online, frozen at drop time once offline. */
  lastSeen: number;
}

export function createWorkspacePresenceService(
  deps: WorkspacePresenceDeps
): WorkspacePresenceService {
  const now = deps.now ?? Date.now;
  const registry = deps.connectionRegistry;

  // Source of truth for `list()`/emit, updated only by `recompute()`.
  let states = new Map<string, UserPresenceState>();

  /** Live client/device endpoint count per online user (excludes system + deputies). */
  function computeOnline(): Map<string, number> {
    const online = new Map<string, number>();
    for (const userId of registry.listUsersWithLiveConnections()) {
      if (userId === SYSTEM_USER_ID) continue;
      const endpoints = new Set<string>();
      for (const conn of registry.getUserConnections(userId)) {
        if (!HUMAN_KINDS.has(conn.caller.runtime.kind)) continue;
        // Panels/apps spawned by a shell are another socket on the same physical
        // endpoint, not another device. Their grant issuer therefore collapses
        // with the shell runtime id. Standalone transports fall back to their
        // stable client-session id, then their caller principal.
        endpoints.add(conn.authorizedBy ?? conn.clientSessionId ?? conn.caller.runtime.id);
      }
      if (endpoints.size > 0) online.set(userId, endpoints.size);
    }
    return online;
  }

  /**
   * Rebuild `states` from the live registry. Online users are (re)stamped with
   * their current endpoint count + "seen now"; a user whose last human endpoint
   * just dropped flips to offline with `lastSeen` frozen at now; an
   * already-offline user is carried forward until the last-seen window elapses,
   * then dropped. Returns whether the presence SHAPE changed (membership /
   * online / endpoint count) — a bare `lastSeen` refresh does not emit.
   */
  function recompute(): boolean {
    const online = computeOnline();
    const t = now();
    const next = new Map<string, UserPresenceState>();
    for (const [userId, prev] of states) {
      if (online.has(userId)) continue; // (re)added from `online` below
      if (prev.online) {
        next.set(userId, { online: false, endpoints: 0, lastSeen: t }); // just dropped
      } else if (t - prev.lastSeen < LAST_SEEN_RETENTION_MS) {
        next.set(userId, prev); // still within the last-seen window
      }
      // else: window elapsed → drop from the surface
    }
    for (const [userId, endpoints] of online) {
      next.set(userId, { online: true, endpoints, lastSeen: t });
    }
    const changed = !sameShape(states, next);
    states = next;
    return changed;
  }

  /** Live-resolve identity and project `states` into wire rows. */
  function project(): WorkspacePresenceEntry[] {
    const userIds = [...states.keys()];
    const resolved = userIds.length > 0 ? deps.identityDb.resolveUsers(userIds) : new Map();
    const entries: WorkspacePresenceEntry[] = [];
    for (const [userId, state] of states) {
      const user = resolved.get(userId);
      const handle = user?.handle ?? userId;
      entries.push({
        userId,
        handle,
        displayName: user?.displayName ?? handle,
        ...(user?.color !== undefined ? { color: user.color } : {}),
        online: state.online,
        lastSeen: state.lastSeen,
        ...(state.endpoints > 0 ? { endpoints: state.endpoints } : {}),
      });
    }
    // Stable order: online first, then alphabetical by handle.
    entries.sort((a, b) => Number(b.online) - Number(a.online) || a.handle.localeCompare(b.handle));
    return entries;
  }

  function list(): WorkspacePresenceEntry[] {
    recompute(); // refresh from the live registry on read (no emit)
    return project();
  }

  function publishOnline(): void {
    const users = [...states]
      .filter(([, state]) => state.online && state.endpoints > 0)
      .map(([userId, state]) => ({ userId, endpoints: state.endpoints }));
    deps.onOnlineChanged?.(users);
  }

  const unsubscribe = registry.onConnectionsChanged(() => {
    if (recompute()) {
      deps.eventService.emit("workspace-presence-changed", project());
      publishOnline();
    }
  });
  recompute();
  publishOnline();

  const definition: ServiceDefinition = {
    name: "workspacePresence",
    description:
      "Who is connected to this workspace (WP8 §4 host presence — session-derived, zero channel coupling)",
    // Human-driven surfaces read presence (the panel-forest UI, WP3). Attribution
    // for a mutually-trusting team, not a security gate.
    authority: { principals: ["host", "user", "code"] },
    methods: workspacePresenceMethods,
    handler: defineServiceHandler("workspacePresence", workspacePresenceMethods, {
      list: () => list(),
    }),
  };

  return { definition, list, dispose: () => unsubscribe() };
}

/**
 * Shape equality ignoring `lastSeen` for online users: membership, `online`,
 * and `endpoints` decide whether to emit; a "seen now" refresh on an unchanged
 * online set must NOT trigger a broadcast (avoids emit storms), while a
 * retention drop (size change) or an online↔offline flip does.
 */
function sameShape(a: Map<string, UserPresenceState>, b: Map<string, UserPresenceState>): boolean {
  if (a.size !== b.size) return false;
  for (const [userId, sb] of b) {
    const sa = a.get(userId);
    if (!sa || sa.online !== sb.online || sa.endpoints !== sb.endpoints) return false;
  }
  return true;
}
