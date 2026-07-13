# Multi-User, Multi-Workspace, Multi-Session Server — Architecture Plan

**Status:** IMPLEMENTED design record. The account-backed multi-user workspace
hub cutover landed in `2a0adeee`; last reconciled 2026-07-13 against
`92e4aefe`. This document records the delivered architecture and its original
big-bang constraints.

**Delivery constraints (non-negotiable, govern every WP spec in this set):**

- **One big-bang cutover — not staged.** The whole set (WP0–WP10) is designed, built,
  reviewed, and merged as a **single simultaneous change**. There are **no phases, no
  milestones, no build order, no dependency gates, and no independently-shippable
  increments.** The "WP" labels are an authoring decomposition (who-touches-what), not a
  schedule. No WP is ever live while another is not.
- **No optionality, nothing deferred.** Every design choice is **decided** in these specs.
  There are no open questions, no "defaults pending confirmation," no feature flags, no
  "revisit later," and no stubs standing in for a not-yet-built WP — every WP's real
  implementation is present at cutover.
- **No backward compatibility, no legacy left standing.** Every single-user structure is
  **deleted outright, not adapted, wrapped, or kept behind a flag** — no dual-mode, no
  compatibility shim, no fallback to old behavior, no back-compat readers for old formats
  (§11). The code compiles and runs only in the new multi-user shape.

**Goals (verbatim intent):**

1. A **multi-user, multi-concurrent-workspace, multi-session** server, particularly the
   remote server.
2. Users are **mutually trusted** (a family / team). No complicated account system — a
   **root user** adds other users; auth stays trivial via the existing token/pairing
   system (the desktop-invites-mobile flow generalizes to invite-a-user).
3. **Multiple user-scoped panel trees in one workspace simultaneously**, with **mutual
   complete inspectability** — no trust boundary between users _inside_ a workspace.
4. An **approval provenance log** (emphasized) — plus a **shared approval queue**: any
   user in a workspace can approve any request; all users consume from the same queue.
5. **User-account personalization that propagates to handles** in the agentic messaging
   system, the ability to **add other users (humans) to channels**, and a **presence
   system**.

---

## 0. The one finding everything follows from

The codebase is, at the data-model layer, **partly user-shaped already** — but the
identity, auth, and runtime layers have **no authenticated user principal whatsoever**, and
the "user"-shaped slots that do exist mean something _different_ from an account.

- GAD (the durable knowledge/trajectory ledger) stamps `actor: ActorRef` on **every** log
  event, and its `ActorKind` union includes `"user"`
  (`workspace/workers/gad-store/index.ts:186-200`;
  `workspace/packages/agentic-protocol/src/events.ts:22-41`).
- The channel/messaging layer likewise has `"user"` as a first-class
  `ParticipantKind` / `SemanticParticipantKind` (`events.ts:32`), and a human is a
  legitimate roster participant today.
- **Caveat that shapes the whole design:** that `"user"` kind is a **semantic
  conversation role** — "a human authored this message" — **not an authenticated account**.
  There is no `userId`/account column anywhere. Authenticated account identity must be a
  _distinct new dimension_ carried alongside the semantic role (an actor `metadata.userId`
  and/or a new authenticated-principal binding), **not** a reuse of the semantic `"user"`
  kind — conflating them would corrupt existing transcript semantics.
- Yet the runtime principal is a flat 8-value enum with **no `user`** —
  `shell | panel | app | worker | do | extension | server | agent`
  (`packages/shared/src/principalKinds.ts:3-35`, `packages/rpc/src/types.ts:218-231`).
- A "user" today is a **paired device** (`shell:<deviceId>`,
  `src/server/hostCore/deviceAuthStore.ts:8-21`) or, de-facto, **the machine-wide admin
  token** (`src/server/index.ts:2014-2039`, "one token per machine, not per workspace").
- The product is explicitly single-user: _"whole-file last-writer-wins is accepted for
  this single-user product"_ (`src/server/index.ts:337-339`), and **every paired shell
  device is fully trusted** — it can invite and revoke any other device
  (`src/server/services/chromeTrust.ts:12-34`).

**Therefore the keystone of this entire plan is a single new concept — the `User`
principal — bound once at authentication and threaded through the existing seams.** Nearly
every downstream feature (per-user panel trees, provenance, handles, presence, channel
membership) is then a matter of attaching that verified account identity to structures that
already carry an `actor`/participant — not inventing a new event/graph substrate. The
account is a _new field on the existing actor_, layered beside the semantic `"user"` role,
never a reuse of it.

The second load-bearing finding: **multi-workspace already exists — as process
multiplication.** A loopback-only **hub** process spawns **one child server process per
workspace**, each with its own workerd, state dir, WebRTC ingress, and device-auth store
(`src/server/hubServer.ts:55-75,710-856`; child bind at `src/server/index.ts:341-387`).
The plan keeps that isolation model and **elevates the hub into the multi-user control
plane** rather than collapsing everything into one risky in-process multi-tenant server
(see §3, Decision 1).

### 0.0 Trust model — READ THIS FIRST (the environment these specs assume)

Vibestudio's multi-user server is a **trusted environment**: the users are a **mutually
trusting family or team**, added by a root user. This framing is load-bearing for every
design choice below, and reviewers must evaluate against _this_ threat model, not a
zero-trust one:

- **All userland is shared within a workspace.** Every member fully sees _and_ may act on
  every other member's panel trees, channels, logs, approvals, and runtimes. **Full mutual
  invocation is intended** — a member's agents/workers/DOs may drive another member's shell
  and panels. This is the product, not a leak. There is **no inter-user isolation, no
  confused-deputy defense, and no per-user authorization boundary inside a workspace.**
- **We do NOT build inter-user security hardening at this stage.** No anti-spoofing of
  identity between trusted members, no live-authority revocation races, no OS-level process
  sandboxing between same-machine trusted components, no tamper-proof audit chains. Such
  work would be premature complexity that narrows the product and dirties the code. `userId`
  exists for **attribution, personalization, presence, and provenance** — never as a
  security token between users.
- **The boundaries we DO keep** are exactly three, and they are about _clean architecture
  and external safety_, not inter-user distrust:
  1. **Workspace = OS-process isolation** — for fault containment and resource separation
     (Decision 1), and a coarse **membership** gate for _who may enter a workspace at all_.
  2. **The narrow host↔userland boundary** (§0.1, INV-1/2/3) — an architectural cleanliness
     boundary (host doesn't know userland concepts), **not** a user-vs-user boundary. Note:
     hub and workspace children are both _host_ processes on one trusted machine, so they may
     freely share host-owned stores — this is host↔host, not host↔userland.
  3. **The credential / approval out-of-band system** — the real security surface: gating
     **external** access (network egress, provider credentials) with user approval. This is
     the point of Vibestudio and stays first-class.

When a finding proposes defending trusted members from each other, or sandboxing trusted
same-user processes, it is **out of scope by design** — prefer the simpler, more open
implementation. When a finding is a genuine correctness/cleanliness/UX bug (a feature that
doesn't work, state that clobbers, a mechanism that doesn't exist), fix it — with the
_cleanest_ approach the trusted framing allows, which is usually simpler than a
security-hardened one.

### 0.1 Host-boundary invariants (stated once, enforced everywhere)

Vibestudio maintains a **narrow host boundary**: the native/server host does not know
userland concepts, and userland cannot manufacture host authority. This is guarded by
`scripts/check-host-workspace-imports.mjs` (`pnpm check:host-boundary`) and described in
`docs/narrow-host-boundary-refactor-plan.md`. Two multi-user features touch this boundary
directly; both were reshaped to respect it, and every downstream section obeys these
invariants:

- **INV-1 — The host never learns about channels.** Pubsub channels
  (`workspace/workers/pubsub-channel`) are userland. **Channel presence** and channel
  membership are computed _only_ in the userland channel layer (roster + heartbeat); the
  host/hub must never import, reference, or derive state from channels. A connected panel is
  its own channel-presence signal — no host involvement is needed or permitted (§9.1).

- **INV-2 — Host-owned truth stays in host-owned stores; userland truth stays in userland.**
  The host may surface facts it _legitimately owns_ — transport/session liveness, device and
  user identity, its own approval-queue decisions — but must not write that truth into a
  userland-owned store, nor read userland stores to reconstruct it. Consequences:
  - **Workspace user presence** ("who's connected to this workspace") is a **host** surface
    built from the host session registry + verified `userId` — _not_ from channels (§9.2).
  - The **host approval-queue provenance log** is **host-owned** (audits the host's own
    decisions); agent tool-call approvals stay in userland GAD; the unified view is a
    read-only union (§6.2).

- **INV-3 — Identity flows host → userland, never the reverse.** The one identity fact the
  host injects downstream is the **verified `subject` (`userId`/`handle`)** on a
  connection (§2.1). Userland consumes it (handles, presence aggregation, attribution) but
  can never assert or spoof it; the host derives it and stamps it, exactly as it does
  `code`/`agentBinding` today.

---

## 1. Current architecture (as-is), in one page

| Subsystem                  | Today                                                                                                                                                                                                                                                   | Key files                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Topology**               | Hub process (loopback) spawns 1 child server **process per workspace**; child binds one `workspace.config.id` for life via the process-global `setUserDataPath(workspace.statePath)` singleton. No in-process multi-tenancy.                            | `hubServer.ts`, `index.ts:341-387`, `packages/env-paths/src/index.ts:4-28`                                         |
| **Identity / auth**        | Device-scoped only. `DeviceRecord{deviceId, refreshTokenHash,…}` flat list, no owner. All devices equal + fully trusted. Admin token = de-facto root. No user/account subject anywhere.                                                                 | `deviceAuthStore.ts`, `authService.ts`, `chromeTrust.ts:12-34`, `principalKinds.ts`                                |
| **Sessions / connections** | One `RpcServer` per process. `ConnectionRegistry`/`SessionRegistry` keyed by **`callerId`** only. Multiple concurrent connections per caller already supported. `VerifiedCaller = {runtime{id,kind}, code?, agentBinding?}` — **no user field**.        | `rpcServer.ts:133-140,228-378`, `rpcServer/sessionRegistry.ts`, `serviceDispatcher.ts:181-191`                     |
| **Fan-out**                | `EventService.emit()` **broadcasts** panel-tree/logs/approvals to all subscribers; FCM `sendBatch()` pushes to all devices. Targeted variants (`emitToCaller`, `push.send`) exist but are barely used.                                                  | `eventsService.ts:398-461`, `pushService.ts:338`, `approvalPushBridge.ts:128`                                      |
| **Panel trees**            | One flat `slots` table in one per-workspace `WorkspaceDO`; null-parent slots collapse into **one** global tree, broadcast identically to all clients. No owner column anywhere.                                                                         | `workspaceDO.ts:335-345`, `panelManager.ts:1001-1011`, `panelRegistry.ts:102-107`                                  |
| **Approvals**              | Single shared in-memory queue (`approvalQueue`), one global instance. Grants keyed by **code identity** `(callerId, repoPath, effectiveVersion)`. **No resolver identity captured** — only an in-memory metric counter of decision×kind.                | `approvalQueue.ts`, `shellApprovalService.ts`, `capabilityGrantStore.ts`                                           |
| **Channels / handles**     | `PubSubChannel` DO: durable log (in GAD) + roster + calls. `"user"` is a valid participant kind, but every human panel joins hardcoded as handle `"user"`, name `"Chat Panel"`. Handles are **client-asserted** (spoofable). No channel membership/ACL. | `workspace/workers/pubsub-channel/channel-do.ts`, `agentic-chat/hooks/useAgenticChat.ts:224`, `useChatCore.ts:267` |
| **Presence**               | Real foundation exists: join/leave/update presence envelopes, typing signals, heartbeat eviction (5 min). No account aggregation, no online/idle/away model, no last-seen persistence.                                                                  | `channel-do.ts:592-615,945,1217,1777-1825`                                                                         |
| **GAD / provenance**       | Append-only, workspace-scoped, forkable, integrity-checked ledger. **Already stamps `actor: ActorRef` on every event, with `"user"` a valid actor kind.** Channel logs live here.                                                                       | `workspace/workers/gad-store/index.ts:186-200,404-445`                                                             |

---

## 2. Target architecture (to-be)

Four layers. The boundary that carries **security isolation** is the **workspace**; the
boundary that carries **attribution / personalization / presence** is the **user**. Inside
a workspace, users are mutually transparent by design.

```
                         ┌─────────────────────────────────────────────┐
                         │  HUB = multi-user CONTROL PLANE (one server)  │
   remote clients ──────►│  • WebRTC ingress (all remote reach)          │
   (WebRTC, per user)    │  • User/Account registry (root + invited)     │
                         │  • Device→User binding, refresh, invites      │
                         │  • Workspace registry + membership            │
                         │  • Routes an authenticated (user, workspace)  │
                         │    session to the right workspace child       │
                         └───────────────┬───────────────┬──────────────┘
                                         │ per (workspace) │  process boundary
                         ┌───────────────▼──────┐  ┌───────▼──────────────┐
                         │ Workspace child A     │  │ Workspace child B    │  ...
                         │ (isolation boundary)  │  │                      │
                         │ • N user-owned panel  │  │ • N user-owned panel │
                         │   trees (1 forest)    │  │   trees              │
                         │ • shared approval     │  │ • shared approval    │
                         │   queue + provenance  │  │   queue + provenance │
                         │ • channels + presence │  │ • channels + presence│
                         │ • GAD ledger          │  │ • GAD ledger         │
                         │ every caller carries  │  │                      │
                         │  a verified userId    │  │                      │
                         └──────────────────────┘  └──────────────────────┘
```

### 2.1 Identity layer — the `User` principal

Introduce a `User` / account entity that the whole system can attribute to. This is the
keystone; everything else depends on it.

```ts
// New: packages/identity/src/types.ts
interface User {
  id: string; // stable, e.g. "usr_<random>"; the principal subject
  handle: string; // unique, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, personalization anchor
  displayName: string; // "Gabriel Pickard"
  role: "root" | "admin" | "member";
  avatarBlob?: string; // blobstore digest (optional personalization)
  color?: string; // presence/handle tint (optional)
  createdAt: number;
  createdBy?: string; // inviting user id (null for root)
  revokedAt?: number;
}
```

- **Root** is bootstrapped at first server init (the human successor to today's machine
  admin token). Exactly one root; root may promote members to `admin`.
- A **device belongs to a user**: `DeviceRecord` gains `userId`
  (`deviceAuthStore.ts:8-21`). Pairing a device is a **self** action; **inviting a user**
  is a root/admin action. Both reuse the existing `mintPairingInvite` machinery
  (`auth/model.ts:122-151`), split by intent.
- The verified principal gains a **subject**:

```ts
// serviceDispatcher.ts:181-191 — extend VerifiedCaller
interface VerifiedCaller {
  runtime: { id: string; kind: CallerKind };
  code?: VerifiedCodeIdentity;
  agentBinding?: AgentBinding;
  subject?: { userId: string; handle: string }; // NEW — host-verified, never client-asserted; STABLE fields only (WP0 §3.1)
}
```

`subject` carries only the **stable** `{userId, handle}`; mutable personalization
(`displayName`, `role`, `color`, `avatar`) is **resolved live** from the shared identity DB
wherever it's rendered (WP0 §3.1/§3.7), never frozen onto the caller — so a profile edit
re-renders everywhere without re-stamping connections. `subject` is populated **once**, at the
single auth choke point `handleAuth` (`rpcServer.ts:845-917`), from whichever credential
authenticated: device→`userId` FK (looked up in the shared identity DB), agent→owning user. It
then rides `ServiceContext.caller.subject` into every service, exactly as `code`/`agentBinding`
do today. Agents and workers **inherit the `userId` of the human on whose behalf they were
spawned** (the launch-lineage `parentId` already threads this — `workspaceDO.ts` entities
carry `parent_id`), so an agent's actions are attributable to a user without the user
holding the connection.

> **Design rule (kept from today):** authorization _grants_ still bind to **code
> identity** `(callerId, repoPath, effectiveVersion)`, never to the user
> (`docs/capability-approval-design.md:80-98`). A grant approved by any user must satisfy
> a request from any device running that code version — that is exactly the "any user
> approves, all consume" semantic. `userId` is for **attribution and routing**, not for
> gating shared grants. (See §6.)

### 2.2 Control plane — elevate the hub

The hub becomes the single multi-user, remote-facing front door.

- **The hub is an identity/pairing/routing _director_, not a media relay.** Each workspace
  child **keeps its own WebRTC ingress** (the hub-as-answerer design was rejected —
  `webrtc-rpc-v2-plan.md:382-385` — and one `RpcServer` must own its DTLS pipe end to end,
  `rpcServer.ts:3292`). What makes a client pair **once, to the server (hub), as a user** —
  not per-workspace — is a **user-scoped device credential** validated against the hub-owned
  **shared identity DB** at whichever child the client reaches. The hub owns pairing/invites
  and tells the client which workspaces it may enter and how to reach the right child; the
  child re-validates the device credential and reads the account from the shared DB. **No
  HMAC grant token, no per-child grant key** — those were security machinery for a hub↔child
  trust boundary that does not exist (§0.0; both are host processes on one trusted machine).
- **Workspace discovery/reach is a session-level, in-band operation** for an
  already-authenticated user (`hubControl.listWorkspaces` → member set;
  `hubControl.routeWorkspace` → spawn child + return the stable control reach and selected
  workspace reach), replacing the reconnect-to-a-different-process dance. The
  hub's `HubRuntimeState.runtimes` map (`hubServer.ts:55-75`) already models "which workspace
  children are live"; the membership entry gate is enforced **authoritatively at the child**
  (it reads the shared DB on connect) with the hub's list/route as a pre-filter.
- **The machine admin token is retired as a human identity.** It survives only as an
  optional local operator break-glass for diagnostics (`admin-token` route mode,
  `routes.md` §Auth), never as "root". Root is a `User`.

### 2.3 Workspace membership (per-workspace, enforced) — _decided_

A `WorkspaceMembership(userId, workspaceId, addedBy, addedAt)` table in the hub-owned shared
identity DB, **enforced from day one**: root/admin explicitly grants each user access to
specific workspaces. `workspaceId` is an **opaque stable id** (`ws_<rand>`), not the display
name (WP2).

- **Root/admin manage membership** — `hubControl.addWorkspaceMember` /
  `removeWorkspaceMember`. Root is implicitly a member of every workspace. A newly-invited
  user starts with membership in whatever workspace(s) the inviting root/admin selects.
- **Coarse membership entry gate** — a user reaches a workspace child only if
  `WorkspaceMembership(userId, workspaceId)` exists, checked **authoritatively at the child**
  (it reads the shared DB on connect) with the hub's `hubControl.listWorkspaces` /
  `routeWorkspace` as a pre-filter
  (non-members get `EACCES` and no child is spawned). This is _entry_ control (which
  workspaces you may join), **not** an inter-user isolation wall (§0.0) — it is one of the
  three kept boundaries because "who may join" is genuinely useful for a family/team.
- **Inside the child: no further per-user gate** — every member of a workspace has full
  mutual inspectability _and mutual invocation_ of every other member's panel trees, channels,
  approvals, and logs. The membership boundary is _entry to the workspace_, not walls within it.
- **Workspace visibility in the control plane** — `hubControl.listWorkspaces` returns only
  the workspaces visible to the acting account; root sees all.

### 2.4 Per-user attribution inside a workspace

Inside a child, the workspace stays one trust domain. Add a `userId` **owner** dimension
for attribution and grouping only:

- **Panel trees → a forest.** Add `owner_user_id` to `slots` (and `entities`) in
  `WorkspaceDO` (`workspaceDO.ts:335-345`). `slotListOpen()` returns owner-tagged rows;
  tree reconstruction (`panelManager.ts:1001-1011`, `panelRegistry.ts:102-107`) groups
  null-parent slots into **N trees keyed by owner** instead of one. `Panel` /
  `PanelTreeSnapshot` (`packages/shared/src/types.ts:241,319`) gain an `owner`. The global
  broadcast is **kept** — it is exactly what mutual visibility wants; the change is
  _representational_ (render a forest, one section/column per user), not delivery.
- **Contexts salt on `userId`.** Context ids derived deterministically
  (`panelFactory.ts:199`, `index.ts:2295-2300`, `appHost.ts:2276-2301`) add a user salt so
  each user's panel/DO state folders are isolated on disk (avoids cross-user collision),
  while remaining fully _readable_ across users.
- **The build store needs no change** — content-addressed, naturally shared/deduped across
  users; two users on the same unit+version resolve to one build
  (`buildV2/buildStore.ts`, `effectiveVersion.ts:399-407`).

### 2.5 Fan-out becomes workspace-scoped, not user-scoped

Because one _hub_ now fronts many workspaces, the broadcast defaults must be scoped to
**the workspace**, not the user. Within a workspace, broadcast to all users is correct and
desired. Concretely:

- Child-local `EventService.emit()` already fans out to that child's connections only
  (one process = one workspace), so intra-workspace broadcast of `panel-tree-updated`,
  `workspace:unit-log`, `server-log:append`, `shell-approval:pending-changed` is **already
  correct** for the mutual-inspectability goal — **keep it.**
- **Push notifications route per member device.** The bridge snapshots registered
  `{userId, clientId}` targets for the current workspace members, records only successful
  deliveries, retries outstanding registrations, and cancels the exact delivered snapshot.
  There is no blanket machine-wide broadcast API.

---

## 3. Key design decisions (with rationale + alternatives)

**Decision 1 — Keep process-per-workspace; elevate the hub. (Recommended.)**
_Alternative:_ collapse to one in-process multi-tenant server. _Rejected because_ it
requires killing the load-bearing process-global `setUserDataPath` singleton
(`index.ts:387`, `env-paths/index.ts:4-9`), threading `workspaceId` through 26+ singleton
construction sites (`index.ts` §1 list), and namespacing/partitioning workerd DO storage
per workspace (`workerdManager.ts:1342`) — a large, risky refactor to obtain isolation we
already get **for free** from OS processes. Workspaces are a plausible real trust boundary
(different projects/sub-teams); process isolation is a feature. The genuinely-new work
(the user principal, per-user attribution, provenance) is identical under either topology,
so we spend effort there, not on a tenancy rewrite. From the user's perspective the **hub
is "the one server"**; the children are an implementation detail.

**Decision 2 — Per-workspace membership, enforced from day one.** _(Decided with user.)_
Root/admin explicitly grant each user access to specific workspaces; the hub route boundary
is the one hard per-user gate. Inside a workspace, members remain fully mutually
transparent. The alternative (flat server-wide access) was rejected in favor of explicit
control over who is in which workspace (§2.3).

**Decision 3 — Root/admin invites _users_; any user pairs their own _devices_.** Two
distinct operations over one `mintPairingInvite` mechanism. Retires "every paired shell is
fully trusted" (`chromeTrust.ts:12-34`) in favor of role attenuation.

**Decision 4 — `userId` is attribution/routing; grants stay code-identity-scoped.**
Preserves the confused-deputy protection in the capability model and makes "any user
approves, all consume" fall out naturally (§6).

**Decision 5 — The approval-provenance log splits by ownership (host-owned queue log +
existing GAD agent-approval projection).** GAD already journals _agent tool-call_ approvals
via `approval.requested`/`approval.resolved` + a resolve-once `trajectory_approvals`
projection (`gad-store/index.ts:1833-1846,4008-4056`) — keep that. The **host approval
queue** (credential/capability/userland) plus **membership governance** (invite/revoke/
add/remove/role) get a **host-owned transactional SQLite governance ledger** —
because writing host decisions into userland GAD would be a boundary inversion (INV-2). **No
hash chain / tamper-evidence** — the host is the sole trusted writer and the audience is
mutually-trusting members (§0.0); the log exists for _attribution_ ("who approved / who let
this person in"), not tamper-proofing. Both carry the resolving _account_; the "governance"
UX is a read-only union. A single **settlement coordinator** in the queue fixes the
delete-before-emit ordering so the live `resolvedBy` reaches listeners (§6.2, WP5).

**Decision 6 — Channel handles are principal-derived, not client-asserted.** The channel
DO stamps the human's stable identity (`user:<userId>`) from the verified caller (as
`sendAsCaller` already does, `channel-do.ts:1021-1041`) and renders mutable profile live from
the shared identity DB — so a person shows one reliable identity, not a self-declared label
that could drift between panels. This is _data hygiene / attribution_, not an inter-user
security boundary (§0.0, §8).

---

## 4. Concrete data-model & code changes (inventory)

| Area                        | Change                                                                                                                                                                                                            | Anchor                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **User entity**             | New `User`, `UserStore` (hub-owned, persisted), root bootstrap                                                                                                                                                    | new `packages/identity/src/`, hub                                                                 |
| **Device→User**             | `DeviceRecord.userId` FK; `issueDevice`/`completePairing`/`validateRefresh` carry user                                                                                                                            | `deviceAuthStore.ts:8-61`                                                                             |
| **Principal kind**          | Keep the 8 runtime kinds; add `subject.userId` to `VerifiedCaller` (do **not** add a `user` _runtime_ kind — humans still connect as `shell`/`panel`, now with a subject)                                         | `serviceDispatcher.ts:181-191`, `principalKinds.ts`                                                   |
| **Auth binding**            | Populate `subject` at `handleAuth` from each credential path; agents/workers inherit spawner's `userId` via `parentId` lineage                                                                                    | `rpcServer.ts:845-917`, `workspaceDO.ts` entities                                                     |
| **Membership**              | `WorkspaceMembership(userId, workspaceId)` on hub; route-time access check                                                                                                                                        | `hubServer.ts` route boundary                                                                         |
| **Panel forest**            | `slots.owner_user_id`, `entities.owner_user_id`; owner-tagged `slotListOpen`; group roots into forest; `Panel.owner` / `PanelTreeSnapshot` grouping                                                               | `workspaceDO.ts:335-345`, `panelManager.ts:1001-1011`, `panelRegistry.ts:102-107`, `types.ts:241,319` |
| **Context isolation**       | Salt deterministic context ids with `userId`                                                                                                                                                                      | `panelFactory.ts:199`, `index.ts:2295`, `appHost.ts:2276`                                             |
| **Approval provenance**     | Capture resolver `userId` from the authenticated `ServiceContext`; append through the hub-owned SQLite governance ledger (+ extend GAD projection for the agent-approval half); no acting-principal wire override | `shellApprovalService.ts`, `approvalQueue.ts`, `governance/*`, `gad-store/index.ts`                   |
| **Push routing**            | Member-filtered, exact `{userId, clientId}` snapshots; retry outstanding targets and cancel only successful deliveries                                                                                            | `approvalPushBridge.ts`, `pushService.ts`                                                             |
| **Handles**                 | Replace hardcoded `handle:"user"`; derive channel handle from verified subject; account→handle registry                                                                                                           | `useAgenticChat.ts:224`, `useChatCore.ts:267`, `channel-do.ts:644-793`                                |
| **Channel membership**      | Lightweight per-channel roster invite/notify; `participantKindFromMetadata` maps `user:` ids → `user`; `askUserPolicy` multi-user aware                                                                           | `channel-do.ts`, `participant-ref.ts:227`, `agent-loop/src/policies/index.ts:172`                     |
| **Channel presence**        | Account-aggregated presence + status model; add `status` to public whitelist; last-seen persistence — userland-only                                                                                               | `channel-do.ts:592-615,1777-1825`, `participant-ref.ts:17-26`                                         |
| **Workspace user presence** | New host `workspacePresence` service+event from live connections indexed by verified `userId`; `{userId,handle,online,lastSeen}`; **no** channel coupling                                                         | `rpcServer.ts` `ConnectionRegistry`, `workspacePresenceService.ts`                                    |
| **Trust cleanup**           | Retire admin-token-as-root; role attenuation replaces "all shells trusted"; `git` author derived from acting user                                                                                                 | `chromeTrust.ts:12-34`, `index.ts:2014-2039`, `packages/git/src/client.ts:778-781`                    |
| **Central data**            | `CentralData`/`WorkspaceEntry` gain owner/membership awareness; concurrency beyond whole-file LWW                                                                                                                 | `centralData.ts`, `workspace/types.ts:542-554`, `index.ts:337-339`                                    |

---

## 5. The reworked trust model

Replace the current binary "paired = fully trusted" + machine-admin-token-as-root with:

| Principal                       | Can                                                                                                                                                                  | Cannot                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Root user**                   | Invite/revoke users; promote members to admin; add/remove any user's workspace membership; member of every workspace; everything a member can                        | —                                                                                            |
| **Admin user**                  | Invite/revoke users; manage workspace membership; everything a member can                                                                                            | Demote root                                                                                  |
| **Member user**                 | Full participation in workspaces they're a **member** of; pair their **own** devices; approve **any** request in those workspaces; open/inspect any panel tree there | Invite other users; manage membership; act in / enumerate workspaces they aren't a member of |
| **Device (`shell:<deviceId>`)** | Acts as its owning user (`subject.userId`)                                                                                                                           | Exceed its user's role; invite users unless its user is root/admin                           |
| **Agent / worker / DO**         | Acts on behalf of its spawning user (inherited `userId`); grants still gated by **code identity**                                                                    | Manufacture authority by spawning a deputy (deputy has different code identity → re-prompts) |

- **Isolation boundary = workspace** (OS process). **Attribution boundary = user.**
- Hub account/device methods are **role-gated**: inviting users requires root/admin; pairing
  one's own devices requires only an authenticated member. Roles are resolved live from the
  hub identity database.
- The single dispatch choke point (`serviceDispatcher.ts:433-443`) and relay auth
  (`checkRelayAuth`, today a permissive stub at `rpcServer.ts:2721`) gain
  **workspace-membership** awareness at the hub route boundary — inside a child they stay
  permissive (mutual trust).

---

### 5.1 Hub trust model (the concentration point)

The hub holds **all users, all devices, all memberships** in one hub-owned **shared identity
DB** (`~/.config/vibestudio/server-auth/identity.db`), which children open **read-only**.
Children keep their own WebRTC ingress and DTLS identity (WP1 pivot — no ingress relocation,
no single shared `identity.pem`). Because hub and children are **host processes on one
trusted machine** (§0.0), the hub↔child relationship needs **no** cryptographic grant
machinery: identity crosses by the child reading the shared DB and re-validating the device
credential it already understands. The external security boundary (WebRTC with the pinned
DTLS fingerprint; the blind signaling relay; the credential/approval gate on external access)
is unchanged and stays first-class. Notes for implementers:

- The shared identity DB is `0700`/`0600`, hub-owned; the hub is the sole writer, children
  are read-only (WAL). No RPC identity channel, no cache-replication protocol, no HMAC grant
  keys — all deleted as complexity defending a boundary that isn't there.
- Root/admin actions (invite, revoke, membership) are role-gated (WP9) and land in the
  host-owned governance log (§6.2) for after-the-fact **attribution** (transactional
  SQLite, no tamper chain — §0.0).

Per §0.0, **no inter-user or inter-workspace zero-trust is introduced** — this is a
mutually-trusting team/family server, and the process-per-workspace split is for fault
containment and clean architecture, not a security wall between trusted members.

## 6. Shared approval queue + provenance (the emphasized deliverable)

### 6.1 Shared queue — mostly already true

The approval queue is **already** a single shared instance consumed by every shell surface
(`approvalQueue.ts`, one global at `index.ts:628`), resolution fans out to all coalesced
waiters, and `policy.allowed = ["shell","app","server"]` already lets any device resolve
any entry. Because grants bind to **code identity**, an approval by user A satisfies a
matching request regardless of who is running the code. **So "any user approves, all
consume from one queue" is structurally met** — the missing piece is purely _attribution_.

### 6.2 Approval provenance log

The investigation surfaced a key structural fact: **there are two distinct approval
systems, and only one is journaled today.**

- **(a) Agent tool-call approvals** — _already in GAD._ An `approval.requested` /
  `approval.resolved` trajectory-event pair, keyed by `causality.approvalId`, projected
  into a live, resolve-once `trajectory_approvals` table with **`requested_by_json`** and
  **`resolved_by_json`** columns (`gad-store/index.ts:1833-1846`, `projectApproval` at
  `:4008-4056`). This is _already_ a hash-chained, replayable, fork-aware "who requested /
  who resolved" ledger — the exact skeleton we want.
- **(b) Host approval-queue resolutions** — _the shared queue this plan cares about_
  (credential, capability, client-config, credential-input, userland, unit-batch,
  device-code, external-agent). These resolve **in-process** via `shellApprovalService` /
  `mainAdvanceApproval` / `credentialService`; their only durable trace is the protected
  main-ref log + an **in-memory metric counter** (`pushMetrics.ts`, `approval_resolved_total`).
  **They are not journaled into GAD or anywhere queryable.** This is the gap.

**Boundary & ownership (decided in the spirit of the host-boundary rule).** GAD
(`workspace/workers/gad-store`) is **userland**; the host approval queue is host-side.
Making the host write its security-decision audit into a userland-owned, userland-forkable
store would be a boundary inversion — the same class of concern as host-knows-channels. So
the provenance log splits **by ownership, mirroring the two approval systems**:

- **(a) Agent tool-call approvals stay in GAD** — they already live on the userland agent
  trajectory, written by userland `PiRunner`. Correct as-is; we only extend the resolver
  identity to carry the account (below).
- **(b) The host approval queue gets a HOST-OWNED transactional governance log** — an
  exact-schema SQLite ledger at `governance/governance.db`, with atomic batches and
  approval-id replay protection. **No hash
  chain / tamper-evidence** — the host is the sole trusted writer and members are mutually
  trusted (§0.0); the log's job is _attribution_, not tamper-proofing. It also records
  **membership governance** (invite/revoke/add/remove/role) so "who let this person in" is
  answerable. The host records its own decisions; no host→userland write, no boundary
  inversion.
- **Unified view:** the "governance" UX is a **read-only union** — the host log (approvals +
  membership, queryable host-side) plus the GAD agent-approval projection (via `gad-browser`).
  A governance panel presents them as one timeline; neither store writes into the other.

**Capture point:** every resolve/submit handler in `shellApprovalService.ts` reads
`ctx.caller.subject` from the authenticated connection and passes that verified resolver into
the queue. There is no client-supplied acting-principal payload or compatibility override.
The inline external-agent card path (`resolveExternalAgentByRequest`) routes through the same
capture and settlement coordinator.

**Record shape** — one `ApprovalProvenanceRecord` per resolution, appended to the
**host-owned** governance log (transactional SQLite, **no hash chain**; full spec in WP5
§5). Resolution flows through a single
**settlement coordinator** in the queue that snapshots `resolvedBy` and emits it _before_
removing the entry — fixing the delete-before-emit bug so the live surface actually shows who
acted (WP5 §6). The _agent-approval_ half (a) additionally extends GAD's existing
`approval.resolved`/`projectApproval` to carry the same account — see WP5.

```ts
// host-owned governance record (governance/governance.db); WP5 §5 is authoritative
{
  approvalId,
  approvalKind,        // credential | capability | client-config | credential-input | secret-input | userland | unit-batch | device-code | external-agent
  decision,            // once | session | version | deny | dismiss | submit
  granted,             // deny/dismiss → false
  workspaceId,
  resolvedAt,
  resolvedBy: { userId, handle, deviceId, deviceLabel },      // WHO approved — the verified human
  resolvedVia,         // shell | mobile-notification | app | server
  requestedBy: { callerId, callerKind, repoPath, effectiveVersion, userId },  // captured at request-enqueue time (WP5 §5)
  resource: { capability?, key?, value?, credentialId?, subjectId? },
  grantScopeStored,    // scope the server persisted (null for once/deny)
}
```

**GAD (agent-approval half only):** extend `projectApproval` (`gad-store/index.ts:4008`) so
`resolved_by_json` carries the account, and set `actor.metadata.userId` on
`approval.resolved` — **never** `actor.kind = "user"` (that is the semantic "human-authored"
role, not an account).

**Identity, done right:** the resolving human is recorded as `actor.metadata.userId`
(and/or a new authenticated-principal binding), **not** by setting `actor.kind = "user"` —
that kind means "human-authored message" and must not be conflated with account identity
(per the GAD substrate review). Optionally introduce a first-class authenticated-user actor
binding later; the metadata path is the lowest-friction start.

**Query surface:** GAD's existing read API (`readLog`, `query`/`rawSql` read-only CTE guard,
`recall`) answers "every approval by user X", "who approved credential use for
`github-repos` last week", "all denies in workspace Y". The existing `gad-browser` panel
(`workspace/panels/gad-browser`) gains a Governance view.

**Surface it live:** add `resolvedBy: {userId, handle}` to the `PendingApproval` resolution
event so other connected users see _who_ acted — turning the shared queue into a visibly
collaborative surface (reuses the broadcast `shell-approval:pending-changed`,
`approvalQueue.ts:353`).

**Non-negotiable:** the provenance log records **who approved**, but grant _matching_ still
keys on code identity — do not fragment shared grants per user (that would break "all
consume from the same queue"). And do **not** reuse `CredentialUseGrant.grantedBy` — that
field stores the _scope string_, not a human (`credentialService.ts:5011-5038`).

---

## 7. Personalization → handles

- **Account is the handle anchor.** `User.{handle, displayName, avatarBlob, color}` (§2.1).
  Handle uniqueness enforced server-wide, validated against the channel regex
  `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/` and the reserved set (`pubsub-channel/types.ts:17`).
- **Retire the hardcoded human identity.** Replace `{name:"Chat Panel", type:"panel",
handle:"user"}` (`useAgenticChat.ts:224`, `useChatCore.ts:267`) with account-derived
  `{handle, displayName, type:"user"}`, threaded from the connection's verified subject.
- **Derive, don't trust.** On channel `subscribe`, the DO stamps the participant's
  `handle`/`name` from the **verified caller subject** rather than client metadata —
  exactly the pattern `sendAsCaller` already uses (`channel-do.ts:1021-1041`). This is the
  security fix that must land _with_ personalization, or handles become spoofable.
- **Stable identity.** Human participant id becomes `user:<userId>` (stable across a user's
  panels/devices), feeding presence aggregation. `participantKindFromMetadata` gains a
  `user:` → `user` case (`participant-ref.ts:227`).
- **Propagation.** Personalization flows: account → connection subject → channel roster
  handle → trajectory `actor.displayName` → GAD `actor` → provenance log. One source of
  truth, rendered everywhere agents and humans are named.

---

## 8. Adding human users to channels

- **Membership.** A lightweight per-channel member list layered on the existing roster
  (`channel-do.ts` participants table). "Add @alice to this channel" records membership +
  emits a `presence`/notify event; Alice's clients surface an invite/auto-subscribe. Since
  a channel is bound to one context and mutual trust holds within a workspace, membership
  is about **notification/roster visibility**, not a hard ACL wall.
- **Multi-human awareness.** `askUserPolicy` currently targets "the first `panel`/`user`"
  (`agent-loop/src/policies/index.ts:172`); make `ask_user`/`feedback_form` routing
  **mention/target-aware** so an agent can ask a _specific_ user, and fall back to
  broadcast-to-all-humans when unaddressed.
- **Handle namespace.** Humans advertise **no** callable methods, so they don't collide in
  the bare-method-name namespace that `channelToolsPolicy` resolves
  (`agent-loop/src/policies/index.ts:33-44`) — adding humans is additive there.

---

## 9. Presence — two separate systems (do not conflate)

There are **two distinct presence concepts** with different owners. Keeping them separate is
the whole point:

### 9.1 Channel presence — userland-only

Who is participating in a **pubsub channel** (a conversation roster). Lives **entirely in
the userland channel layer**; the **host/hub never learn about channels** (narrow-host
boundary — `scripts/check-host-workspace-imports.mjs`, `docs/narrow-host-boundary-refactor-plan.md`;
the host has no knowledge that `pubsub-channel` exists). It needs no host involvement
because **a connected panel is, by definition, present**: it joins the channel roster on
connect, heartbeats while live, and is evicted when it drops — all in the channel DO. Build
on the existing userland foundation (`channel-do.ts:592-615, 945, 1217, 1777-1825`):

- **Account aggregation (userland).** Collapse a user's multiple live panel participants
  into one channel presence keyed by `user:<userId>` — online in the channel if any of that
  user's panels is in the roster. The `userId` is the one thing the host legitimately passes
  down (the verified `subject`, §2.1); the aggregation is computed by the channel DO /
  `agentic-core`, never by the host.
- **Status + last-seen (userland).** `online | idle | away | offline` in presence metadata
  (add `status`/`avatar`/`color` to the public whitelist, `participant-ref.ts:17-26`);
  idle/away derived userland-side from heartbeat recency; persist last-seen on leave in the
  channel DO.

### 9.2 Workspace user presence — a first-class surface, _not_ via channels

"**Who is currently in this workspace**" — a legitimate, wanted surface (for the
panel-forest UI: whose trees are whose, who's around). It has **nothing to do with pubsub
channel presence** and is **boundary-clean precisely because it is built from the host's own
transport/identity facts, never from channels**:

- **Source of truth = the host session/connection registry**, which the host already owns
  (`rpcServer.ts` `ConnectionRegistry`/`SessionRegistry`), now tagged with the verified
  `subject.userId` (§2.1, WP4). "User X is present in workspace W" ⟺ user X has ≥1 live
  connection attached to W's child process. This is transport liveness projected to the
  user level — exactly the kind of fact the host may know.
- **New host surface:** a small `workspacePresence` service — `list()` + a
  `workspace-presence-changed` event (mirrors how the host already emits
  `panel-tree-updated`), fed by connection add/drop and the session-TTL machinery
  (`sessionRegistry.ts`). It emits **only** `{userId, handle, displayName, online,
lastSeen}` — no channel, no conversation, no pubsub reference anywhere.
- **Zero channel coupling.** This service must not import or reference `pubsub-channel` or
  any userland channel concept; `check:host-boundary` guards it. It is presence _of users in
  a workspace_, derived from sessions — the two presence systems never touch.
- **Optional hub view.** Because the hub routes user sessions to workspace children, it can
  legitimately answer "which workspaces is user X connected to" from **its own routing
  table** (transport facts) — still no channels involved. This is the only sanctioned
  cross-workspace presence; it is session/routing knowledge, never channel presence.

> The line: **transport/session liveness is the host's to know and surface (9.2); pubsub
> channel membership is userland's alone (9.1).** They are never derived from each other.

---

## 10. Implementation — one simultaneous change, not a sequence

**This is implemented as a single big-bang cutover. There are no phases, no staging, no
milestones, and no ordering gates.** The "WP" divisions below are a _decomposition of one
change for authoring clarity_ — who-touches-what — **not** a schedule and **not** a set of
independently-shippable increments. Everything below lands together, in one branch, in one
release. There is no interim state in which some WPs are live and others are not, and **no
compatibility path** is built for a partially-applied set: the single-user structures are
deleted outright and the multi-user structures replace them in the same cutover (§11). Do not
introduce feature flags, "phase 1/2," fallbacks to old behavior, or stubs that stand in for a
"not-yet-implemented" WP — every WP's real implementation is present at cutover.

Each WP has a detailed, grounded implementation spec:

| WP                                     | Spec                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| WP0 — User identity foundation         | [`multi-user-wp0-user-identity-spec.md`](./multi-user-wp0-user-identity-spec.md)               |
| WP1 — Hub as control plane             | [`multi-user-wp1-hub-control-plane.md`](./multi-user-wp1-hub-control-plane.md)                 |
| WP2 — Workspace membership             | [`multi-user-wp2-workspace-membership.md`](./multi-user-wp2-workspace-membership.md)           |
| WP3 — Panel-tree forest                | [`multi-user-wp3-panel-forest.md`](./multi-user-wp3-panel-forest.md)                           |
| WP4 — Sessions & fan-out               | [`multi-user-wp4-sessions-fanout.md`](./multi-user-wp4-sessions-fanout.md)                     |
| WP5 — Approval provenance              | [`multi-user-wp5-approval-provenance.md`](./multi-user-wp5-approval-provenance.md)             |
| WP6 — Handles & personalization        | [`multi-user-wp6-handles-personalization.md`](./multi-user-wp6-handles-personalization.md)     |
| WP7 — Channels multi-human             | [`multi-user-wp7-channels-multihuman.md`](./multi-user-wp7-channels-multihuman.md)             |
| WP8 — Presence (two systems)           | [`multi-user-wp8-presence.md`](./multi-user-wp8-presence.md)                                   |
| WP9 — Trust cleanup & role attenuation | [`multi-user-wp9-trust-role-attenuation.md`](./multi-user-wp9-trust-role-attenuation.md)       |
| WP10 — Legacy removal & hardening      | [`multi-user-wp10-legacy-removal-hardening.md`](./multi-user-wp10-legacy-removal-hardening.md) |

**WP0 — User identity foundation.** `User`/`UserStore` (hub), root bootstrap, `role`;
`DeviceRecord.userId`; `subject` on `VerifiedCaller` populated at `handleAuth`; agent/worker
`userId` inheritance via lineage. Every `ServiceContext` in a child carries a verified
`userId`; tests assert no unattributed caller reaches dispatch.
**→ Detailed implementation spec: [`docs/multi-user-wp0-user-identity-spec.md`](./multi-user-wp0-user-identity-spec.md).**

**WP1 — Hub as control plane (director, not relay).** Hub owns pairing/invites + the shared
identity DB; **children keep their own WebRTC ingress** (no relocation, no HMAC grant);
user-scoped device credentials so one pairing reaches every member workspace; invite-a-user
vs pair-a-device split via `hubControl`; `listWorkspaces`/`routeWorkspace` with the membership
entry gate enforced at the child; retire admin-token-as-root.

**WP2 — Workspace membership (enforced).** Opaque stable `workspaceId` on the registry;
`WorkspaceMembership` as a table in the shared identity DB (hub writes, children read
read-only); `hubControl.addWorkspaceMember`/`removeWorkspaceMember` (root/admin); coarse entry
gate — authoritative at the child, hub list/route pre-filter (non-members get `EACCES`);
membership-filtered listing.

**WP3 — Panel-tree forest.** `owner_user_id` on `slots`/`entities`; owner-tagged reads;
forest grouping in `panelManager`/`panelRegistry`; `Panel.owner`; shell renders one section
per user; shared DOs stay shared, per-runtime scratch for ephemeral view state.

**WP4 — Sessions & fan-out.** `userId` on concrete `WsClientState` records while
`CallerSession` stays identity-free; `userId` threaded to userland via `AuthenticatedCaller` +
DO envelope + IPC; intra-workspace broadcast kept; exact per-member-device push targeting.

**WP5 — Approval provenance.** Resolver identity comes from authenticated service context and
all human verdict paths use a single settlement coordinator; **host-owned exact-schema SQLite
governance ledger** (approvals + membership events, + GAD projection for the agent-approval
half); `resolvedBy` on resolution events; unified `gad-browser` + host-log Governance view.

**WP6 — Handles & personalization.** Account `handle`/`displayName`/`avatar`; retire
hardcoded `@user`; principal-derived channel handles with live profile projection;
`user:<userId>` stable ids.

**WP7 — Channels multi-human.** Channel membership/invite through the generic durable,
account-scoped user notification inbox (initial/reconnect snapshot plus targeted live nudge,
no polling); call-group `ask_user` targeting; `participantKindFromMetadata` `user:` case.

**WP8 — Presence (two systems).** (i) _Channel presence_ — account aggregation, status,
last-seen, whitelist, all in the channel/pubsub DO + `agentic-core`, no host involvement.
(ii) _Workspace user presence_ — new host `workspacePresence` service + event, fed by the
session/connection registry keyed on `userId`, emitting only `{userId, handle, online,
lastSeen}`, with **zero** channel coupling (guarded by `check:host-boundary`); consumed by
the panel-forest UI; plus the hub cross-workspace presence view.

**WP9 — Trust cleanup & role attenuation.** Role-gate hub identity administration
(invite/revoke/membership = root/admin); relay/dispatch stay **permissive inside a child** (mutual invocation);
role gates only the enumerated host-admin ops; complete `revokeUser` teardown; git author from
acting user.

**WP10 — Legacy removal.** Delete single-user scaffolding (machine-admin-as-root paths, "all
shells trusted", per-child device stores, whole-file-LWW assumptions, hardcoded `@user`/git
author, flat `rootPanels` snapshot); shared-SQLite consolidation; opaque-`workspaceId`
migration; concurrency for shared central data; docs + skills refresh; full smoke ladder.

The WP labels are an authoring decomposition of one simultaneous cutover — **not** a build
order. Nothing here is sequenced, gated, or independently shippable; the whole set is written,
reviewed, and merged as one change.

---

## 11. No-legacy stance — nothing old is left standing

Per the mandate (**no backward compatibility, no legacy structures, clean pre-release code**),
every single-user structure is **deleted in the same cutover**, not adapted, wrapped, or kept
behind a flag. There is **no dual-mode, no compatibility shim, no fallback to old behavior,
and no migration path from a partially-applied state** — the code compiles and runs only in
the new multi-user shape. Deleted outright:

- The "single-user product" whole-file LWW comment and assumption (`index.ts:337-339`) —
  replaced with real per-record / multi-writer handling for shared central data.
- Machine-admin-token-as-human-root (`index.ts:2014-2039`) — reduced to a local diagnostic
  break-glass on the `admin-token` route; it is no longer an identity anywhere.
- "Every paired shell is fully trusted" (`chromeTrust.ts:12-34`) — replaced with role
  attenuation.
- Per-child device-auth stores (`{childStateDir}/auth/devices.json`) — replaced by the one
  hub-owned shared identity DB; no per-workspace identity store remains.
- Hardcoded human identity `@user` / "Chat Panel" (`useAgenticChat.ts:224`,
  `useChatCore.ts:267`) and hardcoded git author (`packages/git/src/client.ts:778-781`).
- The flat `PanelTreeSnapshot.rootPanels` shape — replaced by the owner-grouped `forest` with
  no compatibility field.
- Dead two-port vestiges (`panelPort`, `PanelHttpServer.setPort`) surfaced during
  investigation — removed while we're in the area.

Migrations follow the existing **destructive clean-cut** convention (`WorkspaceDO`
`schemaVersion` bump drops tables, `workspaceDO.ts:463`; identity re-pairs from a fresh root
invite) — no data-preservation shims, no back-compat readers for old formats.

---

## 12. Verification strategy

- **Identity invariants (WP0):** unit tests asserting every dispatched `ServiceContext`
  carries a verified `subject.userId`; that client-asserted user fields are ignored (mirror
  the existing `from`/`caller` non-trust tests, `rpcServer.ts:1864-1866`); agent/worker
  `userId` inheritance from lineage.
- **Isolation vs inspectability:** two-user integration test in one workspace — both see
  the full forest, both approve from one queue, neither is blocked from the other's tree;
  and a cross-workspace test proving a user without membership cannot attach.
- **Provenance:** resolve an approval from desktop and from mobile; assert a **host-owned**
  governance record with the correct `resolvedBy.userId` in each case (including the
  previously-lost Electron path); for an _agent tool-call_ approval, assert the GAD
  `trajectory_approvals` `resolved_by_json` carries the account; assert grant matching still
  succeeds cross-user.
- **Handles/presence:** two humans in a channel render distinct account handles; presence
  aggregates across a user's two devices; `ask_user` targets the addressed user.
- **Control plane:** the existing WebRTC pairing + smoke ladder (`pnpm smoke:full`,
  `remote-overhaul` gates) extended for multi-user pair → select-workspace → attach.

---

## 13. Decisions (all resolved — nothing deferred)

Every design choice in this plan set is **decided**. There are no open questions, no
"defaults pending confirmation," and no items held for a later pass — the per-WP specs state
firm decisions, not options.

1. **Topology (Decision 1): keep process-per-workspace**, elevate the hub to the multi-user
   control plane.
2. **Workspace access (Decision 2): per-workspace membership, enforced** — root/admin grant
   each user access to specific workspaces (§2.3).
3. **Who invites users: root/admin only.** Any member pairs their own devices.
4. **Presence: two separate systems (§9), both built.** (i) **Channel presence** —
   userland-only, in the pubsub roster; the host/hub never learn about channels (narrow-host
   boundary). (ii) **Workspace user presence** — a first-class host surface ("who's in this
   workspace") built **only** from the host session registry + verified `userId`, with
   **zero** channel/pubsub coupling. The two are never derived from each other. The hub
   cross-workspace presence view (session/routing-based, never channel-based) is **included**,
   not deferred.
5. **Handle uniqueness is server-wide.** A person keeps one identity across every workspace
   they belong to; handles are validated against the shared reserved set + regex. (Not
   per-workspace — decided, not a default awaiting review.)
6. **Identity storage is one hub-owned SQLite DB** read read-only by children; **avatars are
   inline `data:` URIs**; **workspace ids are opaque `ws_<rand>`**; the **governance log is
   transactional SQLite** (approvals + membership events, no hash chain). All decided.

---

## Appendix — investigation source map

Every claim above is grounded in a seven-track code investigation. Primary anchors:

- **Topology:** `src/server/index.ts:309-387`, `hubServer.ts:55-75,710-856`,
  `workerdManager.ts:1342-1583`, `env-paths/index.ts:4-28`.
- **Auth/identity:** `deviceAuthStore.ts:8-61`, `authService.ts`, `auth/model.ts:122-151`,
  `chromeTrust.ts:12-34`, `principalKinds.ts:3-35`, `rpcServer.ts:845-917`.
- **Sessions/fan-out:** `rpcServer.ts:133-140,228-378`, `sessionRegistry.ts`,
  `eventsService.ts:398-461`, `pushService.ts:338`, `approvalPushBridge.ts:128`.
- **Panels:** `workspaceDO.ts:335-345`, `panelManager.ts:1001-1011`,
  `panelRegistry.ts:102-107`, `types.ts:241,319`, `panelFactory.ts:199`.
- **Approvals:** `approvalQueue.ts`, `shellApprovalService.ts`, `capabilityGrantStore.ts`,
  `capabilityPermission.ts`, `docs/capability-approval-design.md`.
- **Channels/handles/presence:** `workspace/workers/pubsub-channel/channel-do.ts`,
  `agentic-protocol/src/events.ts:32`, `participant-ref.ts:17-26,227`,
  `agentic-chat/hooks/useAgenticChat.ts:224`, `agent-loop/src/policies/index.ts:33,172`.
- **GAD/provenance:** `workspace/workers/gad-store/index.ts` (`ACTOR_KINDS` 186-200,
  `log_events` 1655-1676, `trajectory_approvals` 1833-1846, `projectApproval` 4008-4056),
  `docs/stage0-unified-log-spec.md` (append/fork/replay contract),
  `docs/gad-provenance-fibers-design.md` (graph + on-behalf-of), `packages/shared/src/approvals.ts`
  (host approval identity), `src/server/services/mainAdvanceApproval.ts`,
  `credentialService.ts:3895`, `workspace/panels/gad-browser`.
