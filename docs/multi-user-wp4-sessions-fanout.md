# WP4 — Sessions & Fan-out (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (esp. §2.5, §9.2, §10). Builds directly on
**WP0** (`docs/multi-user-wp0-user-identity-spec.md`): the host-verified `subject` on
`VerifiedCaller` is a precondition — WP4 reads `caller.subject.userId` and propagates it into
transport/session state and push routing. WP4 does **not** re-derive identity; it consumes it.

**The reframing this WP exists to honor:** within a workspace, users are **mutually trusted**
(`plan §2.3`, §5 "no further per-user gate"). So the existing broadcast fan-out of
panel-tree/logs/approvals is not a leak to be filtered — it is the _mutual-inspectability
feature_ (`plan §2.5`). WP4 therefore **keeps every intra-workspace broadcast unchanged** and
confines its changes to three things: (a) tag authenticated connections with `userId`; (b) fix FCM
push, which is machine-wide and must route per user/workspace; (c) expose a connection→user
aggregation accessor that **WP8**'s host `workspacePresence` service consumes.

Obeys the host-boundary invariants (`plan §0.1`): everything here is built from **host-owned
transport facts** (sessions, connections, device identity), never from userland channels
(INV-1); identity flows host→userland only (INV-3).

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** `userId` on `WsClientState`, populated from `caller.subject` at the auth choke
point; keeping `CallerSession` identity-free and caller-keyed; **threading `userId` to
userland** via `AuthenticatedCaller`, the
DO-dispatch envelope, and IPC/relay frames (the attribution plumbing WP0 §3.4 delegates here,
§2.4); a `userId` index/accessor on `ConnectionRegistry` alongside
the existing `callerId`-keyed maps; an explicit annotation that intra-workspace
`EventService.emit()` broadcast stays as-is; per-user/per-workspace FCM push routing with
`userId` on `PushRegistration`; exact per-device targeting; a pure transport-facts
`listUsersWithLiveConnections()` accessor for WP8.

**Out of scope (other WPs):** the `workspacePresence` host **service** + event and its UI
(**WP8**, which _consumes_ WP4's accessor); hub cross-workspace routing/presence (**WP1**);
the workspace **membership store** itself (**WP2** — WP4 depends on it for the push audience
but does not define it); approval-resolver provenance and `resolvedBy` capture (**WP5**);
channel presence/handles (**WP6**/**WP8(i)**, userland, untouched here).

**Exit criteria:**

1. Every live `WsClientState` carries a non-null `userId`, sourced only from
   `caller.subject.userId` (deputy callers inherit it via WP0 lineage; the in-process server
   maps to the synthetic system subject). `CallerSession` carries no account identity.
2. `ConnectionRegistry.listUsersWithLiveConnections()` returns exactly the set of users with
   ≥1 open connection to this workspace child — a pure transport fact, with **no** import of
   or reference to any userland channel concept (`pnpm check:host-boundary` green).
3. Intra-workspace broadcasts (`panel-tree-updated`, `workspace:unit-log`,
   `server-log:append`, `shell-approval:pending-changed`) are **unchanged** and still reach
   every connection in the child — proven by an existing-behavior regression test.
4. An approval push reaches only the devices of users who are **members of the emitting
   workspace**, never every device registered on the machine. Cancellation targets exactly
   the `{userId, clientId}` registrations that successfully received the prompt.
5. `PushRegistration.userId` is stamped from the host-verified `ctx.caller.subject`, never
   from client-supplied args; a test proves a spoofed `userId` in `push.register` args is
   ignored.

---

## 2. `userId` on connection & session state

### 2.1 `WsClientState.userId` (`rpcServer.ts:133-140`)

`WsClientState extends WsClientInfo` (`serviceDispatcher.ts:222-227`), and `WsClientInfo.caller`
is a full `VerifiedCaller` — so post-WP0 the userId is _already reachable_ as
`client.caller.subject?.userId`. WP4 promotes it to a first-class, denormalized field so the
hot presence/routing paths don't re-walk `subject` on every read and so a `undefined` subject
is caught once, at construction:

```ts
// rpcServer.ts:133-140
export interface WsClientState extends WsClientInfo {
  ws: WebSocket;
  authenticatedAt: number;
  userId: string; // NEW — mirror of caller.subject.userId, denormalized for indexing
  authorizedBy?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: ClientPlatform;
}
```

Populated at the single construction site (`rpcServer.ts:961-971`), right after
`verifiedCallerFor` resolves the caller (`:959`):

```ts
const caller = this.verifiedCallerFor(callerId, callerKind, agentBinding);
const client: WsClientState = {
  ws, caller, connectionId, authenticated: true,
  authenticatedAt: Date.now(),
  userId: caller.subject?.userId ?? assertBootstrapSubject(caller),  // NEW
  ...
};
```

`assertBootstrapSubject` returns the subject userId for the WP0 §5.4 enumerated bootstrap
principals (root/system) and **throws** for any other caller lacking a subject — the same
"no unattributed caller reaches steady state" discipline WP0 asserts at dispatch, now enforced
at connection admission.

### 2.2 `CallerSession` deliberately stays identity-free

The TTL-backed, inbox-holding `CallerSession` stays **`callerId`-keyed** and contains no
`userId`. Its inbox, pending responses, dirty flag, connection count, and expiry timer are
runtime-principal state. Account attribution belongs to an authenticated connection, where
the verified subject is available and can change independently across separately authorized
connections for a shared runtime principal. Duplicating `userId` on the caller-keyed session
would make that distinction ambiguous and create stale identity state.

`getOrCreate` and `markConnected` therefore continue to accept only `callerId` and
`callerKind`. Session expiry still emits a connection-change signal for the presence layer,
but the presence projection reads account identity from live `WsClientState` records, never
from `CallerSession`.

### 2.3 `ConnectionRegistry` — keep callerId maps, add a userId index

`ConnectionRegistry` keeps `clients`, `callerConnections`, `bridges`, and `transports` — all
routing, bridging, and primary selection stays callerId-scoped. The user reverse index is
maintained in lockstep with `addClient` and `removeClient`:

```ts
private usersByUserId = new Map<string, Set<WsClientState>>();
```

- `addClient` adds the concrete `WsClientState` to its user's set after the caller/connection
  map is updated.
- `removeClient` removes that exact state only when it is still the active state for the
  caller/connection pair, then drops an empty user set. A replaced socket therefore cannot
  remove its replacement from presence.

New read accessors (pure transport facts, consumed by WP8 §4):

```ts
listUsersWithLiveConnections(): string[];          // userIds with ≥1 OPEN connection
isUserOnline(userId: string): boolean;
getUserConnections(userId: string): WsClientState[]; // active state + OPEN socket only
```

`getUserConnections` requires both an OPEN socket and an exact match in `callerConnections`,
so a half-closed or superseded socket never reports as present.

### 2.4 Threading `userId` to userland — `AuthenticatedCaller` + DO envelope + IPC

WP0 §3.4 establishes that `caller.subject` reaches **in-process** host services but **not**
userland: the wire/DO caller type `AuthenticatedCaller` (`packages/rpc/src/types.ts:208`)
carries only `callerId`/`callerKind`/`callerPanelId`, and `authenticatedCallerOf`
(`serviceDispatcher.ts:212`) drops `code`/`agentBinding`. So a Channel DO, worker, or GAD sees
no `userId` today. WP0 explicitly delegates the plumbing to WP4. This is **attribution-grade,
not anti-spoof** (plan §0.0 — mutually trusted members): we carry the id so handles, presence,
and provenance work — not to defend members from one another.

Add `userId` to the three carriers that cross into userland:

```ts
// packages/rpc/src/types.ts:208 — the wire/DO caller
interface AuthenticatedCaller {
  callerId: string;
  callerKind: CallerKind;
  callerPanelId?: string;
  userId?: string;        // NEW — owning user, attribution only
}
// serviceDispatcher.ts:212 — authenticatedCallerOf now copies subject.userId through
authenticatedCallerOf(c: VerifiedCaller): AuthenticatedCaller {
  return { callerId: c.runtime.id, callerKind: c.runtime.kind,
           callerPanelId: c.code?.panelId, userId: c.subject?.userId };  // NEW
}
```

- **DO dispatch envelope** (`DOCallerEnvelope`, `doDispatch.ts:86`) gains `userId`, populated
  from the `AuthenticatedCaller` so a Channel DO / workspace DO handler reads
  `env.caller.userId` for attribution (WP6/WP7 message authorship, WP5 GAD actor).
- **IPC / relay stamping**: the parent↔child and worker IPC frames that already carry
  `callerId`/`callerKind` carry `userId` alongside. Same rule as everywhere: the **receiver**
  treats it as attribution metadata; it is **not** re-validated as a capability (a userland
  actor cannot widen a grant by presenting a `userId` — authority still gates on code identity,
  WP0 §6).
- **Clean cut:** no back-compat optionality games — every carrier gains the field in one change;
  a frame arriving without `userId` from a human caller is a construction bug, caught in tests
  (§6), not silently tolerated.

This is the single place the attribution id crosses the host→userland boundary, and it does so
as **data the host stamps** (INV-3: identity flows host→userland only), never as a client
assertion.

---

## 3. Broadcast model — confirmed correct, kept, annotated

**No delivery change.** This section is deliberately a _confirmation_, because the instinct to
"filter per user" would be a regression against the mutual-inspectability goal (`plan §2.3`,
§3).

`EventService.emit()` (`eventsService.ts:398-422`) fans an event to **every** subscribed
connection in the process. Because topology is **one process = one workspace**
(`plan §0` second finding), that fan-out is _already_ exactly "broadcast to all connections in
this workspace, and no further." Every load-bearing intra-workspace event rides it:

| Event                            | Call site                                                              | Why broadcast is correct                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `panel-tree-updated`             | `panelRuntimeRegistration.ts:356`                                      | The forest (WP3) is mutually inspectable; every user sees every user's trees.               |
| `workspace:unit-log`             | `index.ts:1464` (also `:1506,:2514`, `extension-host/service.ts:1668`) | Logs are a shared workspace surface.                                                        |
| `server-log:append`              | `serverLogService.ts:36`                                               | Host/server log is workspace-shared.                                                        |
| `shell-approval:pending-changed` | `approvalQueue.ts:353`                                                 | The queue is a single shared queue; **any** member approves, **all** consume (`plan §6.1`). |

**Rule for this WP (and a guard against future drift):** _no per-user filtering is added
inside a workspace child._ `emit()` stays a broadcast; the targeted variants that already exist
— `emitToCaller` (`eventsService.ts:425-444`) and `emitToConnection` (`:447-461`) — remain
reserved for genuinely point-to-point traffic (RPC responses, per-connection acks) and are
**not** repurposed to slice broadcasts by user. The one place per-user targeting is legitimate
is **off-box push** (§4), because that crosses the workspace boundary (machine-wide FCM),
which broadcast-within-a-process does not.

---

## 4. FCM push — per-user / per-workspace routing

### 4.1 Pre-cutover defect

The retired implementation stored a machine-wide, client-only registration set and broadcast
every approval and cancellation to every device. The cutover removes that API and persistence
shape completely. The current design is the exact-target model below; there is no blanket
broadcast entry point or reader for the former registration file.

### 4.2 Registration gains `userId` (host-verified)

```ts
// pushService.ts:18-23
export interface PushRegistration {
  token: string;
  platform: "ios" | "android" | "web";
  clientId: string;
  userId: string; // NEW — owning user, stamped from ctx.caller.subject (INV-3)
  registeredAt: number;
}
```

The `push.register` handler reads `ctx.caller.subject.userId` and stamps it on the registration
— **never** from the client's strict `register` args, which carry only
`token`/`platform`/`clientId`. A client-owned `userId` field is rejected by the service schema.
This is the INV-3 pattern and plain data hygiene (one source of truth for routing), not an
inter-user security boundary: the device asserts its FCM token, the host asserts _whose_ it
is.

Registrations live in the exact-schema SQLite database `server-auth/push.db`, keyed by
`(user_id, client_id)` with a globally unique FCM token. Moving a token between accounts
atomically deletes its former owner before the upsert. The server does not read or migrate the
retired JSON registration shape.

### 4.3 Routing API: exact `{userId, clientId}` targets

`PushServiceInternal` accepts an explicit per-device target snapshot:

```ts
interface PushDeliveryTarget {
  userId: string;
  clientId: string;
}

sendToTargets(
  targets: readonly PushDeliveryTarget[],
  opts: PushBroadcastOptions,
): Promise<PushSendResult[]>;

cancel(
  targets: readonly PushDeliveryTarget[],
  approvalId: string,
  cancelKey?: string,
): Promise<PushSendResult[]>;
```

- `send(userId, opts)` remains the single-registration primitive; the caller cannot address
  another user's registration by reusing a `clientId`.
- `sendToTargets` deduplicates exact target pairs, skips registrations removed concurrently,
  and returns `userId` + `clientId` on every result so callers can retain the successful
  subset.
- `cancel` accepts the same exact target shape. Membership or registration changes after a
  prompt cannot broaden its cancellation audience.
- There is no blanket or user-wide broadcast API.

### 4.4 The audience = members of the emitting workspace

`approvalPushBridge.sendApproval` computes the **workspace member audience**, snapshots the
currently registered `{userId, clientId}` targets for those members, and calls
`sendToTargets`. Because a child process _is_ one workspace, "the workspace's members" is the
natural audience for that child's approvals — every member may approve (`plan §6.1`), so
every member's devices may be notified, and **no non-member device is.**

The member roster is host-owned and lives in the hub-owned identity DB (**WP2**,
`WorkspaceMembership`). The child reads it through its read-only identity projection and
injects a small accessor rather than coupling the bridge to the membership store:

```ts
interface ApprovalPushBridgeDeps {
  ...
  workspaceMemberUserIds: () => readonly string[];   // NEW — this child's member userIds (WP2-backed)
}
```

The accessor includes root's implicit membership and reads the current roster on every send.
This is the real audience at cutover — there is no stub or live-connection subset. The
presence gate still suppresses pushes while a shell is actively watching.

The bridge retains only targets whose sends report `sent: true`. A later resolution cancels
that exact successful snapshot. Partial failures are retried only for registrations not yet in
the successful set; each retry re-reads membership and registrations, which also discovers
registrations written by another workspace process. If an approval resolves while a send is
in flight, the just-successful targets receive an immediate cancellation instead of being
orphaned.

---

## 5. Session→user aggregation for WP8 (groundwork only)

WP8's **workspace user presence** is a _host_ surface built from "who has a live connection to
this workspace child" (`plan §9.2`) — deliberately **not** from channels (INV-1). WP4 lays the
transport-fact groundwork WP8 consumes; it does **not** build the service, event, or UI.

- **Source of truth:** `ConnectionRegistry.listUsersWithLiveConnections()` / `isUserOnline()`
  (§2.3). Online state is a live-connection fact; `CallerSession` TTL preserves relay inbox
  state for reconnects but does not manufacture online presence. WP8 owns its separate
  last-seen retention window.
- **Change signal:** WP4 exposes an `onConnectionsChanged(listener)` hook fired from
  `addClient`/`removeClient` (and from session expiry) so WP8's `workspacePresence` can emit
  its `workspace-presence-changed` event without polling. WP4 provides the _hook_; WP8 owns
  the _service and event_.
- **Boundary discipline (INV-1/INV-2):** every accessor added here returns only
  `{userId}`-level transport facts. It must **not** import `pubsub-channel`, reference any
  channel/roster concept, or read any userland store — `pnpm check:host-boundary` guards this.
  Handle/displayName enrichment for the presence _payload_ is WP8's join against the host
  `UserStore` (host-owned identity, INV-2-legal), not WP4's concern.

> Line: WP4 surfaces _"user X has ≥1 connection to this child"_ (transport). WP8 turns that
> into _"user X is present in workspace W, shown as @handle"_ (presence surface). WP4 never
> reaches into channels; WP8 never reaches into channels either (§9.2).

---

## 6. Testing

- **UserId propagation:** on auth, assert `client.userId === client.caller.subject.userId`;
  a caller with no subject (outside the WP0 §5.4 set) fails admission via
  `assertBootstrapSubject`.
- **Index integrity:** open N connections for two users across three callerIds; assert
  `listUsersWithLiveConnections()` returns both; drop one user's last active connection and
  assert it leaves the set; prove a replaced or half-closed socket is excluded (§2.3).
- **Broadcast unchanged (regression):** two users, one workspace — emit `panel-tree-updated`
  and `shell-approval:pending-changed`; assert **both** users' connections receive both events
  (extends `eventsService.test.ts` patterns). This is the test that guards against an
  accidental per-user filter.
- **Push audience:** register devices for user A (member) and user B (non-member of workspace
  W); an approval in W pushes to A's device only, never B's; a machine with two workspaces does
  not cross-notify. Assert no blanket broadcast API exists.
- **Exact delivery lifecycle:** with two member devices and one partial send failure, retry only
  the outstanding target; after resolution, cancel only successful targets. Cover a concurrent
  registration write and the send/resolve race.
- **Push single-source:** the strict `push.register` schema rejects a client-supplied `userId`
  and the handler stamps `ctx.caller.subject.userId` — one source of truth for routing, not an
  inter-user boundary.
- **Attribution threading:** a Channel-DO / worker handler invoked by user A reads
  `env.caller.userId === A`; `authenticatedCallerOf` copies `subject.userId` through; a human
  caller whose frame lacks `userId` fails the construction assertion.
- **Session TTL unaffected:** the identity-free caller session still expires per
  `ttlMs[callerKind]` and keeps its inbox across a reconnect within grace.
- **Boundary:** `pnpm check:host-boundary` green — no new channel import from the registries or
  push path.

---

## 7. File-change checklist

| File                                                                    | Change                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/rpcServer.ts`                                               | Stamp `WsClientState.userId`; maintain a concrete-connection `usersByUserId` index; expose `listUsersWithLiveConnections`/`isUserOnline`/`getUserConnections`/`onConnectionsChanged` |
| `src/server/rpcServer/sessionRegistry.ts`                               | Keep `CallerSession` caller-keyed and identity-free; TTL/inbox semantics unchanged                                                                                                   |
| `packages/rpc/src/types.ts`, `packages/shared/src/serviceDispatcher.ts` | `AuthenticatedCaller.userId`; `authenticatedCallerOf` copies `subject.userId` — §2.4                                                                                                 |
| `src/server/doDispatch.ts` + worker/IPC frames                          | `DOCallerEnvelope.userId` and relay frames carry `userId` for userland attribution (§2.4)                                                                                            |
| `src/server/services/pushService.ts`                                    | Exact-schema `server-auth/push.db`; host-stamped registration ownership; `sendToTargets` and exact-target `cancel`                                                                   |
| `src/server/services/approvalPushBridge.ts`                             | Member-filtered registration snapshots; record successful targets; retry outstanding targets; cancel the exact delivered snapshot                                                    |
| `src/server/index.ts`                                                   | Inject the current workspace member user IDs, including implicit root membership                                                                                                     |
| `STATE_DIRECTORY.md`                                                    | Document `server-auth/push.db`; no retired JSON reader or migration                                                                                                                  |

---

## 8. Decisions (resolved — nothing deferred)

1. **Offline-member push audience: all workspace members.** An approval push reaches every
   member's devices whether or not they have a live connection — push exists precisely to
   reach absent humans. The audience is the current shared-DB member roster, read through the
   injected accessor. There is **no** live-connection subset and **no** stub.
2. **Non-human deputy sessions do not count toward workspace user presence.** Presence is
   human occupancy; WP8 filters to `shell`/`panel`/`app` runtime kinds when projecting. WP4
   stores the deputy's inherited `userId` regardless (for attribution); the filter is WP8's.
3. **Per-device push: both devices ring.** A user with two devices in one workspace gets a push
   on each — matches the mobile-notify intent. No coalescing to a primary.
