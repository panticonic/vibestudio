# Narrow-host boundary refactor — Phase 2 revision: kill `ctx:workspace`, restore dev extraction

**Status:** SPEC (2026-07-03). Revises the Phase 2 disk/context model committed in
`1ca740ae`/`f1be8e9e`. Builds on and supersedes the "workspace disk = active
context" decision (D2) in `docs/narrow-host-boundary-refactor-plan.md`.

## Why

Phase 2 made the workspace-root disk an editable "active context" (`ctx:workspace`)
and adopted out-of-band disk edits into it via a freshness scan. That was the wrong
model, and it also **regressed dev extraction**: deleting the `main → workspace/`
projection means changes made in a dev session no longer flow back to the monorepo.

Correct model (user, 2026-07-03):

- **Humans don't edit the workspace tree directly.** All edits happen through entities
  (panels / agents / DOs) in their own per-entity `ctx:{id}` contexts.
- **`workspace/` is a persistent *source dir*, used as a one-way bridge in dev:**
  - **IN (boot):** the ephemeral workspace bootstraps *from* `workspace/` — the host
    reads it once to seed + persist `main` refs, then work happens in CAS/DO/contexts.
  - **OUT (push):** on a **push to `main`**, the new main state is projected *out* to
    `workspace/` so changes are extracted back into the real monorepo. Then teardown.
- **Nothing is editable/scanned in between** — no `ctx:workspace`, no freshness scan.
- **Git import goes to the caller entity's context**, not a host-level workspace watcher.
- **Repo discovery comes from the ref table (`listMains`)**, not a disk scan.

D1 ("`main` is a pure ref, no editable checkout, no ungated disk→main scan-back") still
holds — the `main → workspace/` export is **write-only extraction**, not a checkout.

## Changes

### 1. Delete `ctx:workspace` / the active-context concept
- `src/server/vcsHost/paths.ts`: remove `VCS_ACTIVE_CONTEXT_ID` / `VCS_ACTIVE_CONTEXT_HEAD`.
- `src/server/vcsHost/diskProjector.ts`: remove the `activeContextId` dep and the
  `ctx:workspace → workspaceRoot` mapping in `dirForRepoHead`. Per-entity `ctx:{id}` heads
  keep projecting to `.contexts/{id}` (unchanged). `main` keeps throwing for the general
  checkout path (see §3 for the dedicated export).
- `src/server/vcsHost/workspaceVcs.ts`: remove all `VCS_ACTIVE_CONTEXT_HEAD` references
  and the `activeContextId` wiring into the projector.

### 2. Delete the freshness scan
- Remove `snapshotRepoLogsFromDisk` and the disk-adoption body of `ensureFresh` /
  `ensureFreshUncoalesced`. There are no out-of-band disk edits to adopt.
- The build trigger's `ensureFresh` contract (`buildV2/stateTrigger.ts`) becomes "return
  the current `main` view" (composed from refs + CAS) — no scanning, no commit. Keep the
  coalescing shell only if a caller still needs a cheap "current main state" accessor;
  otherwise inline `workspaceView()`.

### 3. Restore the `main → workspace/` export (write-only, dev-gated)
- On a **main advance**, project each changed repo's new main state out to the source dir
  `workspaceRoot/{repoPath}`. This is what Phase 2 wrongly deleted from `onMainsUpdated`.
- Implement as a **dedicated export path**, NOT by reviving a general `dirForRepoHead(main)
  → workspaceRoot` mapping (main must stay a non-checkout for all context logic). E.g. a
  `WorkspaceVcs.exportMainToSource(repoPath, stateHash)` that materializes the state into
  `workspaceRoot/{repoPath}` via the existing projection primitive, called from the
  `onRefsChanged` → `onMainsUpdated` reaction for each advanced ref (and `removeRepo` on a
  `stateHash === null` removal).
- **Gate on a configured source/extraction dir (dev mode).** Production ephemeral
  workspaces have no persistent source dir to extract to — find the existing signal (the
  `workspaceRoot` wiring in `src/server/index.ts` / a dev/NODE_ENV flag) and gate on it. If
  the correct gate is ambiguous, STOP and surface it rather than exporting unconditionally.
- Write-only: nothing ever scans `workspace/` back into `main` except the one-time boot
  seed (§4).

### 4. Bootstrap (IN) — keep, decouple from `ctx:workspace`
- Keep the host reading `workspace/` once at init to seed + persist `main` refs
  (`ensureRepoLogsFromDisk` → scan folder → `refs.seedMain`).
- It currently reads subtrees through `dirForRepoHead(_, VCS_ACTIVE_CONTEXT_HEAD)`; retarget
  it to read the source dir (`workspaceRoot/{repoPath}`) directly, so bootstrap no longer
  depends on the deleted `ctx:workspace` mapping.
- Decouple from DO-attach where feasible: the ref *value* is host-computed from disk and
  should be seedable without gating on the DO; the DO gad-log/provenance entry can be
  established when the DO is available. If fully decoupling is large, keep the current
  ordering but REPORT it — the ref seed must not silently require the DO to be a ref-value
  source. `seedMainRefsFromStore` (seeding refs FROM the DO head rows) should be removed
  once bootstrap-from-disk + the persisted store cover it; if a residual gap-fill is still
  needed, report why.

### 5. Git import → the caller entity's context
- Today git import rides the host-level `onWorkspaceSourceChanged` → freshness path. Re-scope
  it so an import writes into the **caller entity's `ctx:{id}`** via the normal edit/commit
  path (the entity that initiated the import owns the change; it then pushes to main).
- Investigate the current import trigger/mechanism first. If import is genuinely
  caller-initiated (an RPC), route its writes to `callerContextId`'s head. If it's currently
  a host filesystem/config watcher with no caller, that trigger model itself must change —
  STOP and surface it as a design fork with your findings rather than guessing the trigger.

### 6. Repo discovery → the ref table
- Change ongoing "which repos exist" consumers from disk-scan (`discoverReposFromDisk` /
  `scanWorkspaceRepoPaths`) to `refs.listMains()`. The disk scan survives ONLY as the
  one-time boot seed (§4). Audit callers of the disk-discovery helpers and repoint them.

### 7. Build default target → `main`
- `bindRuntimeImage` / `stateTrigger` build `main` by default (composed from refs + CAS,
  no checkout); per-entity builds serve `resolveContextView(ctx:{id})`. Revert Phase 2's
  "build the active-context view" default.

## Stays untouched (the parts that were right)
Semantics-free `updateMains` CAS; no host main-provenance suite; delete/restore/fork sagas
in the DO; DO owns all VCS semantics; host-enforced semantics-free approval; the invocation
token model. `main` remains a pure ref for all VCS logic — the export is a separate dev bridge.

## Tests
- **Extraction e2e (regression guard):** edit in a context → commit → push to main → assert
  the change appears on disk in `workspaceRoot/{repoPath}`. This is the flow Phase 2 broke.
- **Bootstrap:** fresh workspace seeds `main` refs from the `workspace/` folder (host-only,
  no `ctx:workspace`).
- **Import:** an import lands in the caller entity's context (not a workspace context) and
  is absent from `main` until pushed.
- **Discovery:** repo enumeration reflects the ref table (a repo added via fork/import is
  discovered without a disk re-scan).
- Remove/replace the `ctx:workspace`-based freshness/bootstrap tests from the Phase 2 commit.

## Breaking-changes delta (vs the Phase 2 commit)
- `ctx:workspace` / `VCS_ACTIVE_CONTEXT_*` removed; workspace-root disk is no longer an
  editable context checkout.
- Freshness scan removed; no out-of-band disk→context adoption.
- `main → workspace/` export restored (dev-gated, write-only).
- Git import re-scoped to the caller context; repo discovery sourced from the ref table.
