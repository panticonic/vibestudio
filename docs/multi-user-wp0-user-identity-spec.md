# WP0 — User-Identity Foundation (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md`. WP0 is the **keystone**: it introduces
the `User` principal and binds a **host-verified `subject`** onto every authenticated
connection, so that every `ServiceContext` downstream carries a `userId`. Nothing else in
the multi-user plan lands cleanly until this exists.

Pre-release, **clean cut**: no migration of the single-user device store — existing pairings
are discarded and re-paired against the new user-owning identity authority (§7).

Obeys the host-boundary invariants (`plan §0.1`): identity flows **host → userland only**
(INV-3); the `subject` is derived and stamped by the host, never accepted from the wire.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** the `User`/`Device`/`Membership` data model in one hub-owned identity DB; the hub
as the single identity **writer**, children reading it **read-only** to resolve the subject;
`subject` on `VerifiedCaller`; subject resolution at `handleAuth`; agent/worker/DO `userId`
inheritance; root bootstrap; role-attenuated invite vs self-device-pair.

**Specified elsewhere in this same cutover (division of authoring, not sequencing):** the hub
pairing/identity/membership director + signaling routing, children keeping their own ingress
(WP1); membership _enforcement_ UX and `hubControl.addWorkspaceMember` surfaces (WP2); panel-forest
ownership (WP3); fan-out/push routing + `userId`-to-userland threading (WP4); provenance
capture (WP5). All land together — nothing here waits on a later phase.

**Exit criteria:**

1. Every `ServiceContext` dispatched in a workspace child carries a non-null
   `caller.subject.userId` (except a small, enumerated set of pre-identity bootstrap
   principals — see §5.4).
2. A client cannot assert or alter its own `subject`; tests prove the wire value is ignored.
3. An agent/worker/DO resolves to the `userId` of the human that spawned its lineage.
4. Root bootstrap works on a fresh install; `inviteUser` is root/admin-only; `pairDevice`
   is any-member (own devices).
5. `pnpm check:host-boundary` stays green (the child never imports userland to resolve a
   user).

---

## 2. Identity authority: one hub-owned identity DB, read directly by children

Today identity is split and single-user: the hub holds a _central_ `DeviceAuthStore`, and
**each workspace child is spawned with its own** `{childStateDir}/auth/devices.json`
(`hubServer.ts` `buildWorkspaceChildEnv`), because a shared store "collided across
processes." That per-child device store is a single-user artifact and is **removed**.

**New model — one identity store, shared by trusted host processes.** Because the hub and
its workspace children are all **host processes owned by the same trusted OS user on one
machine** (plan §0.0), there is no trust boundary between them — so we do **not** build an
authenticated hub↔child identity protocol, cache-replication, or per-child signing keys.
Instead:

- Users, devices, invitations, and memberships live in **one hub-owned SQLite database**
  (`~/.config/vibestudio/server-auth/identity.db`, §7). SQLite gives real transactions
  (invite = user + membership + pairing atomically) and a single on-disk source of truth —
  cleaner than the multi-JSON-store-with-locks approach.
- The hub is the **writer** (all mutations: create/invite/revoke/pair/add-member go through
  the hub). Workspace children **open the same DB read-only** to resolve any `userId` →
  account or read their workspace's member roster. Same machine, same trusted user, host↔host
  — no RPC channel, no cache invalidation, no boundary crossing (it is host↔host, not
  host↔userland; the narrow-host boundary in §0.1 does not apply here).
- **Device→user:** a device belongs to a user; a user has server-wide identity.

**Connecting a user to a child:** the hub authenticates the remote device→user and directs
the client to the right workspace child (WP1); the child, on `handleAuth`, resolves the
connecting device's `userId` by reading the shared identity DB (`deviceAuthStore.userFor` →
the DB), then stamps the `subject`. No signed grant token, no HMAC — the child looks up the
authenticated device in the same store the hub wrote. (For remote WebRTC, the child owns its
own ingress per WP1; the device presents its existing device credential, which the child
validates against the shared DB exactly as the hub would.)

```
remote client ──(WebRTC to the child's ingress, device credential)──► workspace child
   child.handleAuth: validate device credential against shared identity DB
                     → device.userId → UserSubject{userId, handle} → VerifiedCaller.subject
   (the hub authenticated the user first and routed the client here — WP1)
```

> WP0 defines the identity DB schema, the `subject` on `VerifiedCaller`, and the child-side
> resolution (read-only DB access). WP1 wires the hub-side routing/direction. A test fake of
> the identity DB lets WP0 land and be verified before WP1.

---

## 3. Data model

### 3.1 `User` + `UserStore` (new, hub-owned)

```ts
// packages/shared/src/users/types.ts
export type UserRole = "root" | "admin" | "member";

export interface User {
  id: string; // "usr_<base64url18>"; the subject principal
  handle: string; // unique server-wide; /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, not reserved
  displayName: string;
  role: UserRole;
  avatarBlob?: string; // inline data: URI (optional personalization)
  color?: string; // hex tint for handle/presence (optional)
  createdAt: number;
  createdBy?: string; // inviting user id; null for root
  revokedAt?: number;
}

// UserSubject — the STABLE identity stamped on a connection (host-verified). Only
// immutable-ish fields: id + handle. MUTABLE personalization (displayName, avatar, color)
// and the CURRENT role are resolved LIVE from the shared identity DB (§3.7) so a rename,
// avatar change, or demotion is never stale on a long-lived connection.
export interface UserSubject {
  userId: string;
  handle: string;
}
```

Deliberately minimal: `displayName`/`avatar`/`color`/`role` are **not** snapshotted onto the
connection (that would go stale until reconnect). Anything mutable — including _self_ — is
resolved live from the shared identity DB via §3.7, keyed by `userId`. Handle is treated as
stable for the life of a session (renames take effect on reconnect; see WP6).

`UserStore` is a thin typed wrapper over the `users` table in the hub-owned SQLite identity DB
(§2) — hub-side, the hub being the sole writer. (It replaces the file-backed `DeviceAuthStore`
JSON shape at `deviceAuthStore.ts:82-330`, which becomes a table in the same DB.)

```ts
class UserStore {
  createRoot(input: { handle: string; displayName: string }): User; // only when no users exist
  inviteUser(input: {
    handle: string;
    displayName: string;
    role: "admin" | "member";
    createdBy: string;
  }): User; // root/admin only
  getUser(userId: string): User | null;
  getByHandle(handle: string): User | null; // uniqueness enforcement
  listUsers(): User[];
  setRole(userId: string, role: UserRole): void; // root only; cannot demote root
  updateProfile(userId: string, patch: Pick<User, "displayName" | "avatarBlob" | "color">): User;
  revokeUser(userId: string): boolean; // cascades: revoke user's devices+memberships
}
```

### 3.2 `DeviceRecord.userId` (extend existing)

```ts
// src/server/services/deviceAuthStore.ts:8-21 — add:
export interface DeviceRecord {
  deviceId: string;
  refreshTokenHash: string;
  userId: string; // NEW — owning user (FK to UserStore). Required going forward.
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  room?: string;
}
```

- `issueDevice` / `completePairing` (`deviceAuthStore.ts:145-181`) gain a required `userId`.
- `validateRefresh` (`:192-204`) already returns the `DeviceRecord`; callers now read
  `record.userId`.
- `isDeviceRecord` guard (`:340-350`) requires `userId: string`. Clean cut: records without
  it are dropped on load (they'll re-pair).

### 3.3 `AgentCredentialRecord.userId` (owning user for inheritance)

```ts
// deviceAuthStore.ts:30-40 — add userId; mintAgentCredential stamps the spawning user.
export interface AgentCredentialRecord {
  /* … */ userId: string;
}
export interface AgentBinding {
  /* … */ userId: string;
} // serviceDispatcher AgentBinding too
```

`mintAgentCredential` (`:230-252`) takes the spawner's `userId` (resolved from the caller
that requested the spawn) and stamps it; `validateAgentToken` (`:259-272`) returns it in the
binding; `handleAuth` promotes it to `subject`.

### 3.4 `VerifiedCaller.subject` (the load-bearing addition)

```ts
// packages/shared/src/serviceDispatcher.ts:181-191
export interface VerifiedCaller {
  runtime: { id: string; kind: CallerKind };
  code?: VerifiedCodeIdentity;
  agentBinding?: AgentBinding;
  subject?: UserSubject; // NEW — host-verified account. Absent only for §5.4 bootstrap principals.
}
```

`createVerifiedCaller(callerId, callerKind, code, agentBinding, subject?)` gains the param.
`ServiceContext.caller.subject` is then available to any **in-process** service. **But it
does not automatically reach userland**: the wire/DO caller type `AuthenticatedCaller`
(`packages/rpc/src/types.ts`) carries only `callerId`/`callerKind`/`callerPanelId`, and
`authenticatedCallerOf` (`serviceDispatcher.ts`) drops `code`/`agentBinding` too — so a
Channel DO, worker, or GAD sees no subject today. **WP4 threads `userId` through
`AuthenticatedCaller`, the DO-dispatch envelope, and IPC/relay stamping for _attribution_.**
This is deliberately attribution-grade, not anti-spoof (plan §0.0 — trusted members): we
propagate the id so handles/presence/provenance work, not to defend members from each other.

### 3.5 `WorkspaceMembership` (hub-owned; enforced in WP2, defined here)

Memberships are rows in the identity DB (§2/§7):

```ts
// conceptual row (identity.db `membership` table)
interface WorkspaceMembership {
  userId: string;
  workspaceId: string; // opaque stable id (see note)
  addedBy: string;
  addedAt: number;
}
// Queries: add / remove / list(userId) / listMembers(workspaceId) / has(userId, workspaceId)
```

Root is implicitly a member of every workspace (`has()` returns true for root without a row).

> **Workspace ids are opaque and stable — NOT the directory name.** `deriveWorkspaceId`
> (`workspace/loader.ts:492-502`) returns the basename only when the dir sits under the
> managed workspaces dir, and the **absolute path otherwise** — so "id == name" is false in
> general. Mint an **opaque stable `workspaceId`** (e.g. `ws_<rand>`) recorded once in the
> registry, decoupled from the display name and the on-disk path (which may change). Every
> `workspaceId` in this spec set — membership, `entities.owner_user_id` scoping, per-user
> context derivation — is this opaque id. WP2/WP10 own introducing it into the registry.

### 3.6 How a `userId` reaches a child (no grant token, no HMAC)

There is **no signed `ChildConnectionGrant`, no per-child key, no nonce** — that was
security machinery for a trust boundary that does not exist between the hub and its children
(plan §0.0). The device authenticates to the child (whose ingress it reached via the hub's
routing, WP1) with its **existing device credential**; the child validates that credential
against the **shared identity DB** (§2), reads the device's `userId`, and stamps
`UserSubject{userId, handle}` onto the `VerifiedCaller`. The hub's job was to authenticate
the user up front and point the client at the right child — not to mint a bearer of identity.

`handleAuth` (§5.1) gains one branch: after the existing device-credential validation, look
up `userId` for the device in the identity DB and attach the subject. Legacy in-process
`connectionGrants` (`packages/shared/src/connectionGrants.ts`) are untouched.

### 3.7 Child access to identity/membership — read the shared DB directly

Several child-resident features resolve **arbitrary** userIds (not just the connected one)
into account fields, or need a workspace's **member roster**:

| Consumer                   | Needs                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| WP8 §4 `workspacePresence` | every present userId → `{handle, displayName, color}`             |
| WP4 §4 push routing        | the workspace's member userIds (push audience)                    |
| WP5 §5 provenance render   | resolver/requester/other-user `handle` + device `label`           |
| WP6/WP3 render             | every tree-owner / roster participant → `{handle, avatar, color}` |
| WP7 §4 channel membership  | "is userId a member of this workspace" for an **offline** user    |

**Mechanism: the child opens the hub-owned identity DB read-only** and queries it directly —
`identityDb.resolveUsers(userIds)`, `identityDb.deviceLabels(deviceIds)`,
`identityDb.listMembers(workspaceId)`, `identityDb.isMember(userId, workspaceId)`. Same
machine, same trusted OS user, host↔host — no RPC channel, no cache-replication, no
invalidation protocol (all of which the trusted framing makes unnecessary complexity). SQLite
handles concurrent readers-with-one-writer natively (WAL mode), so a child always sees the
hub's committed writes. A thin in-child read cache is a pure performance option, not a
correctness requirement.

This is **host-side** data (accounts/devices/membership) read by a **host** child process —
it does **not** touch the host↔userland boundary (INV-1 concerns channels, not identity).
Userland (WP6/WP7) still receives only the specific projected fields the host passes down —
never a DB handle.

### 3.8 Avatar storage

`User.avatarBlob` is a small **inline `data:` URI** stored on the account row in the identity
DB (default — avatars are small; no separate blob store needed). A hub-owned blob store is a
later option only if large images are wanted. Children/panels get the avatar from the same
`resolveUsers` read (§3.7).

---

## 4. Root bootstrap

On hub first-run with an **empty `UserStore`**:

1. The hub creates a **pending root invite** and prints/QR-displays a pairing code (reusing
   today's startup pairing print, `hubServer.ts:902-903,1014`, and `mintPairingInvite`).
2. The first device to redeem it triggers `UserStore.createRoot({handle, displayName})`
   (handle/name supplied during the pair flow, or defaulted then editable), and the device
   is issued with `userId = root.id`, `role: "root"`.
3. Thereafter `createRoot` refuses (users exist); new humans arrive only via
   `inviteUser` (root/admin), which creates the `User` **and** a pairing code bound to that
   user; the invitee's first device redeems it and gets `userId = invitee.id`.

Distinguish the two invite intents over the existing `mintPairingInvite` machinery:

| Op                                                                 | Who        | Effect                                                                     |
| ------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------- |
| `hubControl.inviteUser({handle, displayName, role, workspaces[]})` | root/admin | new `User` + first-device pairing invite + initial memberships             |
| `hubControl.pairDevice()`                                          | any member | pairing invite bound to the **caller's own** `userId` (add a phone/laptop) |

`createPairingCode` (`deviceAuthStore.ts:115-132`) gains a `userId` binding on the
`PairingCodeRecord`; `completePairing` reads it so the issued device inherits the right user.

---

## 5. `handleAuth` changes (child side)

The single auth choke point (`rpcServer.ts:845-917`) resolves `subject` on every path, then
passes it to `verifiedCallerFor`. Precedence unchanged; each branch gains subject resolution:

### 5.1 Device credential against the shared identity DB (primary remote path)

Once WP1 routes the session to the right child, the device presents its **existing device
credential**; the child validates it and looks up the device's `userId` in the shared identity
DB (§2), then resolves `UserSubject{userId, handle}`. No grant token, no HMAC (§3.6) — the hub
authenticated the user and routed the connection; the child re-checks the device credential it
already understands and reads the account from the DB it already opens read-only.

### 5.2 Caller token

`tokenManager.validateToken(token)` (`:875`) yields `{callerId, callerKind}`. Resolve the
subject from the caller id via a new **`UserSubjectSource`**:

- `shell:<deviceId>` → `deviceAuthStore.userFor(deviceId)` → `UserStore.getUser`.
- `agent:<entityId>` → the agent binding's `userId` (§5.3).
- `panel:*` / `do:*` / `worker:*` → **inherit** via entity lineage (§6).

### 5.3 Pairing/agent credential redemption

`redeemPairingCredential(token, …)` (`:886`) return type (`rpcServer.ts:565-577`) gains
`subject`. For a device credential it's the device's user; for an `agent:` credential it's
`AgentCredentialRecord.userId` (already surfaced in the `AgentBinding`).

### 5.4 Bootstrap principals with no user (enumerated, allowed)

A tiny fixed set predates user identity: `electron-main`, `headless-host`, and the in-process
`server` principal. `server` resolves to a dedicated synthetic **`system`** subject
(`userId: "system"`, `handle: "system"`) that is **excluded** from account
joins and presence surfaces (WP8 §4, WP5 render) — it is not a real `UserStore` row.

`electron-main`/`headless-host` are the **local-console** principals, resolved by a
**trusted-console rule** (decided — §10.1):

- **The local desktop acts as the machine's root user.** Physical access to the loopback
  desktop = root, exactly like `sudo` on your own laptop (single-owner machine).
- **Shared-machine rule:** on a family/team machine where the physical console should _not_
  be blanket-root, the desktop presents a **real per-user device credential** (each human
  pairs their own desktop session as their user) rather than the bootstrap principal, carrying
  that user's `subject`; role attenuation (WP9) applies locally too. Both behaviors ship — the
  operator picks by whether the desktop presents a user credential.

Blanket-root is the trusted-console behavior; a shared machine uses per-user desktop
credentials. Both are built; neither is deferred.
The bootstrap list is closed and asserted in tests; no other caller may lack a subject.

### 5.5 Wiring

```ts
// verifiedCallerFor gains subject resolution:
private verifiedCallerFor(callerId, callerKind, agentBinding?, subject?): VerifiedCaller {
  const code = /* unchanged */;
  const resolved = subject ?? this.deps.userSubjectSource?.resolve(callerId, callerKind, agentBinding);
  return createVerifiedCaller(callerId, callerKind, code, agentBinding, resolved);
}
```

`userSubjectSource` is a new optional dep on `RpcServer` (hub-backed impl in prod; a fake in
tests). `handleAuth` passes the grant's `subject` when present (§5.1), else lets
`verifiedCallerFor` resolve it (§5.2/5.3).

---

## 6. Agent / worker / DO `userId` inheritance

Deputies must attribute to the human who spawned their lineage (so an agent's approval,
edit, or message is "by Gabriel"), **without** the human holding the connection.

- **Source of truth:** the entity launch lineage already recorded in `WorkspaceDO` —
  `entities.parent_id` (the verified caller that created the entity). Add `owner_user_id` to
  `entities` (also needed by WP3), stamped at `entityActivate` from the creating caller's
  `subject.userId`.
- **Resolution:** `UserSubjectSource.resolve` for `panel:/do:/worker:` walks
  `owner_user_id` (direct) — one lookup, no recursion needed since it's stamped at creation
  from the parent's subject. `resolveCodeIdentity` (`principalIdentity.ts:22-37`) is the
  existing sibling that already walks the `EntityCache`; add a parallel
  `resolveUserSubject(entityCache, callerId)` returning `UserSubject | null`.
- **Agent credentials** carry `userId` explicitly (§3.3), so `agent:` callers resolve
  without a lineage walk.

Result: authority still gates on **code identity** (unchanged, `plan §2.1` rule); `userId`
is attached purely for attribution/routing and never widens a grant.

---

## 7. Migration (clean cut)

- **Delete** per-child `{childStateDir}/auth/devices.json` provisioning in
  `buildWorkspaceChildEnv`; the child no longer has a device store.
- **Move** the authoritative `DeviceAuthStore` + new `UserStore`/`MembershipStore` to the
  hub state dir (`~/.config/vibestudio/server-auth/`).
- **No back-compat:** on first boot after the change, any pre-existing device store without
  `userId` is ignored (guard drops the records). The operator re-pairs: fresh root invite →
  root user → re-invite members. Documented in `STATE_DIRECTORY.md` and the remote-access
  skill. This matches the standing destructive-clean-cut convention (WorkspaceDO
  `schemaVersion` bump, `workspaceDO.ts:463`).
- Retire the **admin-token-as-human-root** path in the same change: the admin token remains
  only as a local operator break-glass for diagnostic routes (`routes.md` §Auth), never as
  an identity (WP9 completes role attenuation).

---

## 8. Testing

- **Subject universality:** integration test asserting every `ServiceContext` reaching
  `ServiceDispatcher.dispatch` has `caller.subject` set, except the §5.4 enumerated set
  (asserted by exact list).
- **Attribution source:** a client sending `subject`/`userId` in the envelope or auth fields
  has it ignored; the stamped subject comes only from the validated device credential →
  identity-DB lookup (mirror the existing `from`/`caller` tests, `rpcServer.ts:1864-1866`).
  This is a data-hygiene test (one source of truth for `userId`), **not** an inter-user
  anti-spoof boundary — members are mutually trusted (plan §0.0).
- **Identity-DB read:** a child resolves an arbitrary member's `{handle, displayName, color}`
  and a workspace roster by reading the shared identity DB read-only; a write attempt from a
  child fails (hub is the sole writer).
- **Inheritance:** an agent/worker spawned by user A resolves to `subject.userId === A`;
  changing A's device does not change the deputy's attribution.
- **Root bootstrap:** empty store → first pair creates root; second pair without an invite
  fails; `inviteUser` as member → `EACCES`, as root → succeeds; `pairDevice` as member →
  succeeds and binds to caller's userId.
- **Handle uniqueness:** duplicate handle rejected; reserved handles rejected
  (regex + reserved set from `pubsub-channel/types.ts:17`).
- **Boundary:** `pnpm check:host-boundary` green — `UserSubjectSource`/`UserStore` live in
  host/shared, never import `workspace/`.

---

## 9. File-change checklist

| File                                       | Change                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/users/types.ts`       | **new** — `User`, `UserRole`, `UserSubject`                                                                                                                             |
| `packages/shared/src/users/userStore.ts`   | **new** — hub `UserStore` (file-backed, atomic)                                                                                                                         |
| `packages/shared/src/users/membership.ts`  | **new** — `WorkspaceMembership` + store                                                                                                                                 |
| `packages/shared/src/serviceDispatcher.ts` | `VerifiedCaller.subject`; `createVerifiedCaller` param; `AgentBinding.userId`                                                                                           |
| `packages/shared/src/users/identityDb.ts`  | **new** — hub-owned SQLite identity DB; hub opens read-write, children open read-only (WAL)                                                                             |
| `src/server/services/deviceAuthStore.ts`   | `DeviceRecord.userId`, `AgentCredentialRecord.userId`, pairing-code `userId` binding, guards, issue/complete signatures                                                 |
| `src/server/services/auth/model.ts`        | `responseForCredential`/`DeviceCredentialResponse` carry `userId`; split invite intents                                                                                 |
| `src/server/hubServer.ts`                  | `hubControl.inviteUser` (root/admin), `pairDevice` (member), first-redemption root bootstrap; resolve current role from the identity DB                                 |
| `src/server/services/principalIdentity.ts` | **new** `resolveUserSubject(entityCache, callerId)` sibling to `resolveCodeIdentity`                                                                                    |
| `src/server/rpcServer.ts`                  | `userSubjectSource` dep; `handleAuth` device-credential→identity-DB subject on each path; `verifiedCallerFor` + `redeemPairingCredential` return `subject`              |
| `src/server/internalDOs/workspaceDO.ts`    | `entities.owner_user_id` (+ stamp at `entityActivate`)                                                                                                                  |
| `src/server/hubServer.ts`                  | remove per-child device store; hub owns the identity DB (`UserStore`/`DeviceAuthStore`/`MembershipStore`, hub-side minting is WP1); pass its read-only path to children |
| `STATE_DIRECTORY.md`                       | document the hub-owned identity DB + clean-cut re-pair                                                                                                                  |

---

## 10. Decisions (resolved — nothing deferred)

1. **Local desktop identity:** the loopback desktop acts as **root** (trusted-console
   assumption); a shared machine uses per-user desktop credentials so the physical console is
   not blanket-root (§5.4).
2. **Handle at invite time:** root proposes the invitee's handle; the invitee may change it on
   first connect (subject to uniqueness). Root sets role + memberships.
3. **Identity-DB path handoff:** the hub passes the child an explicit read-only identity-DB
   path in the spawn env (§3.7); the child never guesses the hub layout.
4. **Avatar storage:** inline `data:` URI on the account row (§3.8). No separate blob store.
