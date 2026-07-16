# WP3 — Per-User Panel-Tree Forest (implementation spec)

Companion to `docs/multi-user-workspaces-plan.md` (§2.4) and `docs/multi-user-wp0-user-identity-spec.md`
(`caller.subject.userId`; `entities.owner_user_id` introduced in WP0 §6). Supports **N
user-owned panel trees in one workspace simultaneously, with mutual complete
inspectability** — any user sees any user's tree; no trust boundary inside the workspace.

Design stance: **keep one `WorkspaceDO` per workspace** (needed for cross-visibility), add an
**owner** dimension, group roots into a **forest**, and **keep the global broadcast** — it is
exactly what mutual visibility wants. The change is *attribution + representation*, not
delivery or isolation.

---

## 1. Scope & exit criteria

> **Delivery (governed by plan Status):** part of a **single big-bang cutover** — not staged,
> no gates, no optionality, nothing deferred, **no legacy/compat left standing**. Every choice
> here is decided; the single-user structures it touches are deleted, not adapted.

**In scope:** `owner_user_id` on `slots` (and confirm on `entities`); owner-tagged reads;
forest grouping in the tree reconstruction; `owner` on `Panel`/`PanelTreeSnapshot`; stamp
owner from the creating caller's subject; forest rendering in the shell; per-runtime scratch
for ephemeral view state (concurrent-session clobber fix — shared DOs stay shared); per-user
seeding.

**Out of scope:** the `subject`/`userId` binding (WP0); fan-out (broadcast kept as-is, WP4);
per-user presence UI (WP8, which consumes owner data).

**Exit criteria:**
1. Two users in one workspace each own a distinct tree; both see **both** trees (a forest),
   grouped by owner.
2. Creating/moving a panel stamps the acting user's `userId` as owner; authorization stays
   permissive (mutual trust — any user may restructure any tree; only attribution is added).
3. Shared singleton DOs stay a single shared instance (no per-user fragmentation); two live
   sessions viewing the same shared view do not clobber each other's ephemeral view state.
4. The content-addressed build store is unchanged and shared.

---

## 2. Data model — `WorkspaceDO`

Bump `WorkspaceDO.schemaVersion` (`src/server/internalDOs/workspaceDO.ts:272`; destructive
clean-cut migration `:463`). Add owner columns:

```sql
-- slots (workspaceDO.ts:335-345) — add:
ALTER intent: owner_user_id TEXT       -- the user whose tree this slot belongs to (NULL only for pre-identity/system)
-- entities (workspaceDO.ts:307-324) — owner_user_id already added in WP0 §6 (stamped at entityActivate)
CREATE INDEX IF NOT EXISTS idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL;
```

`DbSlotRow` (`workspaceDO.ts:53-62`) and `DbEntityRow` (`:27-43`) gain `owner_user_id`.

- **`slotListOpen()`** (`workspaceDO.ts:1433-1444`) returns owner-tagged rows — it still
  returns **all** open slots (mutual visibility), now each carrying `owner_user_id`. An
  optional `{ owner }` filter is available for "just my tree" views but is **not** the
  default.
- **Owner is stamped at slot creation** from the creating caller's `subject.userId`
  (threaded from `panelTreeService` → `workspace-state`). Slots inherit the owner of the user
  who opened them; a panel opened by an agent inherits the agent's owning user (WP0 §6).

---

## 3. Forest reconstruction

The single "all null-parent slots = one tree" collapse becomes "group null-parent slots by
owner = a forest of N trees":

- **`PanelManager.fetchPanelTree()`** (`packages/shell-core/src/panelManager.ts:936-1027`;
  null-parent→root at `:1005-1011`) groups roots by `owner_user_id` into
  `Map<userId, Panel[]>`. Non-root slots still attach by `parent_slot_id` regardless of owner
  (a subtree stays whole).
- **`PanelRegistry.getPanelTreeSnapshot()`** (`packages/shared/src/panelRegistry.ts:102-107`)
  returns an owner-grouped snapshot.
- **Types** (`packages/shared/src/types.ts`):
  ```ts
  interface Panel { /* … */ owner?: string; }                 // :319 — userId
  interface PanelTreeSnapshot {
    revision: number;
    forest: Array<{ owner: string; rootPanels: Panel[] }>;    // replaces the flat rootPanels
  }
  ```
  (Clean cut: `rootPanels` is replaced by `forest`; no compatibility shim. **Sweep all
  `rootPanels` consumers** — `rg "rootPanels" src workspace packages` — serializers, tests,
  and any panel reading the snapshot must move to `forest`; the four shell files in §9 are the
  render sites, not the full set.)

---

## 4. Mutation, authorization, broadcast

- **Stamp, don't gate.** `panelTreeService.ts` (`METHOD_ACCESS` `:30-46`,
  `requirePanelAccessPermission` `:181`) gains the acting `subject.userId` and stamps it as
  `owner` on `create`/`move`. Authorization stays **permissive** — per the mandate there is
  no trust boundary inside a workspace, so any member may restructure any tree; only
  attribution is recorded. (A future "soft-lock my tree" affordance is an easy additive
  policy, out of scope here.)
- **Broadcast unchanged.** `emitTreeSnapshot` (`panelRuntimeRegistration.ts:355-357`) keeps
  broadcasting the full snapshot to every client via `EventService.emit` (WP4 confirms
  intra-workspace broadcast is correct). Every client converges on the same forest — mutual
  inspectability by construction. The self-heal resync (`panelRuntimeRegistration.ts:380-411`)
  is unchanged.
- **Writes still go through the server bridge** (`WorkspaceDO.assertInboundAllowed` refuses
  non-`server` callers, `workspaceDO.ts:289-299`); no client writes the DO directly.

---

## 5. Shell forest rendering

- **`PanelTreeProvider`** (`workspace/apps/shell/shell/hooks/PanelTreeContext.tsx:396-452`)
  consumes the owner-grouped `forest` and exposes it grouped. `applyTreeSnapshot` (`:424-436`)
  stays monotonic-revision-guarded.
- **Render one section/column per owner** (e.g. a labelled band with the owner's handle/color
  from WP6). `PanelApp.tsx`, `PanelStack`, `LazyPanelTreeSidebar` render the forest; a user's
  own trees are visually primary, others' are visible and inspectable.
- **Panel render leases are unchanged** (`PanelRuntimeCoordinator` — one host renders a panel
  at a time, `panelRuntimeCoordinator.ts`); leases arbitrate *who renders*, orthogonal to
  *who owns*.

---

## 6. Context model — shared stays shared; sessions don't clobber

The trusted framing (plan §0.0) means we do **not** partition state per user for isolation —
shared workspace state is a *feature*. The only real defect here is **concurrent-session
clobber**: two live sessions viewing the *same singleton view* fighting over one piece of
ephemeral view state. The fix is per-session view state, **not** a per-user salt on shared
DOs.

- **Per-panel contexts** are already unique per slot: `generateContextId(slotId)` =
  `ctx-${slotId}` (`packages/shared/src/panelFactory.ts:199-206`). Since a slot belongs to one
  owner's tree, two users each opening their own panel of the same app already get distinct
  contexts with zero added machinery. No change.
- **Shared singleton DOs stay shared — no salt.** Deterministic DO/app contexts
  (`src/server/index.ts:2295-2300`, `appHost.ts:2276-2301` — sha256 over `workspaceId \0
  source \0 className \0 objectKey`) remain keyed exactly as today. An explicitly-addressed
  singleton workspace DO is *meant* to be one shared instance every member reads and drives
  (mutual invocation, plan §0.0). **Do not salt it by `userId`** — that would fragment the
  shared surface the product wants.
- **Concurrent-session view state** (cursor, scroll, transient selection in a shared view)
  belongs to the *session/runtime*, not the shared DO — it lives in the panel's per-slot
  context (above) or a per-runtime scratch keyed by the runtime id, so two sessions never
  clobber each other. Durable app data stays in the shared DO. This is the one concrete change:
  route ephemeral view state to per-runtime scratch, leaving shared durable state shared.
- **Readable across users:** all context folders live under the one workspace state dir
  (the current-epoch projection root); nothing here restricts cross-user reads — the workspace is a shared space by
  construction.
- **Build store unchanged.** `buildV2/buildStore.ts` keys on `(unit, effectiveVersion,
  sourcemap)` (`effectiveVersion.ts:399-407`) with no user/context/panel dimension — two
  users on the same unit+version share one build, GC unions across all live users. No change.

---

## 7. Seeding

`seedPanelTreeIfEmpty` (`panelRuntimeRegistration.ts:202-263`) becomes per-user: a user's
first attach seeds *their* init tree from `workspaceConfig.initPanels` under their
`owner_user_id`, rather than a single global init multiset. Root's tree seeds at workspace
first-run; each invited user's tree seeds on first attach.

---

## 8. Testing

- **Forest visibility:** two users open panels; each `getTreeSnapshot` returns a 2-owner
  forest; both see both trees.
- **Owner stamping:** a panel created by user A has `owner === A`; one an agent-of-A opens
  inherits `owner === A`.
- **Permissive restructure:** user B moves a panel in A's tree — allowed (no trust boundary);
  a subtree moved into another user's tree **re-owns to the destination root's owner** (§10.1).
- **Shared DO stays shared:** two users addressing the same singleton workspace DO resolve to
  **one** context/instance; a write by A is visible to B (no per-user fork).
- **No session clobber:** two sessions on the same shared view each keep independent ephemeral
  view state (per-runtime scratch); durable shared state converges.
- **Build sharing:** two users on the same unit+version resolve to one build key.
- **Broadcast:** a mutation by A converges B's forest view (revision monotonic).

---

## 9. File-change checklist

| File | Change |
|---|---|
| `src/server/internalDOs/workspaceDO.ts` | `slots.owner_user_id` (+ index), `DbSlotRow`/`DbEntityRow`, `slotListOpen` owner-tag, schemaVersion bump; stamp owner on slot create |
| `packages/shell-core/src/panelManager.ts` | `fetchPanelTree` groups roots by owner into a forest |
| `packages/shared/src/panelRegistry.ts` | owner-grouped snapshot |
| `packages/shared/src/types.ts` | `Panel.owner`; `PanelTreeSnapshot.forest` (replaces `rootPanels`) |
| `src/server/services/panelTreeService.ts` | stamp `owner` from `subject.userId`; authz stays permissive |
| `src/server/panelRuntimeRegistration.ts` | per-user `seedPanelTreeIfEmpty`; snapshot emit carries forest |
| `workspace/apps/shell/shell/hooks/PanelTreeContext.tsx` + `components/PanelApp.tsx`, `PanelStack`, `LazyPanelTreeSidebar` | render the forest grouped by owner |
| `src/server/appHost.ts` (+ runtime scratch) | route ephemeral view state to per-runtime scratch; deterministic shared-DO contexts unchanged (no user salt) |

---

## 10. Decisions (resolved — nothing deferred)

1. **Move-across-owners:** when a panel is moved into another user's tree, the subtree
   **re-owns** to the destination root's owner (the tree it now lives in).
2. **Visual grouping:** labelled bands per owner, own-first (others' trees visible and
   inspectable below).
3. **Orphaned trees on user revocation:** a revoked user's trees are **archived** (soft-closed,
   root-recoverable) — not deleted, not transferred (WP9 §6.5).
