# WP10 — Legacy Removal & Hardening (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§11 no-legacy stance, §12 verification).
The closing work package: after the feature WPs land, **delete** single-user scaffolding
(don't adapt it), add real multi-writer concurrency where whole-file last-writer-wins no
longer holds, refresh docs/skills, and define the full multi-user verification ladder.

Mandate: pre-release, no backward compatibility — remove, don't shim.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** delete the single-user assumptions surfaced across the investigation; make
shared central data safe under concurrent multi-user writes; remove dead vestiges; refresh
operator docs/skills for the multi-user model; a multi-user verification ladder; a
single-user-assumption audit sweep.

**Out of scope:** the feature changes themselves (WP0–WP9) — this WP removes what they
obsolete and hardens the seams.

**Exit criteria:**

1. No code path asserts "single-user product"; shared central data survives concurrent writes
   by two users without clobbering.
2. Dead vestiges (`panelPort`, per-child device store, admin-token-as-root remnants,
   hardcoded git author) are gone.
3. Docs/skills describe the multi-user server; the smoke ladder exercises multi-user
   scenarios and passes.
4. A grep-based single-user audit returns clean (or documents each remaining machine-global
   as intentional under process-per-workspace).

---

## 2. Concurrency: retire whole-file last-writer-wins

- **`CentralDataManager` / `data.json`** (`packages/shared/src/centralData.ts:73-81`,
  `workspace/types.ts:542-554`) is written whole-file LWW, justified as "single-user product"
  (`index.ts:337-339`). With the hub + multiple users, it is written from multiple actions
  concurrently. Replace whole-file LWW with **per-record updates under a lock** (or move the
  registry into a small hub-owned store/DO). Concretely: read-modify-write the specific
  `WorkspaceEntry` row under a mutex, not the whole file. **Mint + store the opaque stable
  `WorkspaceEntry.workspaceId`** here (`ws_<rand>`, WP0 §3.5 / WP2) — decoupled from display
  name and on-disk path; every membership/scoping key uses it.
- **Per-user vs machine-global fields:** `keepServerOnQuit` and `lastWorkspaceTarget`
  (`workspace/types.ts:542-554`) are machine-global "single user" cursors. Make
  `lastWorkspaceTarget` **per-user** (a user resumes their own last workspace);
  `keepServerOnQuit` stays a machine/hub pref (it's about the OS process, not a user).
- **Identity persistence is ONE hub-owned SQLite identity DB** (`server-auth/identity.db`,
  WP0 §2/§7) holding users, devices, agent credentials, memberships, and avatar data-URIs — not
  a set of JSON stores. The **hub is the sole writer** (SQLite serializes writes; WAL lets
  children read concurrently). Delete the earlier `UserStore`/`DeviceAuthStore`/
  `MembershipStore` **JSON files** as sources of truth; the store classes become thin typed
  wrappers over DB tables. No `memberships.json`, no per-child `devices.json`.
- **Push registrations** live in exact-schema `server-auth/push.db`, keyed by
  `(user_id, client_id)` with a unique FCM token. Workspace children perform row-level SQLite
  upserts/deletes under WAL instead of racing on a whole-file snapshot. There is no reader or
  migration for the retired JSON registration shape.

---

## 3. Delete dead vestiges

- **Two-port vestige:** `panelPort` is parsed but never binds (`index.ts:91,262`,
  `hubServer.ts:33`); `PanelHttpServer.setPort` has zero call sites
  (`panelHttpServer.ts:229-238`). Delete both — panels serve through the single gateway
  socket.
- **Per-child device store:** now that the hub owns identity (WP0/WP1), remove the per-child
  `{childStateDir}/auth/devices.json` provisioning in `buildWorkspaceChildEnv`
  (`hubServer.ts:739-775`); pass the child the **read-only identity-DB path** instead.
  **Keep the per-child DTLS identity + WebRTC ingress** — the hub-as-answerer/relay design was
  rejected (WP1 pivot); each child owns its own ingress, so its DTLS identity stays. (Do **not**
  remove it, and there is no `VIBESTUDIO_HUB_GRANT_KEY` to add — no HMAC grant exists.)
- **Admin-token-as-root remnants:** finish removing any human-identity use of the admin token
  left after WP9 (`index.ts:2014-2039`, `centralAuth.ts`, `hubServer.ts:876-888`) — keep only
  the diagnostic break-glass route mode.
- **Hardcoded git author** (`packages/git/src/client.ts:778-781`) — removed in WP9; confirm no
  other hardcoded-identity call sites remain.

---

## 4. Docs & skills refresh

- `STATE_DIRECTORY.md` — the **hub-owned SQLite identity DB** (`server-auth/identity.db`:
  users/devices/agent-creds/memberships/avatars/catalog), exact-schema
  `server-auth/push.db`, the host-owned transactional SQLite governance ledger
  (`governance/governance.db`, WP5 — no hash chain), and the context layout (per-slot panel
  contexts + per-runtime scratch; shared workspace DOs stay shared — WP3); remove single-user
  notes ("whole-file LWW for a single-user product").
- `docs/routes.md` — admin token = diagnostic break-glass; auth modes vs. roles.
- `README.md` — position the server as multi-user, multi-workspace; the invite-a-user flow.
- `docs/cli.md` — new CLI: `invite-user`, `pair-device`, `add-member`, `list-users`,
  workspace list/route for a user.
- `workspace/skills/remote-access/SKILL.md` — multi-user pairing, root bootstrap, membership.
- `docs/webrtc-deployment.md` — hub owns **identity/pairing/routing-signaling**; **each child
  keeps its own WebRTC ingress + DTLS identity** (hub is not a media relay — WP1 pivot).

---

## 5. Verification ladder (mirrors plan §12)

Extend the existing gates rather than inventing parallel ones:

- **Existing:** `pnpm quality:check` (type + lint + format + `check:host-boundary`),
  `pnpm test`, `pnpm smoke:full`, the remote-overhaul focused gates
  (`docs/remote-ux-overhaul-plan.md:59-67`), `pnpm test:webrtc-e2e`.
- **New multi-user scenarios (add to the ladder):**
  1. **Two users / one workspace / mutual inspectability:** both see the full panel forest,
     approve from one queue, neither blocked from the other's tree/channels/logs.
  2. **Cross-workspace membership entry gate:** a non-member is refused at the child's
     membership check (`EACCES`), `hubControl.listWorkspaces` omits it, and
     `routeWorkspace` spawns no child — coarse entry control, not inter-user isolation.
  3. **Provenance attribution across surfaces:** resolve approvals from desktop and mobile;
     assert governance records with correct `resolvedBy.userId` (incl. the fixed Electron
     path) and the settlement-coordinator `resolved` event carrying `resolvedBy`; membership
     events logged; grant reuse works cross-user.
  4. **Presence (both systems):** channel presence aggregates a user's panels into one logical
     `user:<id>`; workspace presence reflects sessions (one user, N endpoints); the two don't
     cross-wire; `check:host-boundary` proves the host presence service references no channel.
  5. **Identity invariants (data hygiene, not anti-spoof):** every `ServiceContext` carries a
     verified `subject`; a client-asserted `userId` is ignored in favor of the host-stamped one
     (single source of truth for attribution); agents inherit the spawner's `userId`.

---

## 6. Single-user-assumption audit sweep

A closing grep-style audit; each hit is either fixed or documented as intentional:

- `rg -i "single.user"` — no assertions remain (comments/tests updated).
- Whole-file writes to shared state — none outside serialized/atomic mutators (§2).
- **Broadcast that should be workspace-scoped:** confirm `EventService.emit` broadcasts stay
  **intra-workspace** (correct: one child = one workspace, mutual inspectability); confirm the
  **hub** never cross-broadcasts between workspaces, and FCM uses member-filtered exact
  `{userId, clientId}` delivery snapshots (WP4), never a machine-wide broadcast.
- **Machine-global path singleton:** `packages/env-paths/src/index.ts` `setUserDataPath`
  (`index.ts:387`) — **intentionally fine** under process-per-workspace (each child is one
  workspace); document that it must **not** be relied on if the tenancy model ever changes.
- Hardcoded identities (git author, `@user`, "Chat Panel") — all removed (WP6/WP9).
- Any `getWorkspaceId`/`workspace.config.id` used as a de-facto "the one workspace" outside a
  child — none (the hub addresses workspaces by id; children are single-workspace by design).

---

## 7. File-change checklist

| File                                                                                                                                       | Change                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/centralData.ts`, `workspace/types.ts`                                                                                 | per-record locked updates; mint opaque `WorkspaceEntry.workspaceId`; `lastWorkspaceTarget` per-user; remove single-user LWW comment                                        |
| `src/server/index.ts`                                                                                                                      | remove `panelPort` (`:91,262`), single-user comment (`:337-339`), admin-token-as-root remnants                                                                             |
| `src/server/panelHttpServer.ts`                                                                                                            | remove `setPort` (`:229-238`)                                                                                                                                              |
| `src/server/hubServer.ts`                                                                                                                  | remove `panelPort` (`:33`), per-child **device store** (`:739-775`) and pass read-only identity-DB path; **keep** per-child DTLS ingress; admin-token-as-root (`:876-888`) |
| `src/server/services/pushService.ts`                                                                                                       | replace the whole-file registration store with exact-schema `server-auth/push.db`; host-stamped ownership and exact target APIs                                            |
| `packages/shared/src/centralAuth.ts`                                                                                                       | admin token = diagnostic only                                                                                                                                              |
| `STATE_DIRECTORY.md`, `docs/routes.md`, `README.md`, `docs/cli.md`, `docs/webrtc-deployment.md`, `workspace/skills/remote-access/SKILL.md` | multi-user refresh                                                                                                                                                         |
| `scripts/full-system-smoke.mjs` + test configs                                                                                             | multi-user scenarios in the ladder                                                                                                                                         |

---

## 8. Decisions (resolved — nothing deferred)

1. **The workspace registry moves into the hub-owned SQLite** alongside identity, giving real
   multi-writer concurrency in one hub DB — the locked `data.json` is retired, not kept as a
   fallback. (No "JSON now, DO later" — one consolidated store at cutover.)
2. **`keepServerOnQuit` is a hub/machine-level operator setting** (not per-user), since it
   governs the OS process.
3. **A `check:no-single-user` CI guard ships** (alongside `check:host-boundary`) to prevent any
   single-user scaffolding from regressing back in.
