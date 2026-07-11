# WP2 — Workspace Membership Enforcement (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§2.3, Decision 2) and the WP1 control-plane
work. WP2 provides the **coarse membership entry gate** (one of the kept boundaries, plan
§0.0 boundary 1): root/admin grant each user access to specific workspaces, and a user's
session only reaches a workspace child if it is a member. This is _entry_ control, not
inter-user isolation — inside a workspace there is **no further per-user gate**; full mutual
inspectability (plan §2.3, §5). We keep it because "which workspaces may this person join" is a
real, useful boundary for a family/team, not because we distrust members once inside.

Builds directly on WP0: the `User`/`UserSubject`, the **shared hub-owned identity DB** (WP0
§2), the `MembershipStore` interface (WP0 §3.5), and the device→user FK (WP0 §3.2). WP2
implements `MembershipStore` as a table in that DB and wires the gate. Depends on WP0 + WP1.

Obeys the host-boundary invariants (plan §0.1): membership is a **host-owned** table (INV-2),
the gate consumes only host-verified `userId` (INV-3), and nothing here touches channels
(INV-1). `MembershipStore` lives in host/shared and never imports `workspace/`.

**Workspace identity note (corrected).** A workspace is **not** reliably keyed by its display
name: `deriveWorkspaceId` (`workspace/loader.ts:492-502`) returns the basename only under the
managed dir and the **absolute path otherwise**, and the on-disk path/name may change. So WP2
introduces an **opaque stable `workspaceId`** (`ws_<rand>`) minted once and recorded on the
registry `WorkspaceEntry`, decoupled from name and path (WP0 §3.5 delegates this to WP2/WP10).
Every membership row, gate check, and per-user scoping key uses this opaque id; the display
name is resolved from the registry for humans only.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** the opaque stable `workspaceId` on the registry; the concrete `MembershipStore`
as a **table in the shared identity DB** (hub writes, children read read-only); the
`hubControl.addWorkspaceMember`/`removeWorkspaceMember` RPC surface gated to root/admin and
`listWorkspaceMembers` readable by workspace members; the
membership entry gate — **authoritative at the child** (it reads the shared DB on connect, WP1
§3) with `hubControl.listWorkspaces`/`routeWorkspace` as a pre-filter; membership-filtered
listing; root-implicitly-all + invite-time initial memberships; cascade pruning
against the workspace registry and `revokeUser`.

**Out of scope (other WPs):** hub pairing/routing surface (WP1 — WP2 supplies the `has()`
predicate the hub filter and the child gate both call); per-user panel forest (WP3);
session/presence keyed on `userId` (WP4/WP8); role-gating of non-workspace capabilities and
relay auth (WP9). **No `ChildConnectionGrant` exists** (WP0 §3.6 / WP1 pivot) — there is
nothing to "refuse to mint"; the gate is the child's membership check.

**Exit criteria:**

1. A member reaches its workspace child; a non-member is refused `EACCES` at the child's
   membership check, and the hub omits the workspace from `hubControl.listWorkspaces` so it is never
   offered — no child is spawned for a non-member via `route`.
2. `hubControl.listWorkspaces` returns only the caller's workspaces; root sees all.
3. `addWorkspaceMember`/`removeWorkspaceMember` succeed for root/admin and return `EACCES`
   for `member` callers; `listWorkspaceMembers` is available to members of that workspace.
4. A freshly-invited user (WP0 `inviteUser({workspaces})`) can immediately reach exactly the
   invited workspaces and no others.
5. Revoking a user (WP0 `revokeUser`) and removing a workspace both drop the corresponding
   membership rows; `has()` stops returning true.
6. Every membership row is keyed by the **opaque `workspaceId`**, not the display name.
7. `pnpm check:host-boundary` stays green (`MembershipStore` never imports `workspace/`).

---

## 2. `MembershipStore` (implements WP0 §3.5)

New `packages/shared/src/users/membership.ts`. The `WorkspaceMembership` record and the method
list are **defined in WP0 §3.5** (`add` / `remove` / `list(userId)` / `listMembers(workspaceId)`
/ `has(userId, workspaceId)`); WP2 implements them as a **`membership` table in the shared
hub-owned identity DB** (WP0 §2/§7). The **hub opens it read-write** and is the sole writer;
**children open the same DB read-only** (WAL) and call `has()`/`listMembers()` directly for the
entry gate and push audience (WP1 §3, WP4 §4) — no separate `memberships.json`, no RPC channel,
no cache-replication. This is why membership works identically whether checked at the hub or the
child: there is one table, one writer, many readers.

```ts
// packages/shared/src/users/membership.ts
export class MembershipStore {
  constructor(
    private readonly db: IdentityDb, // shared DB; hub read-write, child read-only
    private readonly users: Pick<UserStore, "getUser">, // for the implicit-root rule
    private readonly now = () => Date.now()
  ) {}

  // writes (hub only; throw if the DB handle is read-only):
  add(userId: string, workspaceId: string, addedBy: string): WorkspaceMembership; // idempotent upsert
  remove(userId: string, workspaceId: string): boolean; // no-op for root
  removeWorkspace(workspaceId: string): number; // cascade: registry delete prunes rows
  removeUser(userId: string): number; // cascade: WP0 revokeUser prunes rows
  // reads (hub AND child):
  list(userId: string): string[]; // opaque workspaceIds this user may enter (root → caller resolves via registry)
  listMembers(workspaceId: string): WorkspaceMembership[];
  has(userId: string, workspaceId: string): boolean;
}
```

`workspaceId` everywhere is the **opaque stable id** (header note), never the display name.

- **`has()` — the load-bearing predicate.** Returns `true` when the user's role (via
  `users.getUser(userId)?.role`) is `"root"` **without a stored row** (root is implicitly a
  member of every workspace, WP0 §3.5), otherwise `true` iff a `{userId, workspaceId}` row
  exists. A `member`/`admin` needs an explicit row (admins manage membership but only _enter_
  workspaces they were added to — plan §5 table).
- **`add()` is idempotent** (upsert on `{userId, workspaceId}`, refresh `addedBy`/`addedAt`); it
  does **not** validate that `workspaceId` exists in the registry — existence is the registry's
  job (§6), membership is orthogonal. Adding a member to a not-yet-created workspace is allowed
  and simply becomes live when the workspace is created.
- **`list(userId)`** returns the stored opaque `workspaceId`s for a non-root user. Root is
  resolved by the _caller_ against the registry (root sees all), so `list()` for root returns its
  stored rows only and the listing path (§4) special-cases root — keeping `MembershipStore` free
  of a registry dependency (host-boundary-clean; the store imports neither `workspace/` nor
  `CentralDataManager`).

`MembershipStore` is constructed in the hub read-write (alongside the rest of the identity DB,
WP0 §7) and, in each child, read-only over the same DB file — the child uses only the read
methods for its entry gate (§4) and WP4's push audience.

---

## 3. Hub wiring & role resolution

`HubRuntimeState` (`hubServer.ts:55-75`) gains two fields:

```ts
membershipStore: MembershipStore;
userStore: UserStore; // WP0 owns construction; WP2 reads role for the gate
```

The hub RPC choke point already authenticates the bearer token to `{callerId, callerKind}` via
`tokenManager.validateToken` (`hubServer.ts:467`). WP2 adds a hub-side subject resolver — the
symmetric hub counterpart to the child's `UserSubjectSource` (WP0 §5.2), reusing the hub's
ownership of `DeviceAuthStore` + `UserStore`:

```ts
// hubServer.ts — resolve the acting user from an authenticated hub caller
function hubSubjectFor(state, caller: { callerId: string; callerKind: CallerKind }): UserSubject {
  if (caller.callerKind === "shell") {
    const deviceId = caller.callerId.slice("shell:".length); // shellCallerId(), auth/model.ts:69
    const userId = state.deviceAuthStore.userFor(deviceId); // WP0 §5.2 device→user FK
    const user = userId ? state.userStore.getUser(userId) : null;
    if (user && !user.revokedAt) return { userId: user.id, handle: user.handle, role: user.role };
  }
  throw authError("EACCES", "Caller is not a recognized user", 403); // no anonymous hub access
}
```

Two gate helpers built on it (both throw `authError("EACCES", …, 403)`):

- `requireRole(subject, "admin")` — passes for `root`/`admin`, rejects `member`. Replaces the
  legacy machine-`requireAdmin` (`hubServer.ts:126-129`) for the **user-facing** management RPCs
  (the admin-token path is retired as a human identity per WP1 / plan §2.2; the bare token stays
  only as local break-glass on the diagnostic auth routes, `handleAuthRoute:298-411`).
- `assertMember(state, subject, workspaceName)` — `if (!state.membershipStore.has(subject.userId,
normalizeWorkspaceName(workspaceName))) throw EACCES`.

---

## 4. RPC surface & route-boundary gate

All in `handleRpc` (`hubServer.ts:456-538`). Every branch first resolves
`const subject = hubSubjectFor(state, caller)`.

**Management RPCs (new, root/admin only).** Hang off the same dispatch as `auth.listDevices`
(`:519`) / `auth.revokeDevice` (`:530`):

| Method                                                           | Gate             | Effect                                                            |
| ---------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `hubControl.addWorkspaceMember({ userId/handle, workspace })`    | root/admin       | resolve `workspace`→opaque `workspaceId`, then add the membership |
| `hubControl.removeWorkspaceMember({ userId/handle, workspace })` | root/admin       | remove membership and close the user's child sessions             |
| `hubControl.listWorkspaceMembers({ workspace })`                 | workspace member | return the membership projection joined to live account profiles  |

(The client passes a human `workspace` identifier; the hub resolves it to the opaque
`workspaceId` via the registry — `normalizeWorkspaceName`/`WorkspaceEntry.workspaceId`,
`hubServer.ts:433` — and all rows are keyed by the opaque id.)

**The entry gate lives in two mutually-reinforcing places, one authoritative:**

1. **Authoritative — at the child, on connect.** The child already reads the shared identity DB
   to resolve the connecting device's `subject` (WP1 §3); it makes one more read,
   `membershipStore.has(subject.userId, thisWorkspaceId)`, and refuses `EACCES` if false. This
   is the real gate: it cannot be bypassed by any routing trick because it sits at the point of
   attach, and it reads the same table the hub writes.
2. **UX pre-filter — at the hub.** `hubControl.routeWorkspace` and the routed workspace gate
   `handleWorkspaceRoute` (`:432-446`) call `assertMember(state, subject, workspaceId)` before
   `ensureWorkspaceRuntime`, so a non-member never spawns a child and gets a clean early
   `EACCES` rather than a dangling connect. `hubControl.listWorkspaces` omits non-member workspaces so they
   are never offered.

There is **no grant to mint or refuse** (WP0 §3.6 / WP1 pivot). WP2's job is the `has()`
predicate plus the two call sites above. Because both the hub filter and the child gate read
one shared table, they cannot disagree.

**Membership-filtered listing.** The hub's list implementation takes the viewer:

```ts
function listWorkspacesForViewer(state, viewer: UserSubject): Array<Record<string, unknown>> {
  const all = state.centralData.listWorkspaces();
  const visible =
    viewer.role === "root"
      ? all // root: implicitly all (§2)
      : all.filter((e) => state.membershipStore.has(viewer.userId, e.workspaceId));
  // …existing ephemeral `dev` / bootstrap `default` synthesis, but only surfaced to members
  //   of those names (root always).
}
```

`hubControl.listWorkspaces` passes the resolved subject. Invite and device-pairing defaults
likewise resolve only from workspaces visible to the acting account.

---

## 5. Bootstrap & invite-time memberships

- **Root is implicitly a member of all** — handled entirely inside `has()`/the listing
  special-case (§2, §4); no rows are written for root, and `remove()` on root is a no-op. On a
  fresh install (WP0 §4 root bootstrap) the first user is root and can immediately select every
  workspace with an empty membership table.
- **Invited users get initial memberships.** WP0's `inviteUser({ handle, displayName, role,
workspaces })` (plan §2.3, WP0 §4 table) carries a `workspaces[]`. WP2 implements the effect:
  at invite time the hub calls `membershipStore.add(invitee.id, name, inviterUserId)` for each
  `name` in `workspaces[]`. Empty `workspaces[]` ⇒ the invitee is a member of nothing until an
  admin adds them (a valid "created but not yet placed" state). `pairDevice` (own-device, WP0 §4)
  adds a device to an existing user and touches **no** membership rows.

---

## 6. Interaction with the workspace registry (`CentralDataManager`)

`CentralDataManager` is a row-oriented wrapper over the hub-owned `server-auth/identity.db`.
The `workspaces` table is the **sole source of workspace existence** and mints the opaque
`workspaceId` on `addWorkspace` (a one-time `ws_<rand>`, stable across name/path changes).
Membership is an orthogonal table in the same exact-schema database, keyed by that opaque id.
There is no `data.json` registry or compatibility reader. The two tables join by
`workspaceId` in listing/gate paths. Consequences:

- **Existence vs. access are separate checks.** A membership row for a `workspaceId` the
  registry no longer has is inert; a registry workspace with no members is reachable only by
  root. Keying on the opaque id (not the name) means renaming or moving a workspace never
  silently transfers or drops access.
- **Cascade on delete.** `removeWorkspace` (`centralData.ts:136`, reached via
  `workspaceService.ts:581`) calls `membershipStore.removeWorkspace(workspaceId)`. Since the id
  is opaque and never reused, recreating a same-named workspace mints a fresh id and grants no
  stale access.
- **Cascade on user revoke.** WP0 `revokeUser` (WP0 §3.1, "cascades: revoke devices+memberships")
  calls `membershipStore.removeUser(userId)`.

---

## 7. Testing

- **Gate (child, authoritative):** member A ∈ {alpha} only — connecting to `alpha`'s child
  succeeds; connecting to `beta`'s child is refused `EACCES` at the child's `has()` check.
- **Gate (hub pre-filter):** `hubControl.routeWorkspace({workspace:"beta"})` for A
  short-circuits `EACCES` and spawns no `beta` child; `listWorkspaces` omits `beta` for A.
- **Opaque id:** rename `alpha`'s display name — A's membership (keyed on the opaque id) still
  grants entry; delete + recreate a same-named workspace mints a fresh id and grants A nothing.
- **Listing:** with A ∈ {alpha}, B ∈ {alpha,beta}, root — `hubControl.listWorkspaces` returns {alpha} for A,
  {alpha,beta} for B, and the full registry for root.
- **Management authz:** `addMember`/`removeMember`/`listMembers` succeed as root and as admin,
  return `EACCES` as `member`; role is read from the host-resolved subject, not any wire field.
- **Invite seed:** `inviteUser({workspaces:["alpha"]})` ⇒ invitee's first device can reach
  `alpha` and only `alpha`; empty `workspaces[]` ⇒ member of nothing.
- **Root implicit:** empty membership table, root reaches any workspace; `remove(root, …)` is a
  no-op; root never appears as a stored `listMembers` row yet is treated as present.
- **Cascade:** `removeWorkspace` drops rows; `revokeUser` drops the user's rows so `has()` flips
  to false.
- **Shared-DB consistency:** a hub `add()` is immediately visible to a child's read-only `has()`
  (WAL); a child write attempt fails (read-only handle).
- **Boundary:** `pnpm check:host-boundary` green — `membership.ts` imports neither `workspace/`
  nor `CentralDataManager`.

---

## 8. File-change checklist

| File                                                                 | Change                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/users/membership.ts`                            | **implement** `MembershipStore` over the shared identity DB (WP0 §3.5 methods) — hub read-write / child read-only, `has()` root rule, `list`, `listMembers`, `add`/`remove`, `removeWorkspace`/`removeUser` cascades; all keys are opaque `workspaceId` |
| `packages/shared/src/centralData.ts`, `packages/shared/src/types.ts` | mint + store opaque `WorkspaceEntry.workspaceId` at `addWorkspace`; `removeWorkspace` (136) triggers `membershipStore.removeWorkspace(workspaceId)` cascade (wired at `workspaceService.ts:581`)                                                        |
| `src/server/hubServer.ts`                                            | Resolve `workspace`→opaque id; implement typed `hubControl` membership methods; enforce member pre-filter on `routeWorkspace`; filter `listWorkspaces`; narrow invite defaults to visible workspaces                                                    |
| `src/server/index.ts` (child)                                        | child membership entry gate: `membershipStore.has(subject.userId, thisWorkspaceId)` on connect (reads the shared DB read-only)                                                                                                                          |
| `src/server/services/authService.ts`                                 | `inviteUser` seeds `membershipStore.add` per `workspaces[]`; `revokeUser` → `membershipStore.removeUser` (WP0 §3.1 cascade)                                                                                                                             |
| `STATE_DIRECTORY.md`                                                 | document the `membership` table in the shared identity DB (WP0 §2), not a separate file                                                                                                                                                                 |

---

## 9. Decisions (resolved — nothing deferred)

1. **Admin self-scope:** an `admin` manages membership for any workspace (`addMember` on any
   `workspaceId`), but only _enters_ workspaces it was added to. Manage ≠ enter (plan §5).
2. **Membership targets an existing workspace.** Because the row is keyed by the opaque
   `workspaceId` minted at `addWorkspace`, membership always references a workspace that
   already exists — there is no add-before-create ambiguity, and the store never needs to know
   the registry (host-boundary-clean). Invite-time memberships name existing workspaces.
3. **An admin removed from every workspace still administers** (invite/manage) but can enter
   none — membership governs _entry_, never _management_ role. This is intended.
