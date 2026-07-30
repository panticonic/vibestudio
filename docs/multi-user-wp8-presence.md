# WP8 — Presence: Two Separate Systems (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§9), consuming WP4 (session→user
aggregation) and WP6 (stable `user:<userId>` ids). Implements **two strictly separate**
presence systems — keeping them separate is the whole point.

Obeys the host-boundary invariants (`plan §0.1`) as its central design constraint:

- **9.1 Channel presence** is userland-only — the host never learns about channels (INV-1).
- **9.2 Workspace user presence** is a host surface built from the host's own session facts —
  never from channels (INV-2). The two are **never derived from each other**.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** (9.1) account-aggregated channel presence + status + last-seen, userland; (9.2)
a host `workspacePresence` service fed only by the session registry + verified `userId`, with
zero channel coupling.

**Out of scope (owned by other specs in this same cutover):** the session `userId` tagging
(WP4); human channel identity (WP6). The hub cross-workspace presence view **is in scope here**
and is built (§4.4); only channel-_derived_ cross-workspace presence is excluded (it would
violate INV-1).

**Exit criteria:**

1. Channel presence aggregates a user's multiple panels into one `user:<userId>` presence with
   `online|idle|away|offline` + last-seen — entirely in the channel layer.
2. A `workspacePresence.list()` + `workspace-presence-changed` event answer "who's in this
   workspace," fed **only** by the host session registry; it emits no channel data and imports
   no userland channel code (`pnpm check:host-boundary` green).
3. The two systems never reference each other.

---

## 2. The invariant, restated

|                      | 9.1 Channel presence                 | 9.2 Workspace user presence               |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| Question             | Who's in this _conversation_?        | Who's _connected to this workspace_?      |
| Owner                | userland channel DO                  | host session registry                     |
| Source               | open subscription response resources | live RPC connections + `subject.userId`   |
| Host knows channels? | **never** (INV-1)                    | n/a — no channels involved                |
| Emits                | presence envelopes in the channel    | `{userId, handle, online, lastSeen}` only |

**Transport/session liveness is the host's to surface (9.2); pubsub channel membership is
userland's alone (9.1).**

---

## 3. Channel presence (userland-only) — §9.1

Build on the existing userland foundation:

- join/leave/update presence envelopes — `publishPresenceEvent` (`channel-do.ts:592-615`);
- typing signals — `setTypingState` (`:1217`) → `broadcastPresenceSignal` (`:615`);
- one long-lived `subscribe` response per delivery session; body cancellation,
  abrupt transport close, and generation replacement all terminate that exact session.

Additions (all userland, in the channel DO / `agentic-core`):

- **Account aggregation.** Collapse a user's multiple live panel participants (all now
  `user:<userId>`, WP6) into **one** channel presence keyed by `user:<userId>`: online if any
  of that user's panels is in the roster. Computed **userland-side** from roster rows using
  the userId the host stamped on the caller (INV-3) — the host does not aggregate and does not
  see the channel (INV-1).
- **Status model.** `online | idle | away | offline` + optional custom status in presence
  metadata. `idle`/`away` derive userland-side from real channel activity —
  never from a periodic liveness signal or host signal.
- **Last-seen.** Persist last-seen on leave in the channel DO (today leave deletes the row),
  so an offline user still renders "last seen 5m ago." Add a `last_seen` column / retained
  presence row.
- **Whitelist.** Add `status`, `avatar`, `color` to the public-metadata whitelist
  (`workspace/packages/agentic-protocol/participant-ref.ts:17-26`) so presence status +
  personalization (WP6) surface without leaking private metadata.

---

## 4. Workspace user presence (host surface) — §9.2

A first-class, boundary-clean surface built from facts the host already owns.

### 4.1 Source of truth

The host session/connection registry: `ConnectionRegistry` (`rpcServer.ts:228-378`) and
`SessionRegistry` (`rpcServer/sessionRegistry.ts`), each tagged with the verified
`subject.userId` (WP4 §2). "User X is present in workspace W" ⟺ X has ≥1 live connection
attached to W's child process. This is transport liveness projected to the user level — a
fact the host may know and surface.

**One logical user, N live endpoints.** Presence is keyed on the **logical `user:<userId>`**,
not on individual devices/panels: a user with a phone and a laptop both connected is **one**
present user with `endpoints: 2`, going offline only when the last endpoint drops. WP4's
`usersByUserId` reverse index already collapses a user's many callerIds; WP8 reports the
logical user (optionally exposing the endpoint count), never N rows for one person.

### 4.2 The service

A new host service:

```ts
// src/server/services/workspacePresenceService.ts
interface WorkspacePresenceEntry { userId: string; handle: string; displayName: string; color?: string; online: boolean; lastSeen: number; endpoints?: number; }
workspacePresence.list(): WorkspacePresenceEntry[];
// event: "workspace-presence-changed" → WorkspacePresenceEntry[]
```

- Fed by connection add/drop and the session-TTL machinery (`sessionRegistry.ts:39-48`,
  `markConnected`/`markDisconnected`) via the WP4 `listUsersWithLiveConnections()` accessor.
  **Filter to human runtime kinds** (`shell`/`panel`/`app`) so agent/worker/DO deputies —
  which carry an inherited `userId` (WP0 §6) — do not appear as "people in the workspace"
  (WP4 §8-Q2). The **`system`** synthetic subject (WP0 §5.4) is excluded.
- Emits via `EventService` (`emit`, like `panel-tree-updated`), broadcast to the workspace's
  members (WP4). `lastSeen` from the last connection-drop time.
- **Handle/displayName/color/avatar are resolved live by reading the shared identity DB
  read-only (WP0 §3.7)** — `identityDb.resolveUsers(userIds)`. The child opens the hub-owned
  identity DB read-only (no RPC channel, no cache-replication, no HMAC grant); mutable profile
  fields come live from that read, not frozen anywhere. `UserSubject` itself carries only stable
  `{userId, handle}` (WP0 §3.1). This is host-owned identity data (INV-2-legal), and it
  references **no** channel (INV-1).
- **Emits ONLY** `{userId, handle, displayName, color, online, lastSeen}` — no channel, no
  conversation, no pubsub reference.

### 4.3 Boundary guard

`workspacePresenceService.ts` must not import or reference `workspace/` / `pubsub-channel` /
any channel concept. `scripts/check-host-workspace-imports.mjs` (`pnpm check:host-boundary`)
guards it. It reads the session registry and the WP0 §3.7 shared identity DB (read-only) only
(never a channel roster).

### 4.4 Hub cross-workspace view (built)

Because the hub routes user sessions to children, it answers "which workspaces is user X
connected to" from **its own routing table** (WP1 §5) — pure session facts, still no channels.
This is the only sanctioned cross-workspace presence, and it is **part of this cutover** (not
deferred). Children report their live sessions up to the hub for this aggregate (WP1 §5).

---

## 5. Consumers

- **Panel-forest UI (WP3):** renders "who's in this workspace" and colors/labels each user's
  tree band using `workspacePresence` (9.2) + WP6 personalization.
- **Chat UI:** renders channel presence (9.1) in the roster.
- The two surfaces are populated by two independent sources and must not be cross-wired (e.g.
  don't infer channel presence from workspace presence or vice versa).

---

## 6. Testing

- **Channel aggregation (9.1):** a user with two panels shows **one** `user:<id>` channel
  presence; closing one panel keeps them online; closing both → offline with last-seen.
- **Status:** idle/away derive from channel activity, userland-side, with no host input.
- **Workspace presence (9.2):** two users connect to a workspace; `workspacePresence.list`
  returns both online; disconnect → offline + `lastSeen`; `workspace-presence-changed` fires.
- **Separation:** a user present in a _channel_ but whose workspace-presence is computed only
  from sessions — killing the channel (userland) does not change 9.2; killing the connection
  (host) drives 9.2 while the routed response terminal independently releases 9.1.
- **Boundary:** `workspacePresenceService` imports no `workspace/`; `pnpm check:host-boundary`
  green; the emitted payload contains no channel fields.

---

## 7. File-change checklist

| File                                                       | Change                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `workspace/workers/pubsub-channel/channel-do.ts`           | account-aggregated channel presence keyed `user:<id>`; status model; last-seen persistence             |
| `workspace/packages/agentic-protocol/participant-ref.ts`   | `status`/`avatar`/`color` in public whitelist (`:17-26`)                                               |
| `workspace/packages/agentic-core/*`                        | roster→account presence projection                                                                     |
| `src/server/services/workspacePresenceService.ts`          | **new** host service + `workspace-presence-changed` event, session-registry fed, zero channel coupling |
| `src/server/rpcServer.ts` / `rpcServer/sessionRegistry.ts` | consume WP4 `listUsersWithLiveConnections()`; drive presence on connect/drop                           |
| `workspace/apps/shell/*`                                   | render workspace presence in the panel-forest UI                                                       |
| (guard) `scripts/check-host-workspace-imports.mjs`         | ensure the new host service passes                                                                     |

---

## 8. Decisions (resolved — nothing deferred)

1. **Idle/away thresholds:** idle after 5 min with no client activity; away after 30 min.
   Fixed constants (an operator setting, not a per-user preference).
2. **The hub cross-workspace presence view (§4.4) ships in this cutover** — it is built, not
   deferred (plan §13). It is session/routing-based and never touches channels.
3. **Last-seen retention:** a bounded window, after which the departed user drops from the
   presence surface (their account identity persists in the hub-owned identity DB).
