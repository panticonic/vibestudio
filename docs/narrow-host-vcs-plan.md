# Narrow-Host VCS: refs-only host, gad-owned semantics

STATUS (2026-07-03, updated same day): ALL PHASES IMPLEMENTED in this tree
(uncommitted). P1 (host write primitive incl. single-writer `updateMains`,
invocation tokens, batch gate), P2 (build.validate/statusAt), P3 (gad push/merge
orchestration as the live executor + reactive projection + host push-pipeline
demolition + attach-time self-heal), P3.5 (diff review UI + diffReview payload
integration), P4 (staged git import — `adoptImportedRepo`/`adoptMainFromStore`
DELETED, extension ingest confined to non-main heads; delete/restore via
gate-classified `updateMains`; owner-derived GC), and P5 (dead-code sweep + docs
reconciliation + §10 acceptance run) are all landed and green.

P4 lifecycle scope note: delete/restore ref movement runs through the SAME
`updateMains` batch primitive as push, but via an IN-PROCESS caller-context host
call (the fork/lifecycle path), NOT a DO RPC — there are no userland delete/restore
callers, so no second RPC writer was introduced; the severe delete/restore prompts
are still host-owned (gate-classified from the ref log). Archives/tombstones and
resurrection policy are gad-owned. Lifecycle + import consolidated in one pass.

See also docs/gad-provenance-handoff-2026-07.md for constraints P3–P5 preserved.
This plan supersedes the "HOST REMNANTS (permanent, by design)" section of
`docs/blob-addressed-cleanly.md` (annotated there with a dated pointer back here) —
push/merge orchestration is NOT a permanent host remnant; it moved into the gad
userland VCS. Pre-release: no backward compatibility, replaced paths are deleted
outright (see the breaking-changes register at the end).

Decisions locked with the user:

1. The host does NOT gate ref advancement on builds. Build validation is a userland
   (gad) responsibility; the host offers builds as a pure service over CAS tree hashes.
2. Ref advance/delete is restricted to a SINGLE WRITER: the gad-store DO backing the
   workspace `vcs` service declaration. No other userland caller can move main.
3. Approval prompts attribute the ORIGINATING principal ("on behalf of"), resolved by
   the host from its own dispatch records — never asserted by the DO.
4. Fast-forward-only, clean-source, deletion-resurrection, and provenance recording
   stop being host guarantees; they are gad conventions backed by the host approval
   prompt (the user sees a truthful, host-computed diff for every advance).

---

## 1. Motivation

The 2026-07 security review found three issues that share one root cause: the system
never committed to who publishes protected main. Four mutation paths existed
(public `refs.advanceRef`, the former host `vcs.push`/`vcs.merge` paths,
extension-reachable `vcs.adoptImportedRepo`, internal system advances), each
enforcing a different subset of invariants:

- **Finding 1**: sandboxed callers could mint content trees and advance protected main
  through public `refs.advanceRef`, bypassing every push invariant.
- **Finding 2**: any extension could ingest a lineage into gad-store and call
  `adoptImportedRepo`, moving main with a SYSTEM (ungated) advance.
- **Finding 3**: group push claims all-or-nothing refs+provenance but advances refs
  first and cannot roll back after a provenance ingest failure — because the host
  insists on writing BOTH stores.

Instead of hardening each path, this plan makes the class unrepresentable: exactly one
write path, one authority, one approval gate — and a host too small to contain VCS
bugs.

## 2. Target architecture

```
                    sandboxed callers (panel / app / worker / extension)
                                        │  vcs.* (userland dispatch, host-mediated,
                                        │         invocation token minted per dispatch)
                                        ▼
   ┌────────────────────────  gad-store DO (userland VCS)  ───────────────────────┐
   │ commit graph, merges, fast-forward policy, divergence, clean-source checks,  │
   │ candidate composition, build orchestration, provenance, archive/tombstones,  │
   │ git import, crash self-heal from refs                                        │
   └───────┬───────────────────────┬──────────────────────────┬───────────────────┘
           │ blobstore.*           │ build.validate(viewHash)  │ refs.updateMains
           │ (content CAS)         │ (pure fn, cached)         │ (token = on-behalf-of)
           ▼                       ▼                           ▼
   ┌─────────────────────────────  HOST (trusted core)  ──────────────────────────┐
   │ content store (validity + GC roots)                                          │
   │ build service over tree hashes                                               │
   │ main-ref table: repoPath → stateHash                                         │
   │   • readMain / listMains (any caller)                                        │
   │   • updateMains: atomic group CAS + delete, APPROVAL-GATED, single-writer    │
   │ approval UI (host-computed diffs, on-behalf-of attribution)                  │
   │ disk projection + context instantiation from mains                           │
   └──────────────────────────────────────────────────────────────────────────────┘
```

The host knows: content hashes, one canonical `main` state per repo path, how to build
a tree, how to project a tree to disk, and how to ask the user. It does not know what
a commit, merge, branch, fast-forward, or import is.

### 2.1 Host ref surface (replaces the generic RefService namespace)

The `(repo, ref)` namespace and public `advanceRef` are deleted. The replacement is a
main-only table with three methods:

```
refs.readMain(repoPath)          -> { stateHash, seq, updatedAt } | null     [any caller]
refs.listMains()                 -> [{ repoPath, stateHash, seq, ... }]      [any caller]
refs.updateMains({                                                            [vcs DO only]
  entries: [{ repoPath, expectedOld: string|null, next: string|null }],
  reason: string,
  operation: "push" | "merge" | "import" | "delete" | "restore",
  invocationToken?: string,        // on-behalf-of (see §4); absent = DO self-initiated
}) -> { updated: [...] } | throws RefConflictError (per-entry conflicts reported)
```

Semantics of `updateMains`:

- **Atomic group CAS.** All entries validate (`expectedOld` matches current, including
  `null` = must-not-exist) inside one critical section over the whole batch; the
  store persists all entries in ONE atomic file replace (the existing
  persist-then-adopt commit in `refService.ts` already works this way — the group
  form just widens the write set). Any entry conflict fails the whole batch with a
  structured per-entry report. No partial advance, and the batch primitive itself
  carries no internal rollback: there is nothing to roll back because nothing else
  is written. NOTE (verified 2026-07-03, known deviation from a strict reading): the
  DELETE/RESTORE lifecycle is a host-level TWO-step (retire the ref via `updateMains`,
  then archive the store lineage in the DO), and a failed archive after a landed ref
  delete is undone by a host-level COMPENSATING ref write — `WorkspaceVcs.compensateMainRef`
  (`workspaceVcs.ts:736`, called at `:2849`/`:2970`) re-creates/re-advances the ref so
  a repo never vanishes from refs while its store main is still live. That is a
  compensating write across the ref↔archive boundary, not intra-batch rollback, but
  it IS rollback machinery that exists in the tree — §7's "no rollback machinery"
  applies only to the deleted PUSH pipeline, not to this delete-lifecycle path.
- **`next: null` deletes the main ref** (repo leaves the workspace). Deletion joins
  the same atomicity and the same batch — a mixed batch (advance A, delete B) is one
  approval and one commit.
- **Validity check before approval**: every non-null `next` must be a well-formed tree
  fully present in the content store (all referenced objects exist). Userland can
  never claim a hash the store cannot expand (`blob-addressed-cleanly.md` line 288).
  Refs are GC roots; the ref table pins them. Mains are NOT the only live content,
  though: gad holds staging lineages, context heads, archives/tombstones, import
  staging, and pending-publish intents that must survive GC. RESOLVED (P4,
  2026-07-03): NO host-side pin/unpin RPC is needed — the GC mark already runs
  INSIDE the vcs DO (`runGadGcMark`) over gad's OWN tables, so every gad-held
  live class is rooted OWNER-DERIVED. Verified enumeration (live class → rooting
  mechanism):
  - working edits (uncommitted): `gad_worktree_edit_ops` where
    `committed_event_id IS NULL` (new_content_hash + old_content_hash) — both the
    blob-candidate exclusion and the `liveBlobDigests` union (fixed per A1).
  - context heads (`ctx:*`), main heads, ARCHIVES (`archived:*`), and import
    STAGING heads: `listWorktreeHeads({})` roots EVERY `gad_worktree_heads` row
    regardless of head name; the ancestor + manifest closure then retains each
    lineage's history states and file versions.
  - pending-publish intents: `gad_publish_intents.entries_json` (`next` +
    `parentStateHash`) rooted before the CAS lands / provenance is recorded.
  - pending merges: `state` rows `merge:%` (ours/theirs/base/provisional).
  - conflict summaries + freshly-minted staged states: provisional merge states
    (above) + the creation-grace window over `gad_worktree_states`.
  The root set is therefore host mains + registered context heads + the DO's
  owner-derived mark — there is no separate host-persisted gad-declared root set.
  CORRECTION (2026-07-03): content-store GC is ALREADY LIVE (`VcsGcScheduler`,
  hourly, 24h min-age, owner-derived roots via `runGadGcMark`) — the original
  "stays disabled until P4" assumption was wrong. Consequences: (a) the known
  live-set hole over uncommitted working-edit content
  (`gad_worktree_edit_ops.new_content_hash` is absent from the mark union — see
  docs/gad-provenance-handoff-2026-07.md A1) must be fixed NOW, not at P4;
  (b) P3/P4 must extend the mark set in the SAME change that introduces any new
  unreachable-from-mains state (pending-publish intents, import staging,
  archives) — never land the state first and the root later; (c) "GC never
  collects a gad-declared root or ref-log-reachable state" joins the acceptance
  tests.
- **Approval before commit** (§5). The prompt covers the whole batch.
- **Ref log** retained per repoPath (seq, old, new, writer, on-behalf-of, reason,
  operation, timestamp) — it is the workspace's audit trail of main movement.
  `new` is NULLABLE: a delete entry records `new: null` (and a subsequent
  re-creation records `old: null`), which is exactly what §5's log-derived restore
  classification reads. The current schema (`serviceSchemas/refs.ts:45`) models
  `new` as non-null; the replacement schema changes this — log consumers are
  in-tree only and updated with it.

Optimistic concurrency replaces lock-holding FOR ORCHESTRATION: gad composes and
builds a candidate outside any host lock, then CASes; a lost race is a normal
`RefConflictError` — gad re-reads mains, re-validates (rebase/re-merge/rebuild),
and retries. The host's per-batch critical section is validity check → approval →
swap. To be explicit: the approval prompt IS inside that serialization (as it is
inside today's per-ref queue in `refService.ts` — the CAS precondition must stay
stable while a possibly-long human decision is pending; §11 notes the
validate→prompt→re-validate alternative if contention ever matters). What the
critical section NO LONGER contains is everything today's push pipeline holds locks
across: builds, gad round-trips, and group orchestration.

### 2.2 Host build surface

Two surfaces, one store:

- `build.validate({ viewHash, repoPaths, baseViewHash? }) -> RepoBuildReport[]`,
  exposed to the vcs DO. NOT keyed by viewHash alone: today's push-validation
  semantics are parameterized — `repoPaths` decides pushed-vs-dependent roles
  (pushed buildable units gate absolutely; content-only skip) and `baseViewHash`
  drives the dependent regression gate (a dependent also red on the base is
  pre-existing/informational; with no base, failed dependents gate absolutely) —
  see `buildV2/index.ts:807`. The full report set is keyed by the triple; the
  underlying PER-UNIT builds are cached by (unit, effective version at viewHash),
  so overlapping validations recompute classification, not compilation.
- `build.statusAt(viewHash) -> { validated: boolean, unitStatuses?: [...] }`,
  host-internal (the approval gate's read): a pure cache lookup over recorded
  per-unit results at the candidate view — never triggers a build. This is
  deliberately coarser than a validate report: it answers "were units at this exact
  view built, and did any fail," which is representable per view hash; it does not
  re-derive required-vs-informational classification (that is validate's job, and
  gad's business).

Build success is NOT consulted by `refs.updateMains`; wiring build → advance is
entirely gad's push implementation. Dependency-graph access for gad: a
`build.dependencyGraph(viewHash)` read, or derivation from the manifests in the
trees themselves (preferred where possible — the manifests ARE in the CAS).

The host still builds/projects reactively AFTER mains move (unit reload, dev servers),
exactly as it reacts to any main change today.

### 2.3 What "main" means to the host

Projection and context instantiation read `refs.listMains()` and compose the workspace
view. Contexts fork from main states; the composed-view logic
(`composeRepoStatesLocal`) stays host-side because projection needs it. Everything
lineage-shaped behind those states is gad's.

## 3. Single writer

`refs.updateMains` is callable ONLY by the DO backing the workspace `vcs` service
declaration — resolved through `resolveVcsStoreBinding` (`userlandServices.ts:62`),
i.e. matched by target identity `do:{source}:{className}:{objectKey}`, NOT by
`runtime.kind === "do"` (any other DO is rejected). Chrome/shell do not get the write
surface either: user-level publishes also flow through userland `vcsPush` → gad →
host, so there is exactly one code path that composes candidates.

Trust bootstrap (why a userland DO may hold the pen): gad-store's code is workspace
code; changes to workspace code ship through main advances; every main advance passes
a host-side, host-computed-diff, user-facing approval. The circle holds precisely
because the approval gate is host-owned and unskippable. Gad's invariants (FF, build)
are quality gates the user can rely on because replacing gad itself requires their
approval on a truthful diff.

"Exactly one write path" means exactly one USERLAND write path. THREE enumerated
host-internal flows also write mains, in-process (never via RPC) with a `system` gate
context (`SYSTEM_ADVANCE`, `workspaceVcs.ts:290`):

- **Bootstrap seeding at attach**: `seedRef`-style set-if-absent only — it can never
  MOVE an existing main.
- **Fork lifecycle**: creates refs at new repo paths only.
- **Scan/freshness commits** (verified 2026-07-03 — this DOES move an existing main):
  the build system's `WorkspaceStateSource.ensureFresh()` (`workspaceVcs.ts:1100` →
  `snapshotRepoLogsFromDisk` `:3097` → `commitHead(main)` `:3105` → `commitMainHead`
  `:931` → `advanceMainRef(SYSTEM_ADVANCE)` `:957`) adopts the user's own on-disk
  edits into `main` via a one-entry `updateMains(operation:"push")` batch, CAS-guarded
  and (system-)gated like any other advance. This is a legitimate host-internal
  MOVER of an existing main, so the blanket "anything host-internal that would move an
  EXISTING main is out of contract" is TOO STRONG as written: the contract is that no
  host-internal path moves a main OUTSIDE the gated `updateMains` primitive — the scan
  path goes THROUGH it (in-process caller-context write), so it is in-contract, not a
  negative case. What remains out of contract (and a negative acceptance case) is any
  host-internal ref move/delete that bypasses `updateMains`.

## 4. On-behalf-of attribution

Requirement: approval prompts and ref-log entries must name the ORIGINATING principal
(the panel/app/worker/extension whose userland push started the flow), not
"gad-store DO" for every advance — without trusting the DO's claim.

**The token is NOT a caller credential.** It is a host-minted correlation nonce
(fresh `randomUUID()` per dispatch, exactly as the extension host does in
`extension-host/src/service.ts:718`): an opaque handle to a HOST-SIDE invocation
record. The caller's verified identity never leaves the host and is never encoded in
the token; the DO cannot use the token to authenticate as anyone (its own calls still
authenticate as the DO), and a token resolves an identity only by lookup in the
host's own table — the DO influences whether a token is presented, never what it maps
to. Threading a real caller access token through the DO would let the DO impersonate
callers arbitrarily and is explicitly NOT this design. The token delegates exactly
one narrow capability: attributing one in-flight dispatch's `updateMains` to its
originating principal (which also scopes grant lookup — hence the fail-closed rules
below).

Mechanism — generalize the existing extension chain-caller pattern
(`serviceDispatcher.ts:268` `ctx.chainCaller`; validated in `rpcServer.ts:531` against
the extension host's active-invocation table):

1. When the host dispatches a userland `vcs.*` call to the gad-store DO, it records an
   **active invocation**: `{ token (opaque, unguessable), caller: VerifiedCaller,
service, method, requestId, createdAt }` and passes the token to the DO alongside
   the call.
2. The DO threads that token through its orchestration and includes it in the
   resulting `refs.updateMains` (and may include it in `build.validate` for log
   attribution).
3. The host validates the token against the invocation table and resolves the ORIGINAL
   `VerifiedCaller`. The gate context becomes
   `{ kind: "caller", caller: <resolved upstream>, via: <DO identity>, operation }`.
   The prompt reads "Push workspace changes — requested by panel `chat-1`"; the ref
   log records both writer (`do:gad-store`) and on-behalf-of (`panel:chat-1`).
4. Token lifecycle: valid while its originating dispatch is in flight, INCLUDING
   deferred completion (approval prompts already hold DO calls open out-of-band via
   the `deferral` API — the invocation entry lives until the deferred result is
   delivered). The token may be presented on MULTIPLE `updateMains` attempts within
   that window — gad's CAS-conflict retry loop re-composes, re-validates, and re-CASes
   under the same originating dispatch, and every attempt independently passes the
   full gate (validity + approval), so multi-presentation adds no authority. Replay
   after the dispatch completes is impossible (the table entry is cleared).
   Invalid/expired/foreign tokens fail closed (the advance is rejected, never
   silently attributed to the DO).
5. `invocationToken` absent → the advance is attributed to the DO itself and gated as
   a caller-kind `do` advance (full prompt, no grants inherited from any user
   session). Expected to be rare: gad self-heal reads refs but never writes them, so
   virtually every legitimate `updateMains` carries a token.

Extension chains compose: extension → (parentInvocationToken → `chainCaller`) →
vcs dispatch mints a DO invocation whose recorded caller ALREADY carries the chain, so
a git-bridge import prompt attributes extension + upstream user surface.

**Two kinds of "attribution" — don't conflate them.** What never leaves the host is
(a) caller credentials and (b) AUTHORITATIVE attribution: the identity the approval
gate and grant lookup act on, which the host resolves exclusively from its own
invocation table. Separately, gad receives and stores plain ACTOR LABELS
(`{ id, kind }` strings) as provenance metadata — commit author fields — exactly as
today's push passes `input.actor` into `ingestRepoGroup`. Labels are display data
in a userland store; nothing host-side ever trusts them. This is why §6's
write-ahead intent recording on-behalf-of labels does not contradict this section:
the intent preserves PROVENANCE attribution across a crash. It never needs to
preserve gate attribution, because crash-heal completes gad's own records for a CAS
that already landed (already gated, already logged host-side with the token-resolved
principal in the ref log) — healing performs no ref write and no approval decision,
so the cleared token is irrelevant to it.

## 5. Approval gate (host-side, reshaped)

`createMainRefAdvanceGate` survives with the same trust core — server-computed diffs,
fail-closed on missing context — reshaped for batches:

- ONE prompt per `updateMains` batch. The host computes per-entry diffs
  (`diffTrees(old → next)`) and the candidate composed workspace view from
  `current mains ⊕ entries` (generalizing `workspaceViewWithRepoAt` to a batch form).
  Dedup key = candidate view hash, preserving today's group-coalescing and
  session-grant behavior.
- Delete entries (`next: null`) trigger the SEVERE per-repo deletion capability
  (`workspace-repo-delete`, per-repo resource key, dependents warning) within the same
  batch decision; restore-shaped entries (`expectedOld: null` on a previously deleted
  repo, `operation: "restore"`) map to the restore capability. "Previously deleted"
  is determined from the HOST's own ref log (the per-repoPath log in §2.1 retains
  delete entries) — the host needs no userland tombstone data to classify a
  re-creation as a restore, and a mismatch between the claimed `operation` and the
  log-derived shape fails closed to the stricter prompt. The
  file-count/dependents details the prompts show are host-computed from the CAS and
  the build dependency graph, as today.
- Meta-path (`meta/`) handling and unit-batch approval flow are unchanged — they
  already operate on changed paths + candidate view, both of which the gate still
  computes itself.
- Chrome bypass (`isAuthorizedChrome`) now keys on the RESOLVED on-behalf-of caller,
  not the writer DO: a shell-originated push keeps its user-level trust; a
  panel-originated push prompts, regardless of both flowing through the same DO.
- Build success is NOT a gating condition. But the prompt's build-status line is
  HOST-SOURCED, not caller-supplied: the gate calls `build.statusAt(candidateView)`
  (§2.2) — a pure cache read over the host's own recorded per-unit builds, never a
  build trigger — and displays `built: ok / failed / not validated` as trusted
  prompt content. The line is deliberately coarse (per-view unit statuses, not
  required-vs-informational push classification, which depends on gad's validate
  parameters); its job is only to make approving unvalidated or failing content
  explicit and truthful, without the host trusting anything the writer asserts.

### 5.1 Diff review UI (approval prompt)

The prompt is the last structural line of defense (§11), so the diff must be genuinely
reviewable — a full diff viewer with syntax highlighting, not a changed-paths count.

**Data flow — host-served, lazily fetched.** The approval request payload does NOT
inline diff text (batches can be huge). The gate attaches, per entry:
`{ repoPath, oldState, newState, diffStat: { filesChanged, insertions, deletions },
changedFiles: [{ path, kind: added|removed|changed, oldHash?, newHash?, binary?,
tooLarge? }] }` — all host-computed from `diffTrees`. The approval UI fetches file
contents lazily by CONTENT HASH from the host blobstore read surface when the
reviewer expands a file. The integrity argument is content addressing, not read-path
restriction: the blobstore read surface is broadly callable, and that's fine —
`get(hash)` can only ever return bytes matching `hash`, and the hashes come from the
host's own `diffTrees` in the approval payload, so NO caller of any read surface can
cause different content to render for those hashes. Userland cannot substitute
display content; line-level diffing and rendering of those two trusted blobs is pure
presentation and runs client-side. The residual trust is the approval card itself
choosing to fetch the payload's hashes and render them faithfully — that is the
chrome-trust caveat below, not a property a read-side binding could add.

**Rendering.** The approval card surface
(`workspace/apps/shell/overlay/ApprovalCardSurface.tsx` /
`ConsentApprovalBar.tsx`, model in `approvalCardModel.ts`) gains a diff-review
section: file list with per-file diffstat, expandable per-file unified diff (whole
batch expandable), added/removed line backgrounds over syntax highlighting by file
extension. Highlighting: no highlighter exists in the workspace UI stack today —
add **shiki** (`shiki/core` with lazily loaded grammars/themes, light+dark) as a
shared diff-viewer component in `@workspace/ui`, so gad-browser and other panels can
reuse the same viewer rather than growing a second one. Guardrails: binary files and
oversized files render diffstat-only in the approval card; reusable consumers may
provide their own real file-inspection action. Grammar loading is best-effort
(plain-text fallback never blocks review); the Allow/Deny controls never depend on
highlight completion.

**Trust caveat (existing model, unchanged).** The approval card is chrome-trusted
workspace code; changes to the shell app itself are gated through host-owned
bootstrap/unit approvals. The diff DATA is host-computed and host-served either way —
the workspace app only presents it.

## 6. What moves into gad (userland)

- **Push/merge orchestration** (from `workspaceVcs.push` / merge paths): clean-source
  check, fast-forward/merge-base policy, divergence classification + dry-run merges,
  candidate composition, `build.validate` call, retry-on-CAS-conflict loop, and the
  provenance commits for the advance — written by gad into its OWN store before/after
  the CAS as it sees fit. Issue 3 dissolves: the host never writes provenance, so
  there is no cross-store transaction to fake. Gad's contract: record provenance
  after a successful CAS; heal on crash (below).
- **Crash self-heal** (replaces host `ProvenanceFollower` +
  `reconcileMainProvenanceFromRefs`). VERIFIED 2026-07-03: the `ProvenanceFollower`
  CLASS and `reconcileMainProvenanceFromRefs` are DELETED. For PUSH/MERGE the heal is
  the DO's write-ahead publish intents (below). Separately, SCAN/FRESHNESS
  after-the-fact recording survives inside `WorkspaceVcs`: the host writes a durable
  scan record before the protected-ref CAS, records it afterward by direct
  per-repo-ordered DO ingest, and attach/on-demand sync replays those host records
  before calling `vcsHealPublishDrift`.
  Refs alone cannot reconstruct gad's commit
  graph (parentage, merge sources, messages, attribution — today's
  `sourceEventId`/`parentEventId` chain), so healing is write-ahead, not
  reconstruction: BEFORE calling `refs.updateMains`, gad durably records a
  pending-publish intent in its own store (candidate states, parent event ids,
  message, on-behalf-of). On DO start (and on demand when a lineage read detects
  drift), gad compares `refs.listMains()` against its recorded lineage; a main
  matching a pending intent completes that intent's provenance with full fidelity.
  A main matching NO intent (lost store, external interference) fails closed:
  refs alone cannot reconstruct parentage, hunks, message, or attribution. Stale
  intents whose CAS never landed are discarded against the ref log. Refs are the
  authority; gad is a follower of its own successful writes.
- **Deletion/restore semantics**: archives, tombstones, resurrection policy. Host
  delete = ref removal (+ projection/build cleanup reaction). "A stale context cannot
  resurrect a deleted repo" becomes a gad check, backed by the restore-shaped severe
  prompt at the host.
- **Git import** (git-bridge extension + gad): import ingests history into gad on a
  staging lineage, then publishes through the ordinary gad push path →
  `refs.updateMains` with the extension's invocation token. `adoptImportedRepo` /
  `adoptMainFromStore` are deleted. Issue 2 dissolves.
- **Main-lineage write guards in gad-store**: `ingestWorktreeState` onto
  `vcs:repo:* @ main` no longer serves host pushes; gad's own push path writes main
  lineage. Extension-facing ingest surfaces are confined to non-main heads.

## 7. Host deletion list

Per the no-backward-compatibility rule, deleted outright (with a dead-code audit after
each phase):

- `WorkspaceVcs.push` pipeline: FF/merge-base checks, divergence + dry-run merge
  reporting, clean-source precondition, the group lock-and-rollback machinery
  (`advanceMainRef` GROUP LOOP, `deleteRefs` rollback), `pushRaceResult`, CAS retry.
  VERIFIED 2026-07-03: `deleteRefs`/`pushRaceResult` and the group-loop shape are gone.
  NOTE: `advanceMainRef` itself SURVIVES as a single-entry in-process helper
  (`workspaceVcs.ts:709`) used by the scan/freshness and delete/restore paths; and a
  NEW `compensateMainRef` (`:736`) provides delete-lifecycle rollback (see §2.1) — so
  "rollback machinery deleted" is true of the PUSH pipeline only.
- Provenance coupling: `advanceRepoGroupUnlocked`'s ingest call from push,
  the `ProvenanceFollower` class, `reconcileMainProvenanceFromRefs`, and pending-merge
  SEEDING (`seedMainPendingMerges`). VERIFIED 2026-07-03: all four are DELETED.
  CORRECTION —
  conflict-summary syncing is NOT deleted from the host: `WorkspaceVcs.syncConflictSummary`
  (`workspaceVcs.ts:2116`, called from commit/merge at `:894`/`:1665`/`:1924`/`:2019`/`:2168`)
  SURVIVES and is still host-owned. An earlier draft listing it among the deletions was
  wrong; only pending-merge SEEDING (not conflict-summary syncing) was removed.
- `vcs.adoptImportedRepo` (service) and `WorkspaceVcs.adoptMainFromStore`.
- Public `refs.advanceRef` + the generic `(repo, ref)` namespace, schema, and the
  arbitrary-tree caller path in the gate (`refsService.ts` write surface;
  `serviceSchemas/refs.ts` advance input).
- Host-side merge entry points that end in ref advancement (re-homed to gad).
- `SYSTEM_ADVANCE` usages that existed to skip gating on adoption/import paths.

Survives host-side: content store + validity/GC, `RefService` storage core (narrowed
to mains, batch commit), the approval gate (reshaped, §5), build system (decoupled
from push), disk projection/context instantiation, fork/bootstrap seeding.

## 8. Migration phases

Each phase lands green (typecheck, unit, integration suites) before the next; the tree
is pre-release, so intermediate compatibility shims are not built.

- **P1 — host write primitive.** DELETE public `refs.advanceRef` and the generic
  `(repo, ref)` write surface FIRST — it is the live finding-1 bypass and has no
  in-tree callers, so it does not wait for P3. Narrow `RefService` to mains + batch
  atomic commit; implement `refs.updateMains` (validity → batch approval → group
  CAS/delete) with the single-writer policy on the RPC surface from day one.
  Generalize the gate to batches incl. delete/restore capabilities. Wire the DO
  invocation-token table + `on-behalf-of` resolution (generalizing the extension
  mechanism). Disambiguation: single-writer governs the RPC surface; during P1–P2
  the former host-side `vcs.push` pipeline calls the batch primitive IN-PROCESS (a
  host-internal caller-context write, like today's push→RefService path), which
  proves prompt parity and disappears in P3 when dispatch flips to the DO. At no
  phase does any RPC caller other than the vcs DO reach `updateMains`.
- **P2 — build as a service.** Expose `build.validate(viewHash)` (+ dependency-graph
  read if manifest-derivation is insufficient) to the vcs DO; decouple
  `validateRepoPush` from the push pipeline. NOTE: today's `validateRepoPush` is not
  pure — it builds, CACHES, and `recordBuilds` the candidate (the push-time build
  becomes the recorded baseline for the new main). This phase must split those
  semantics explicitly: `build.validate` = build + cache by view hash (idempotent,
  safe for gad to call on any candidate, including ones never published);
  baseline/`recordBuilds` promotion happens host-side in REACTION to a main actually
  moving (the host already rebuilds/reacts on ref change), never as a side effect of
  a userland validate call.
- **P3 — gad push/merge.** Implement push/merge orchestration + provenance recording +
  CAS-retry in the gad-store DO; dispatch push/merge userland (`vcsPush`/`vcsMerge`); DELETE the
  host push pipeline, old provenance follower, reconcile, and adoption surfaces
  (public `advanceRef` is already gone since P1).
  Gad startup self-heal via write-ahead publish intents (§6).
- **P3.5 — diff review UI** (parallel with P2/P3; ships before P3 flips dispatch, so
  the richer prompt covers gad-driven pushes from day one): gate payload extension
  (§5.1), shared shiki-based diff viewer in `@workspace/ui`, approval card
  integration, blobstore lazy-fetch wiring.
- **P4 — lifecycle + import.** Delete/restore semantics to gad (host keeps severe
  prompts via `updateMains` entry shapes); git import re-built as staged-lineage +
  ordinary gad push; delete `adoptImportedRepo`/`adoptMainFromStore`; confine
  extension ingest to non-main heads.
- **P5 — sweep.** Dead-code audit; update `docs/blob-addressed-cleanly.md` (host
  remnants section), `docs/gad-architecture.md`, CLI docs; full acceptance run (§10).

## 9. Breaking-changes register

| #   | Surface                                              | Change                                                                                                    | Who breaks                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `refs.advanceRef` (public RPC)                       | Deleted in P1                                                                                             | No in-tree callers remain; the surface was deliberately public (P5b design) and reachable by any sandboxed caller — that reachability IS finding 1, and its removal is the point |
| 2   | `refs.readRef/listRefs/readRefLog`                   | Replaced by main-only `readMain`/`listMains`/log                                                          | gad-store refs bridge (`gad-store/index.ts:6686`), workspace-view composition                                                                                                                                                       |
| 3   | Generic `(repo, ref)` host namespace                 | Deleted; host tracks mains only                                                                           | Any non-main host ref usage (none known)                                                                                                                                                                                            |
| 4   | `vcs.adoptImportedRepo`                              | Deleted (P4, shipped 2026-07-03) along with `WorkspaceVcs.adoptMainFromStore`                             | git-bridge REBUILT: import ingests onto a non-main `import:*` staging head, then publishes via the DO's `vcsImportPublish` → write-ahead intent → `refs.updateMains({operation:"import"})` (approval-gated, single-writer, extension-attributed). Extension ingest onto a `vcs:repo:*` main head is now rejected by the DO. Finding 2 closed structurally |
| 5   | Host `vcs.push` / main-advancing merge paths         | Host `vcs.push` is deleted; push is userland `vcsPush` via CLI/runtime, and main-advancing merge paths dispatch to gad | Host RPC callers cannot call `vcs.push`; CLI/runtime push behavior is preserved through the userland service, with structured divergence/build results produced by gad                                                               |
| 6   | Fast-forward-only, clean-source, resurrection guards | No longer host-enforced; gad convention + approval prompt                                                 | Anything relying on the HOST rejecting non-FF advances                                                                                                                                                                              |
| 7   | Push atomicity contract                              | Atomic over refs only (one batch CAS); provenance eventual, gad-healed                                    | Consumers of the old all-or-nothing refs+provenance claim (was never delivered)                                                                                                                                                     |
| 8   | Approval prompt attribution                          | "requested by X (via vcs)" replaces direct-caller prompts; DO-attributed advances possible when untokened | Approval UX copy, grant-key semantics review                                                                                                                                                                                        |
| 9   | Host build gating of pushes                          | Removed; gad orchestrates `build.validate`                                                                | Anything assuming main can never point at a non-building tree HOST-SIDE                                                                                                                                                             |
| 10  | `ingestWorktreeState` on main lineages               | Restricted to gad's own push path; extensions confined to non-main heads                                  | Any extension ingesting directly onto main (the finding-2 vector — intentionally broken)                                                                                                                                            |
| 11  | Push source-head confinement — CLOSED (2026-07-03) | STRUCTURAL confinement restored: the relay resolves the originating caller's context (`entityCache.resolveContext`) at the SAME chokepoint that mints the invocation token and threads it as a HOST-VERIFIED `callerContextId` on the DO dispatch envelope (`RpcRequest.callerContextId` → workerdRpcRelay → DO base read-at-entry getter). The writer DO's `vcsPush` recovers the deleted `resolvePushSourceHead` policy: a sandboxed caller (`panel`/`app`/`worker`/`extension`) pushing a `ctx:` source head must own it (`ctx:{callerContextId}`); a FOREIGN ctx head is rejected and an ABSENT context fails CLOSED. Chrome/`server`/`do`/system callers stay unrestricted. Never client-asserted. | A caller bypassing the runtime client can no longer propose another context's head — the DO rejects it structurally BEFORE any read/publish, in addition to the approval gate |
| 12  | Merge-to-main — INTERNAL-ONLY, CLOSED (2026-07-03) | Merge-to-main is INTERNAL-ONLY and published through the SAME gated single-writer path as push. There is NO public `vcs.mergeGroup` (removed from the schema + `runtimeSurface.portable.ts`; `WorkspaceVcs.mergeGroup` `:3262` survives only as an internal host/test helper), and public `vcs.merge` / `WorkspaceVcs.mergeHeads` REJECT a `main` target (`workspaceVcs.ts:1847` "main advances via push, not merge"). Internal path: `WorkspaceVcs.mergeGroup` → `mergeIntoMainHead` (`:1971`) → `callMainTargetMerge` (`:1936`, mints a `VcsInvocationTable` record with method `vcsMerge`/operation `merge` for the VERIFIED gate-context caller and threads the token to the DO's `vcsMerge`) → DO `vcsMerge({targetHead:"main"})` (`gad-store/index.ts:6869`, `@rpc callers do/server` — unreachable by sandboxed userland) → `runVcsMergeMain` (`:7104`) → the same gated publish as push: heal drift → `PublishIntent(operation:"merge")` → `refs.updateMains({operation:"merge"})` (`:7206`) → complete provenance. The DO echoes the token into `updateMains`, so the gate resolves the ORIGINATING principal, and a clean main-merge records a MERGE transition (`workspaceVcs.ts:429`, `transitionKind` derives from operation; `vcsInvocationTable.ts:25` maps `vcsMerge`→`merge`). CONFLICT-path LIMITATION: a conflicted main-merge parks a pending merge on the main head in the DO, materializes markers to the worktree, and is fully ABORTABLE via `vcsAbortMerge` (`:7287`) — but it is NOT resolve-forward-by-commit: `commitMainHead` (`workspaceVcs.ts:931`) is not pending-merge-aware (unlike ctx `commitHead` `:853`), so forward-resolution of a conflicted main merge is UNSUPPORTED and would need `commitMainHead` made pending-merge-aware. | No caller-facing `mergeGroup`. Chrome merge-to-main attributes correctly; a panel-driven internal merge (if such a path is added) resolves to the panel. Absent table (in-process fixtures) → DO-attributed, as before |

## 10. Acceptance tests

Each bullet's covering test is noted parenthetically (verified green, P5 acceptance
run 2026-07-03). Files: `refService.test.ts` / `refsService.test.ts` /
`mainAdvanceApproval.test.ts` / `servicePolicyMatrix.test.ts` under
`src/server/services/`; the rest under `tests/workspace-integration/` (`doVcsPush`,
`doImport`, `vcsHost/*`, `merge`) and `workspace/packages/ui/src/kit/diff/DiffViewer.test.tsx`.

Security / single-writer:

- Panel/app/worker/extension cannot reach `refs.updateMains` (policy rejection), and
  no other surface moves or deletes a main ref. (`refsService.test.ts` "rejects a %s
  caller with a structured policy error"; `servicePolicyMatrix.test.ts` golden.)
- A second DO (or a re-declared fake `vcs` service from a non-approved workspace
  change) does not match the single-writer identity. (`refsService.test.ts` "rejects a
  DIFFERENT (non-writer) DO — identity, not runtime.kind" + "…when no vcs binding
  exists".)
- `updateMains` with a tree whose objects are missing from the content store fails
  closed before any prompt. (`refService.test.ts` "runs BEFORE the gate and fails
  closed when a candidate tree is missing".)
- Forged/expired/foreign invocation tokens: advance rejected; nothing attributed.
  (`refsService.test.ts` "fails closed on a forged/foreign token" + "rejects a token
  replayed AFTER the dispatch completes".)
- Host-internal writes stay movement-limited: bootstrap seeding cannot move an
  existing main (set-if-absent asserted under a concurrent-attach test); fork
  creates only new repo paths; no host-internal code path can delete or move an
  existing main outside `updateMains`. (`refService.test.ts` seedMain "is a no-op when
  the main already exists"; `workspaceVcs.bootstrap.test.ts` "seed-on-attach is
  idempotent across restart and never moves an advanced ref"; `workspaceVcs.forkRepo.test.ts`
  "forks a repo to a new path" + "rejects forking onto an existing repo".)

Attribution:

- Panel-originated push prompts with the panel as principal; ref log records DO writer
  - panel on-behalf-of; chrome-originated push inherits chrome trust (no prompt);
    extension import chains extension identity into the prompt.
  (`refsService.test.ts` "resolves a token to the originating principal
  (writer=DO, onBehalfOf=panel, via=DO)" + "chains an extension import's identity into
  the attribution (onBehalfOf=extension)" [added P5]; `mainAdvanceApproval.test.ts`
  "bypasses the prompt for a chrome-authorized RESOLVED caller" [added P5];
  `refService.test.ts` "appends a log entry per movement with …onBehalfOf…".)

Diff review UI:

- Expanding a changed file renders a syntax-highlighted unified diff whose contents
  round-trip from the host blobstore by the hashes in the approval payload (assert the
  UI issues no content reads outside those hashes). (`DiffViewer.test.tsx` "renders a
  unified diff from the two fetched blobs on expand" + "fetches ONLY the hashes present
  in the payload"; payload provenance in `mainAdvanceApproval.test.ts` "attaches
  per-entry kinds/hashes and accurate line counts for an advance".)
- Binary / oversized files degrade to diffstat + escape hatch; a missing grammar
  degrades to plain text; Allow/Deny work with rendering incomplete. (`DiffViewer.test.tsx`
  "degrades binary and oversized files to diffstat-only with an escape hatch" + "falls
  back to plain text when no grammar matches" + "keeps rendering (never throws) while a
  fetch is still pending".)
- Batch prompt shows per-repo diffstat totals matching the host-computed diff.
  (`mainAdvanceApproval.test.ts` "attaches per-entry kinds/hashes and accurate line
  counts…" + "a mixed batch (advance + delete) yields one advance prompt and one
  deletion prompt"; `workspaceVcs.mainApproval.test.ts` "the approval prompt's changed
  paths are SERVER-COMPUTED from the content-store diff".)

Atomicity:

- Mixed batch (advance + delete) commits in one file replace; injected failure at any
  point before commit leaves every ref untouched (no rollback path exists to test —
  assert no partial persist). (`refService.test.ts` "commits a mixed batch (advance +
  delete) in one persist" + "one entry's conflict fails the WHOLE batch — no partial
  persist" + "leaves no temp files behind after a batch".)
- CAS conflict on one entry fails the whole batch with per-entry conflict data; gad
  retry loop converges (concurrent pushes to disjoint repos succeed serially).
  (`refService.test.ts` "rejects a stale CAS with per-entry conflict data" + "concurrent
  pushes to DISJOINT repos both succeed" [added P5]; `doVcsPush.test.ts` "returns
  structured divergence when main moves during the build gate (CAS race → retry)".)

Gad semantics parity:

- Non-FF push rejected BY GAD with divergence classification (dry-run merge results
  preserved); clean-source violation rejected by gad; deleted-repo resurrection
  rejected by gad + restore requires the severe prompt. (`doVcsPush.test.ts`
  "classifies divergence and does NOT advance main" + "rejects a push over uncommitted
  edits on the source (clean-source precondition)"; `workspaceVcs.delete.test.ts`
  "refuses to resurrect a deleted repo via a stale context's push" + "classifies the
  restore at the ref gate and aborts on denial".)
- Build failure in `build.validate` → gad aborts before `updateMains`; required-vs-
  optional report semantics preserved. (`doVcsPush.test.ts` "aborts on a required build
  failure (no publish, no intent)" + "a non-required (regression-gated) build failure
  does NOT block the push".)
- Kill the DO between `updateMains` success and provenance recording → restart
  completes the pending-publish intent with full provenance fidelity; a main with NO
  matching intent fails closed (no invented catch-up provenance); reads during
  the crash window fail loudly or heal on demand when a covering intent exists.
  (`doVcsPush.test.ts` "heals a crash between the CAS and provenance (write-ahead
  intent)"; `workspaceVcs.attachHeal.test.ts` "rejects a ref that ran ahead of the
  DO with no covering publish intent"; `mainProvenance.test.ts` fail-closed drift cases.)
- Git import end-to-end: staged lineage → gad push → prompt → main moves; for
  non-building or never-validated import content, the prompt's HOST-SOURCED build
  status line (build-service cache lookup, §5) reads "failed"/"not validated", so
  approval of unbuilt content is explicit and truthful. (`doImport.test.ts` "stages
  imported history then publishes onto main through updateMains(import)" + "publishes a
  subsequent outside-world change onto main"; `mainAdvanceApproval.test.ts" "renders the
  HOST-sourced build status in the advance prompt" + "renders 'not validated' when no
  build status is recorded".)

GC (root survival, §2.1):

- GC never collects a gad-declared root or ref-log-reachable state; uncommitted
  working-edit content survives (handoff A1). (`merge.test.ts` "keeps referenced
  history, sweeps staged orphans and dead blobs" + "pending-merge states are GC roots" +
  "keeps content-store-only trees reachable from protected refs"; `gadStore.test.ts`
  "keeps uncommitted working-edit content live and sweeps it once committed";
  `workspaceVcs.delete.test.ts` "keeps an archived (deleted) lineage's content in the
  owner-derived GC live set".)

## 11. Risks / notes

- **The approval prompt is the last structural line** against a compromised-but-
  approved gad: it must always render the host-computed diff, never a summary supplied
  by the writer. Any future prompt-UX simplification must preserve this.
- **Approval-inside-critical-section**: batch CAS validation must remain stable across
  the (potentially long) prompt. Simplest correct behavior: hold the batch's ref
  serialization across the prompt (today's per-ref behavior, widened); if contention
  ever matters, switch to validate → prompt → re-validate-and-commit.
- **`meta/` changes and unit trust** flow through the same batch gate — verify the
  unit-batch approval providers behave identically under batch-shaped candidates
  (same candidate-view hash keys).
- **Projection of unvalidated trees**: the host will project whatever the user
  approves, built or not. This is by design; surfacing build state in the prompt
  (display-only) mitigates surprise.
- **Concurrency regression watch**: gad's optimistic retry replaces host locking;
  stress-test concurrent pushes from multiple contexts (the old `pushRaceResult`
  scenarios) at the gad layer.
