# WP1 — Hub as Multi-User Control Plane (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (Decision 1; §2.2) and the direct consumer
of `docs/multi-user-wp0-user-identity-spec.md`. WP0 defined the `User`/`UserSubject` model,
the hub-owned **shared identity DB**, and the child-side device-credential→identity-DB subject
resolution. WP1 wires the **hub side**: it becomes the identity/pairing/membership **director**
— it authenticates devices, owns the pairing/invite surface, tells a client which workspaces
it may enter, and coordinates signaling to the right child — **without** becoming a media
relay.

**Design pivot (load-bearing).** The hub does **not** terminate WebRTC or relay RPC. The
WebRTC-v2 "hub-as-answerer" design was explicitly **rejected** (`webrtc-rpc-v2-plan.md:382-385`),
and one `RpcServer` owns its DTLS pipe end to end (`rpcServer.ts:3292` `attachWebRtcPipe`).
Each **workspace child keeps its own WebRTC ingress**, exactly as today. What actually makes
"pair once, reach every workspace" work is not a single ingress — it's a **user-scoped device
credential** validated against the **shared identity DB** at whichever child the client
connects to. The hub's job is discovery + signaling coordination + the pairing/invite/membership
surface, not carrying bytes.

Obeys the host-boundary invariants (`plan §0.1`): the hub deals only in identity, pairing,
membership, and signaling coordination — it never learns about channels (INV-1). Identity
lives in the hub-owned DB that children read read-only (INV-3).

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** consolidate **pairing/invite** at the hub; make device credentials **user-scoped
and workspace-independent**; `hubControl.listWorkspaces()` filtered by membership; signaling coordination
that points a client at the selected child's ingress; split invite-user (root/admin) vs
pair-device (member) endpoints. The membership **entry gate** is enforced at the child on
connect (it already reads the shared identity DB, WP0 §3.7).

**Out of scope:** the `UserStore`/`DeviceRecord.userId` data model + child-side subject
resolution (WP0); membership store internals + `addMember` (WP2); per-user fan-out (WP4);
role attenuation of non-pairing capabilities (WP9). **Explicitly not in scope: any hub media
relay or hub WebRTC answerer** — rejected design, see the pivot above.

**Exit criteria:**

1. A device pairs **once, to the server (hub), as a user** — the resulting device credential
   is user-scoped and works for every workspace the user may enter (not per workspace).
2. A client reaches a member workspace's child directly (child owns ingress); the child
   validates the device credential against the shared identity DB, resolves `subject`, and
   checks membership — a non-member is refused `EACCES` at the child, and the hub omits the
   workspace from `hubControl.listWorkspaces` so it is never offered.
3. Auth carries **no HMAC grant token**: the child re-validates the device credential it
   already understands and reads the account from the shared DB (WP0 §3.6). The public server
   is always a hub; workspace children are internal hub-spawned runtimes, not a second mode.
4. `inviteUser` requires root/admin; `pairDevice` requires an authenticated member.

---

## 2. Today → target

**Today** (topology investigation): each workspace **child** runs its own WebRTC ingress and
mints its own invites (`hubServer.ts:246-282` `mintChildPairingInvite`, `:739-775`
`buildWorkspaceChildEnv` gives each child its own DTLS identity + device store); the hub is a
loopback HTTP/WS reverse proxy keyed by `/w/{name}/` (`hubServer.ts:544-557,591-708`) and
holds `HubRuntimeState.runtimes` (`:55-75`). A remote client effectively pairs to a
_workspace_ (device store is per-child), and each workspace has its own DTLS identity.

**Target:** the **hub** owns **identity, pairing, and membership**; each **child keeps its own
WebRTC ingress**. A device pairs once at the hub and receives a **user-scoped** device
credential recorded in the shared identity DB. To reach workspace W the client asks the hub
which workspaces it may enter and how to reach W's child, signals to that child's ingress, and
authenticates there with its device credential; the child resolves `subject` and gates
membership by reading the shared DB. The hub never sits in the media/RPC path.

```
device ──pair once──► HUB (pairing/invite)     ── records user-scoped device cred in shared identity DB
client ──hubControl.listWorkspaces()─► HUB      ── returns only member workspaces (reads MembershipStore)
client ──"reach W"──► HUB (signaling coord)    ── points client at child W's ingress room
client ──WebRTC──► CHILD W ingress             ── child owns its DTLS pipe (unchanged topology)
                    └─ child.handleAuth: validate device cred → read userId from shared DB → subject
                       └─ isMember(userId, W)? else EACCES   (entry gate at the child, WP0 §3.7)
```

---

## 3. Ingress stays at the child; the hub coordinates

- **No ingress relocation.** `startWebRtcIngress` (`webrtcIngress.ts:109` pool, `:182`
  `armRoom`, `:211`/`rpcServer.ts:3292` `attachWebRtcPipe`) **remains in each child**, armed
  with that child's DTLS identity. The hub does **not** run an answerer — that was rejected
  (`webrtc-rpc-v2-plan.md:382-385`) and would split ownership of a pipe one `RpcServer` must
  own. This is the single most important correction over the first draft.
- **The session shim is unchanged.** `SessionWebSocketShim` (`webrtcSessionShim.ts:88`) still
  makes one WebRTC session quack like a `ws` and drives the child's
  `handleConnection`/`handleAuth`. The device credential is presented as the `ws:auth` token
  (no minted grant); the child validates it (WP0 §5.1).
- **What the hub actually provides for reach:** (a) `hubControl.listWorkspaces()` — the
  member set; (b) `hubControl.routeWorkspace({workspace})`, which returns a stable control
  reach plus the selected child's current reach. The **media/RPC pipe terminates at the
  child**.
- **Signaling room model** (`apps/signaling/room.ts:35-41,178-188`) is unchanged: one remote
  party per room, per device, per child — exactly as today.

---

## 4. Authentication at the hub

Consolidate the **pairing/refresh** flow (today split across child `authService`) into the hub,
since the hub owns the identity DB (the sole writer):

- **Redeem** — reuse `createPairingRedeemer` (`authService.ts:103-166`) at the hub: QR `code`
  → `completePairing` (WP0 binds the device to a user in the shared DB); `refresh:
<deviceId>:<rt>` → `validateRefresh` → the device's `userId`. `agent:<id>:<secret>` stays a
  child-local concern (agents connect inside a child, not via hub pairing).
- **Device credentials are user-scoped, not workspace-scoped.** The pairing outcome is a
  credential the child can validate against the shared DB for _any_ workspace the user may
  enter — this is the mechanism behind "pair once, reach every workspace." No per-workspace
  device store remains.
- **Subject resolution happens at the child** on connect (WP0 §5.1), by reading the shared DB
  — not at the hub. The hub only needs identity to filter `hubControl.listWorkspaces` and run
  pairing surface.
- **Loopback refresh endpoints** (`/_r/s/auth/refresh-shell` `:412-435`,
  `refresh-principal-grant` `:485-498`) are fronted by the hub (it owns the writer).

---

## 5. Workspace discovery & reach

- **`hubControl.listWorkspaces()`** returns only the user's member workspaces (membership-filtered
  `listHubWorkspaces`, `hubServer.ts:168-192`, reading `MembershipStore` from the shared DB).
  This is a UX filter, not the security gate — the authoritative entry gate is the child's
  membership check on connect (WP0 §3.7).
- **`hubControl.routeWorkspace({ workspace })`** — an in-band RPC on the hub control
  connection that (1) spawns/attaches the child and (2) returns the control and workspace
  reach coordinates for the client to reach that child's
  ingress. It does **not** attach a session leg through the hub — the client then establishes
  its own WebRTC session to the child (§3). If the caller is not a member the child will refuse
  on connect regardless; the hub may also short-circuit with `EACCES` for a cleaner UX.
- A user may hold **concurrent sessions to multiple workspaces** (multi-workspace,
  multi-session): each is a direct client↔child pipe. The hub's routing/registry of live
  sessions is the sanctioned source for the optional cross-workspace presence view (WP8 §4.4 /
  plan §9.2), and it references sessions, never channels. (Since sessions terminate at children,
  the child reports its live sessions up to the hub for that view — WP8 owns the surface.)

---

## 6. Invite-user vs pair-device (hub endpoints)

Both ride `mintPairingInvite` (`auth/model.ts:122-151`), split by intent (WP0 §4):

| RPC                                                                | Caller gate                                          | Effect                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| `hubControl.inviteUser({handle, displayName, role, workspaces[]})` | live role for `subject.userId` ∈ {root, admin} (WP9) | new account + first-device invite + initial memberships |
| `hubControl.pairDevice()`                                          | authenticated member                                 | pairing invite bound to the **caller's own** `userId`   |
| first root-invite redemption (implicit)                            | only when `UserStore` empty                          | first pair becomes root (WP0 §4)                        |

The startup QR print (`hubServer.ts:902-903,1014`) becomes the **root bootstrap** invite when
no users exist.

---

## 7. Local desktop & CLI

- **Local desktop** discovers workspaces through the hub, then connects to each child (default
  mode). The desktop's `electron-main` bootstrap principal maps to the **root** user subject on
  the local machine by default, or presents a real per-user device credential on a shared
  machine (WP0 §5.4). Its scoped `app`/`panel` sub-connections (`serverClient.ts:198-347`)
  inherit the desktop's user subject.
- **CLI** (`src/cli/rpcClient.ts`) authenticates as its user's device (`shell:<deviceId>`);
  `agent:` CLI callers connect inside a child with an agent credential carrying `userId`
  (WP0 §3.3).
- **No standalone workspace-server mode:** the public entry is always the hub. Workspace
  children receive the identity DB and internal control capability from the hub; the removed
  force-workspace switch is not a supported fallback.

---

## 8. Testing

- **Pair-once-to-server:** a fresh device pairs to the hub, becomes a user, then reaches two
  different member workspaces (two direct child sessions) with the **same** device credential —
  one pairing, N workspaces, no re-pair.
- **Membership entry gate:** connecting to a non-member workspace's child → `EACCES` at the
  child; `hubControl.listWorkspaces` omits it; `routeWorkspace` short-circuits `EACCES`.
- **No grant token:** the child authenticates the session from the device credential +
  shared-DB lookup alone (WP0 §5.1); there is no HMAC grant to forge, expire, or replay.
- **Child owns ingress:** the WebRTC/RPC pipe terminates at the child; the hub is never in the
  media path (assert no hub answerer).
- **Invite roles:** `inviteUser` as member → `EACCES`; as root → creates user + memberships;
  `pairDevice` as member → binds to caller's own `userId`.
- **Extend the smoke ladder** (`pnpm smoke:full`, `docs/remote-ux-overhaul-plan.md:59-67`):
  multi-user pair → select-workspace → attach, plus two users on one server reaching two
  different workspaces.

---

## 9. File-change checklist

| File                                                             | Change                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/webrtcIngress.ts`                                    | **unchanged topology** — ingress stays in each child with its own DTLS identity                                                                                                                                                                             |
| `src/server/webrtcSessionShim.ts`                                | unchanged — session terminates at the child; device credential as `ws:auth`                                                                                                                                                                                 |
| `src/server/hubServer.ts`                                        | own identity DB + pairing; `hubControl.routeWorkspace` (spawn child + return dual reach coordinates); membership-filtered `listWorkspaces`; `inviteUser`/`pairDevice`; pass the read-only identity-DB path to children; root bootstrap on empty identity DB |
| `src/server/hubServer.ts`                                        | pairing/refresh at hub; user-scoped device credentials; typed `inviteUser`/`pairDevice`; role gates resolve the subject's current account row                                                                                                               |
| `src/server/index.ts`                                            | child validates device credential + reads subject/membership from the shared identity DB; refuses remote user sessions without it (dev workspace mode)                                                                                                      |
| `apps/signaling/*`                                               | unchanged (per-device, per-child room model retained)                                                                                                                                                                                                       |
| `STATE_DIRECTORY.md`, `docs/webrtc-deployment.md`, `docs/cli.md` | hub-owned identity/pairing; children keep ingress; new pair/invite/list/route surface                                                                                                                                                                       |

---

## 10. Decisions (resolved — nothing deferred)

1. **Reach coordination:** `hubControl.routeWorkspace` returns stable control and selected-child
   coordinates and the client dials that child directly. The hub proxies neither media nor
   RPC; the pipe terminates at the child.
2. **Membership gate placement:** authoritative at the child (it reads the shared DB on
   connect); the hub's `listWorkspaces`/`routeWorkspace` is a UX pre-filter only. There is no duplicate
   enforcing gate at the hub — single source of truth is the child.
3. **Multi-workspace concurrency:** unlimited concurrent child sessions per user (children are
   cheap and lazily spawned). No cap.
