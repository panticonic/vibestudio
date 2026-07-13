# Narrow-Host Boundary Refactor — collapse the host to dumb primitives

**Status:** PARTIALLY IMPLEMENTED design record. The listed commits landed major
parts of phases 0–6, but the strict phase-6 boundary has not landed. Last
reconciled 2026-07-13; current follow-on VCS status lives in
[narrow-host-vcs-plan.md](narrow-host-vcs-plan.md).

## Target goal

The host process should provide only **dumb primitives** and ultimately hold
**no VCS semantics**. This is the target, not a description of the current tree.
It does not know what a commit, a merge, a fast-forward, an operation (push/merge/
import/delete/restore), or a lineage is. Everything semantic lives in the userland
gad-store Durable Object.

The host's entire legitimate surface is:

1. **Content store (CAS)** — content-addressed blob/tree put/get/diff/materialize.
2. **Atomic ref compare-and-swap** — `updateMains`: swap `repoPath → stateHash` iff
   current equals `expectedOld`. `next === null` removes the ref. Nothing else.
3. **Disk projection primitive** — materialize a `stateHash` onto a working tree.
4. **Disk scan primitive** — read a working tree into the CAS, returning
   `{stateHash, files}`. (The one new primitive this refactor adds.)
5. **Build execution** — validate a content-addressed state; return a report.
6. **Identity stamping** — mint/verify the on-behalf-of correlation nonce at the RPC
   relay (who the caller is), with no VCS-operation awareness.
7. **Host-enforced approval prompt** — gate a main-ref advance on user consent, with the
   prompt bound to a host-computed `diffTrees(old, next)`. This is the _one_ place the
   host stays in the write path, and it carries a content diff + a trust prompt, never
   VCS workflow semantics.

Everything else — heads, commits, merges (context-local only), fast-forward
enforcement, build gating, operation classification, provenance/lineage, delete/restore
sagas, freshness-adopt of out-of-band disk edits — moves to or already lives in the DO.

## Current implementation deviation

`WorkspaceVcs` is materially narrower than when this plan was written, and
memory indexing plus repository-view composition now have explicit
collaborators. Delete/restore/fork sagas are DO-owned and their former host test
shims are gone. The host nevertheless still owns part of conflicted-merge
resolution:

- it interprets pending-merge records during `commitHead` to select merge
  parents and the merge-resolution transition kind;
- it repairs/acknowledges provisional conflict materialization;
- it decides projection and reactive-event effects for merge/rebase outcomes;
- it synchronizes and clears the worktree conflict summary on resolve/abort.

This means the literal "no VCS semantics" goal and phase 6 remain open. The
correct next seam is not another pass-through class. It is a single contract in
which the DO returns the authoritative pending-merge transition plus explicit
projection/event instructions, allowing the host to execute dumb effects
without interpreting lifecycle state.

## Locked design decisions (user rulings, 2026-07-03)

- **D1 — No `main` checkout.** `main` is a pure ref. Context materialization already
  hardlinks trees out of the CAS (`materializeTree`), so a `main`-on-disk tree gives no
  materialization speedup. Delete the workspace-root `main` projection and the
  `project({head:"main"})` reaction. Disk is only ever a _context's_ working checkout.
  (Verify no non-build consumer reads the `main` directory before deleting — the build
  path is confirmed CAS-only: `materializeForBuild` ignores the workspace root.)

- **D2 — The workspace-root disk is the active context, not a distinct human/disk
  context.** Out-of-band disk edits and agent `vcs.edit` calls target _one_ context head
  through two channels (disk-scan and DO working rows). See "Single-context sync rule".

- **D3 — The host keeps the approval prompt, semantics-free.** `updateMains` stays
  approval-gated (NOT unconditional). The gate computes `diffTrees(currentRefValue,
proposedNext)` itself, classifies a removal from `next === null`, and raises the trust
  prompt. Any DO-supplied summary is untrusted display copy the host does not rely on.
  The DO is out-of-process untrusted userland and cannot self-certify consent, so this
  boundary must stay host-enforced. Operation classification and the delete/restore saga
  move to the DO; the `diffTrees`-based prompt core stays host-side.

## The disk-driving mechanism (why this is tractable)

The DO already holds a callback channel to host primitives via
`this.rpc.call("main", <service>.<method>)`, exposed as `contentStore()` (blobstore),
`refsStore()` (refs), and `buildStore()` (build.validate). So "DO owns semantics, host
provides primitives" is _already_ the shape for content, refs, build, fast-forward
(DO-computed ancestry), and build gating (DO decides). The gaps:

- **Disk projection** is currently a host _reaction_ to `updateMains` (`onMainsUpdated`),
  not a DO-called primitive. It suffices for ref-driven advances; keep it as a reaction
  for now, but strip its semantic shard (the `operation → transitionKind` branch).
- **Disk scan** has **no** RPC — the DO can only _receive_ `ingestWorktreeState`. This is
  the one new primitive: expose `worktreeStore.localState` (already a pure, DO-free
  scan+hash+mirror) as `blobstore`/`worktree`-service RPC `scan(repoPath, head) →
{stateHash, files}` the DO calls.

## Single-context sync rule (consequence of D2)

One context head, two input channels — must not clobber:

- The **DO working state is authoritative** for a context's uncommitted content.
- **Projection** (DO working state → disk) keeps the checkout in sync with the DO.
- **Scan** captures only genuine _external_ drift: files on disk that differ from the
  last projected DO working state become additional working edits on the same context
  head (adopted via the DO, not a main advance). The scan diffs disk against the
  projected baseline (sidecar), so re-adopting already-projected DO edits is a no-op.
- Invariant to hold: after a `vcs.edit` the DO projects to disk (or marks the checkout
  stale) so a subsequent scan never mistakes un-projected DO edits for a disk deletion.

## Keep / Move / Delete register (condensed; see per-phase for detail)

**KEEP (host primitives):** `ProtectedRefStore` CAS core (stripped to
`repoPath→stateHash` map +
atomic replace + compare-and-swap); all of `blobstoreService` (incl. `diffTrees`);
`diskProjector.project`/`removeRepo`/`writeConflictSummary`/`dirForRepoHead`;
`worktreeStore.localState`/`materializeState` + content helpers; `paths.ts`,
`repoDiscovery`, `workspaceTreeScanner`; identity-nonce mint/resolve (minus operation
awareness); the host-enforced approval prompt built on `diffTrees`.

**MOVE to the DO:** operation classification + ref `log[]` + provenance/`seq`/`priorDeleted`
in `ProtectedRefStore`/`refsRpcService`/`vcsInvocationTable`; the delete/restore/fork sagas
(the `updateMains` CAS calls stay primitive); freshness-adopt orchestration
(`commitHead`/`commitMainHead`/`prepareMainScan`/`ensureFresh`, using the KEEP scan
primitive); host/DO-duplicated composition (`composeRepoStatesLocal`/`workspaceView`)
and lineage walks (`upstreamCommitsBetween*`); the `operation→transitionKind` shard in
`onMainsUpdated`; `mainAdvanceApproval`'s classification/saga logic (its `diffTrees`
prompt core stays).

**DELETE outright:** main-target merge (`mergeGroup`/`mergeIntoMainHead`/
`callMainTargetMerge`/`runVcsMergeMain`/DO `vcsMerge(main)` + `operation:"merge"` + main
pending-merge machinery); `advanceMainRef`; the whole main-provenance reconciliation
suite (`syncMainProvenance`/`recordMainAdvance`/`enqueueMainRecord`/durable-records/
`flushMainProvenance`/`mainWorktreeHead`); `seedMainRefsFromStore`; the `main` disk
projection (D1).

## Phased implementation (each phase ends green: host typecheck, `pnpm --dir workspace

type-check` ×3 programs, host + workspace VCS suites)

**Phase 0 — Delete main-target merge.** Independent, fully settled. Remove
`mergeGroup`/`mergeIntoMainHead`/`callMainTargetMerge`/`runVcsMergeMain`, reject
`vcsMerge` main target, strip `operation:"merge"` + main pending-merge machinery. Keep
ctx-merge + FF-push. Confirm the push `diverged`→pull→ctx-merge→re-push loop is complete.

**Phase 1 — Add the disk-scan primitive (enabling infra, no behavior change).** Expose
`worktreeStore.localState` as a host RPC `scan(repoPath, head)` the DO can call; confirm
`project` is DO-reachable. Nothing consumes it yet. Green trivially.

**Phase 2 — Freshness-adopt → DO + workspace disk = active context + drop main checkout
(D1, D2).** The DO owns scan-adopt: it drives the host `scan` primitive and records
external drift as working edits on the active context head (never an ungated main
advance). Repoint `dirForRepoHead("main")` off the workspace root; the workspace root
becomes the active context's checkout. Build trigger builds the context view. Delete the
`main` disk projection. Implement the single-context sync rule. This closes the ungated
`SYSTEM_ADVANCE` disk→main door.

**Phase 3 — Consolidate main lineage into the DO.** With freshness no longer advancing
main host-side, all main advances are DO-driven via `updateMains`. Delete the host
main-provenance reconciliation suite and `advanceMainRef`/`seedMainRefsFromStore`; the DO
records main transitions synchronously in its publish-intent path.

**Phase 4 — Move delete/restore/fork sagas into the DO.** The `updateMains{next:null}` /
`{expectedOld:null}` CAS calls stay host primitives; archive/dependent-gate/compensation/
fork-rename move to the DO.

**Phase 5 — Reduce `updateMains` to a semantics-free CAS + semantics-free approval.**
Strip operation-awareness, the ref `log[]`, provenance side-effects, and the projection
reaction's semantic shard out of `updateMains`. Keep the approval gate but rebuild it on
host-computed `diffTrees(old, next)` + `next===null` classification + trust prompt; the
DO supplies untrusted display summary only. Move the ref log/provenance to the DO.

**Phase 6 — Consolidate duplication + final dead-code sweep.** Delete host
composition/lineage duplication now owned by the DO; relocate `stateAdvancedEvent`
semantics; audit for orphaned exports.

**Dependencies:** 0 independent; 1 → 2 → 3 → 5; 4 independent after 3; 6 last. 0, 1, 4 can
overlap; 2 is the largest and riskiest.

## Breaking-changes register (to be finalized per phase)

- Public/internal main-target merge surface removed (Phase 0).
- `refs.updateMains` operation set loses `merge` (Phase 0), then all operation-awareness
  (Phase 5) — becomes a pure CAS + `next===null` delete.
- Workspace-root disk semantics change: it projects the active context, not `main` (D2);
  `main` has no checkout (D1).
- The freshness scan no longer advances `main`; out-of-band disk edits adopt into the
  active context and must be pushed (Phase 2).
- Host `vcs` service continues to shed methods as semantics move to the DO.

## Downstream: provenance-graph workstream impact

(`docs/gad-provenance-handoff-2026-07.md` — simplification takes precedence; the
downstream adapts.)

- **Aligned / preserved:** the provenance contract (items 1–7) is entirely DO-side —
  `gad_worktree_edit_ops` semantics, ingest `editOps`, event-keyed ancestry, history
  reads, per-repo logs + `ctx:` restriction, claims/FTS, `invocationId` threading. Our
  refactor consolidates these _into_ the DO and never deletes them. The "no-intent
  crash-heal → fail closed" stance (handoff A2) is already ours.
- **CLASH — the host main-ref `log[]` is removed (Phase 5).** Handoff "new signal #1"
  wants to consume the host main-ref log (`writer`/`onBehalfOf`/`reason`/`operation`/
  nullable `new`) as _host-verified_ main-movement attribution. Phase 5 strips that log
  (provenance moves to the DO). **Resolution:** the host-verified _principal_ survives —
  it rides the `VcsInvocationTable` on-behalf-of token, which is KEEP (identity stamping).
  The DO records each main advance stamped with that host-minted token, so the provenance
  graph re-sources main-movement attribution from the DO's advance records (token-carried)
  instead of a host-side log. The host-verification property is preserved; only the
  storage location moves. Downstream adapts.
- **Relocation — freshness-adopt now targets a context (Phase 2), not `main`.** Handoff
  A2's "main-advance ingests carry `editOps`" partly assumed the freshness scan feeds
  `main`. Now out-of-band disk edits adopt into the active context (with full edit-op
  provenance) and `main` advances only via push — strictly _better_ for blame (attributable
  context edits), but the downstream must expect main-movement provenance only from
  push/merge, not from scan.
- **Main-target merge deleted (Phase 0)** removes one provenance case; ctx-merge
  provenance (handoff A2/A3, the diff3 chunk machinery) is untouched and preserved.
- **Fold into our phases:** A5 (demote/delete caller-supplied `pruneUnreferenced` — a
  loaded gun over the shared CAS) → Phase 6 cleanup. A4 (`indexRepoFiles` marker bug:
  a transient blob miss permanently un-indexes) → fix when that host code moves to the DO.
  A1 (GC edit-ops hole) is already fixed in this tree.

## Open risks / to-confirm during implementation

- Confirm no non-build consumer reads the `main` directory before deleting its projection
  (audit `distBake.ts` and direct `workspaceRoot` readers).
- Single-context sync (D2): pin the projection-after-edit invariant so scan can't misread
  un-projected DO edits as disk deletions; preserve the sidecar fast-path on the scan.
- Bootstrap/import adoption currently seeds `main` from disk with nothing to fast-forward
  from — decide whether it keeps a narrow ungated adoption door or seeds a context then
  auto-pushes.
- Main-merge deletion (Phase 0) must not regress the ctx-merge/abort/pending machinery.
