# WP9 — Trust Model Cleanup & Role Attenuation (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§5 the reworked trust model), building on
WP0 (`UserRole`, resolved live per §3.7), WP1 (hub pairing/routing director), WP2 (membership).
Replaces the current binary "paired = fully trusted" + machine-admin-token-as-root with
**role attenuation** on the caller's **live role** (`roleOf(subject.userId)`, §3).

Obeys the host-boundary invariants (`plan §0.1`): grants still bind to **code identity** —
role attenuation gates _host-administrative operations_, never the capability-grant matching.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** role-gate hub account/device administration (user-invite vs self-device-pair); retire
admin-token-as-human-root; make relay/dispatch authorization membership/role aware **at the
hub boundary** while staying permissive inside a child; enumerate role-gated host-admin ops;
derive git author from the acting user.

**Out of scope:** the `role` field + assignment (WP0); membership store (WP2); the hub
route-boundary mechanism (WP1/WP2).

**Exit criteria:**

1. Inviting a **user** requires root/admin; pairing one's **own device** requires only an
   authenticated member. The "every paired shell is fully trusted" rule is gone.
2. The machine admin token is no longer any human's identity — only a local diagnostic
   break-glass.
3. Inside a workspace child, callers remain mutually trusted (no per-user gate, permissive
   relay); the only per-user boundary is the coarse membership entry gate (child-enforced,
   hub-pre-filtered — WP2), and no revocation-epoch machinery is added.
4. Commits are authored by the acting user, not a hardcoded identity.

---

## 2. Trust decision

- `chromeTrust.ts` grants concrete platform principals only the platform capability
  `panel-hosting`. Pairing and account administration are not app capabilities.
- The machine **admin token** (`index.ts:2014-2039`, `centralAuth.ts`, `hubServer.ts:876-888`)
  is de-facto root — "one token per machine."
- Authorization keys on `callerKind` only: `checkServiceAccess` (`rpcServer.ts:1189`,
  `serviceDispatcher.ts:433-443`); relay auth is a permissive stub `checkRelayAuth`
  (`rpcServer.ts:2721` → `{ok:true}`).
- Git commits use a hardcoded author `Vibestudio Panel <panel@vibestudio.local>`
  (`packages/git/src/client.ts:778-781`).

---

## 3. Role-gate hub account/device administration

Split the single capability by intent, gated on the acting user's **role, resolved live**.

> **Role is not carried on the connection.** `UserSubject` holds only stable `{userId, handle}`
> (WP0 §3.1); `role` is mutable and is resolved **live** from the shared identity DB (WP0 §3.7)
> at the moment of the gate — `roleOf(caller.subject.userId)` — so a demotion/promotion takes
> effect immediately, without waiting for the user to reconnect. `isRootOrAdmin(subject)` below
> is shorthand for that live lookup, not a read of a frozen field. (These gates are host-side
> services with read access to the identity DB, so the lookup is a cheap local read.)

- **Invite a user** (`hubControl.inviteUser`, WP1 §6) — requires the caller's live role ∈ {root, admin}.
- **Pair your own device** (`hubControl.pairDevice`) — requires only an authenticated member
  (`subject` present).
- **Revoke** — a user may revoke their **own** devices; revoking **another user** or a user
  account requires root/admin (live role).

`capabilityAuthorizer.isRootOrAdmin(caller)` resolves the caller's live role. Pairing and
invite services check the role at the method; the platform-capability list contains only
genuinely platform-bound grants such as `panel-hosting`.

```ts
// pattern at inviteUser / revokeUser / addMember service methods:
if (!isRootOrAdmin(ctx.caller.subject)) throw capabilityError("EACCES", "requires admin");
// isRootOrAdmin resolves roleOf(subject.userId) live from the identity DB (WP0 §3.7)
```

---

## 4. Retire admin-token-as-root

- The admin token survives **only** as a local operator break-glass for diagnostic
  `admin-token` routes (`docs/routes.md` §Auth `"admin-token"` mode) — never an identity,
  never "root," never able to invite users or act as a human.
- Remove admin-token special-casing from the human-facing paths: `index.ts:2014-2039`,
  `centralAuth.ts`, `hubServer.ts:876-888`. Root is a `User` (WP0 §4). (Final dead-code sweep
  in WP10.)
- `handleAuth` already rejects admin tokens for RPC (`rpcServer.ts:854`, close 4006) — keep
  that; admin token stays management-route-only.

---

## 5. Authorization: membership/role at the hub, permissive in the child

Be precise about **where** each check lives:

- **Membership entry gate (the coarse per-user boundary, plan §0.0 boundary 1):** a user
  reaches a workspace child only if `MembershipStore.has(userId, workspaceId)` (WP2), checked
  **authoritatively at the child** on connect (it reads the shared identity DB) with the hub's
  `hubControl.listWorkspaces`/`routeWorkspace` as a pre-filter (WP1 §3, WP2 §4). There is **no grant to mint** (WP0
  §3.6 / WP1 pivot). This is _entry_ control (which workspaces you may join), not inter-user
  isolation.
- **Inside a child:** callers stay **mutually trusted**. `checkServiceAccess`
  (`rpcServer.ts:1189`) stays kind-based for reachability; `checkRelayAuth`
  (`rpcServer.ts:2721`) stays permissive **within a workspace** (all members may relay to each
  other's runtimes — mutual invocation is the product, plan §0.0). No per-user wall is added
  inside a child, and we deliberately add **no** revocation-epoch / live-authority machinery —
  membership is checked at entry, not re-litigated per call.
- **Role gates apply only to host-administrative operations** (invite/revoke user,
  add/remove member, promote-to-admin, workspace create/delete) — a small enumerated set,
  evaluated on the caller's **live role** (`roleOf(subject.userId)` from the identity DB, §3),
  not a general per-method user check.

**Grant matching is untouched:** capability/credential/userland grants still key on code
identity `(callerId, repoPath, effectiveVersion)` (`docs/capability-approval-design.md:80-98`);
role never widens or fragments a grant. Role gates _who may invoke certain admin methods_,
orthogonal to _whether the code is approved_.

---

## 6. Enumerated role-gated host-admin operations

| Operation                                                 | Gate                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `hubControl.inviteUser`, `revokeUser`, `setRole`          | root/admin (setRole: root only; cannot demote root)                         |
| `hubControl.addWorkspaceMember` / `removeWorkspaceMember` | root/admin                                                                  |
| `workspace.create` / `delete` / `switchTo` config         | root/admin (was `requireWorkspaceApproval`; now also role-gated)            |
| `hubControl.pairDevice`, `updateProfile` (self)           | any member                                                                  |
| routine approvals (credential/capability/userland)        | **any member** — unchanged; the shared queue is explicitly cross-user (WP5) |

---

## 6.5 Revocation semantics (what `revokeUser` actually tears down)

`revokeUser` (root/admin) must be a **complete** teardown, not just flag-flipping the account.
The cascade, in order:

1. **Account + credentials.** `UserStore.revokeUser` sets `revokedAt`; `DeviceAuthStore`
   revokes **all** the user's devices (WP0 §3.1); outstanding refresh/shell tokens for those
   devices stop validating.
2. **Membership.** `MembershipStore.removeUser(userId)` drops every membership row (WP2 §6) in
   the shared identity DB, so any future `has()` — at the hub or at any child — is immediately
   false (one table, many readers).
3. **Live sessions (administrative teardown).** The entry gate is checked at _connect_, so a
   mid-session revoked user would otherwise keep their already-attached sessions until they
   disconnect. As an administrative completeness step (not an attacker race), on revoke the hub
   **closes** every live session for that user across all workspace children (it holds the
   routing table, WP1 §5) — children drop the connections; in-flight RPCs settle with
   `CONNECTION_LOST`.
4. **Running deputies.** Agents/workers/DOs the user spawned inherit their `userId` (WP0 §6)
   and would keep acting. On revoke, the owning workspace child **retires the revoked user's
   deputy entities** (reusing the existing `retireEntity` path, which already revokes agent
   credentials, `deviceAuthStore.revokeAgentCredentialsForEntity`) so no deputy keeps
   approving/committing "as" a revoked human.
5. **Userland artifacts.** The revoke is a write to the shared identity DB; children read it
   directly (WP0 §3.7 — no push protocol). Userland surfaces then react to the account being
   revoked: `channel_members` rows for the user are pruned (WP7), and the user's **panel
   trees** are handled per the tree-disposition decision below.

**Tree disposition on revocation (decision — promoted from WP3-Q3):** a revoked user's panel
trees are **archived** (soft-closed, recoverable by root), not deleted and not transferred —
so work isn't lost and no other user silently inherits another's surfaces. Root may reassign
or delete an archived tree later.

Revocation is thus a first-class operation with a defined blast radius; each step is tested
(§8). Un-revoke is out of scope (re-invite instead).

---

## 7. Git author from the acting user

- Replace the hardcoded `Vibestudio Panel <panel@vibestudio.local>`
  (`packages/git/src/client.ts:778-781`) with an author derived from `caller.subject`:
  `displayName <handle@vibestudio.local>` (or a real email if the account carries one).
- The acting user reaches the VCS layer via the caller subject; for agent/worker commits the
  owning user (WP0 §6 inheritance) is the author, with the agent noted in the commit
  metadata / GAD provenance (the on-behalf-of principal already modeled in the VCS invocation
  table). This makes workspace-source history attributable to humans.

---

## 8. Testing

- **Invite gating:** `inviteUser` as member → `EACCES`; as admin/root → succeeds.
  `pairDevice` as member → succeeds (own device); revoking another user's device as member →
  `EACCES`.
- **Admin token demoted:** admin token cannot invite users or act as a human; still opens a
  diagnostic `admin-token` route; still rejected for RPC auth.
- **Membership at hub, permissive in child:** a non-member can't attach (hub `EACCES`); two
  members in one workspace can relay to each other's runtimes (child permissive).
- **Grant unchanged:** a member (non-admin) can still approve a capability and have the grant
  reused cross-user — role does not touch grant matching.
- **Git author:** a commit made while acting as `@gabriel` is authored by Gabriel; an
  agent-of-Gabriel commit is authored by Gabriel with the agent in provenance.
- `pnpm quality:check` + `pnpm check:host-boundary` green.

---

## 9. File-change checklist

| File                                                                                   | Change                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/server/services/chromeTrust.ts`                                                   | keep only genuine platform grants                                                                         |
| `src/server/services/capabilityAuthorizer.ts`                                          | resolve the current account role for `caller.subject.userId`; `isRootOrAdmin` helper                      |
| `src/server/hubServer.ts`                                                              | role-gate invite/revoke/setRole; member-gate pairDevice                                                   |
| `src/server/index.ts`, `packages/shared/src/centralAuth.ts`, `src/server/hubServer.ts` | remove admin-token-as-human-root; keep diagnostic break-glass only                                        |
| `src/server/rpcServer.ts`                                                              | `checkRelayAuth` stays permissive intra-workspace (annotate); role gates only at enumerated admin methods |
| `src/server/services/workspaceService.ts`                                              | role-gate create/delete/switchTo config                                                                   |
| `packages/git/src/client.ts`                                                           | author from `caller.subject` (`:778-781`)                                                                 |
| `docs/routes.md`, `STATE_DIRECTORY.md`                                                 | admin token = diagnostic break-glass only                                                                 |

---

## 10. Decisions (resolved — nothing deferred)

1. **Roles: exactly one root + N admins.** Root promotes members to `admin`; there is no
   root-only-administration mode.
2. **The last root cannot be deleted or demoted** — the operation is blocked and documented.
3. **Git author email:** synthesized `<handle@vibestudio.local>`, overridden by a real commit
   email when the user has set one on their profile. Both the synthesis and the profile email
   field ship in this cutover.
