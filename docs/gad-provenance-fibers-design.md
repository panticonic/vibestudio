# GAD Provenance Graph — Design Spec

Status: proposal, v3 (2026-07-03: v2 rebased onto the narrow-host VCS split in
progress in the main worktree — see §0.1; handoff to that workstream in
`docs/gad-provenance-handoff-2026-07.md`).
Pre-release; **no backward compatibility** — schema is reset on bump
(`GadWorkspaceDO.dropPersistenceTables`), so we add/rename freely.

**Durability boundary.** Resetting on bump is free for the _runtime_ projections,
but memory which wipes on every bump is not long-term memory. This spec keeps
claims and touch signals on the reset-on-bump substrate _deliberately_: within a
schema era they are durable working memory; across a bump they are gone. That is
acceptable only while pre-release; graduating the knowledge ledger to survive
schema change (a durable sub-ledger or real migrations) is separate follow-on
work, and the prompt (§13) must not promise the agent more permanence than the
substrate delivers.

This spec turns GAD's ledger kernel into a single, queryable **provenance
graph** joining the worktree VCS, the agent trajectory, and a hermeneutic claim
model — surfaced to the agent at read time as a compact, relevance-ranked
summary. It is the concrete plan behind the June 2026 GAD review
(`docs/gad-system-review-2026-06.md`).

**Scope.** Two of the review's three pillars — VCS (blame) and
memory/hermeneutic (claims) — unified on one graph. The third pillar, durable
task/goal/intent tracking, is **out of scope here**: the graph model absorbs it
later (an `intent` anchor kind plus `blocks`/`about`/`justified_by` edges drop
into §4–§6 without reshaping them), but no intent producers, tables, or tools
ship in this plan.

## 0. What changed since v1 of this spec (and the verdict)

The v1 draft was written against a VCS where `vcs.applyEdits` atomically
committed every edit to the context head on a single shared `VCS_LOG_ID` log,
and where no invocation/turn causality reached the edit records ("the keystone
gap"). The per-repo VCS rework (`25ef96f5`, `f8cc1281`) replaced that world:

1. **The keystone edge is now native.** `gad_worktree_edit_ops` carries
   `actor_id`/`actor_json` (verified caller, always populated), `invocation_id`
   (live end-to-end: the agent `edit`/`write` tools pass `toolCallId` —
   `workspace/packages/harness/src/tools/edit.ts`, `write.ts`), and turn **by
   join** (`edit_ops.invocation_id → trajectory_invocations.turn_id`, the
   source of truth; the rows also carry a denormalized `turn_id` — §2). "Which invocation/turn produced this edit"
   no longer needs new infrastructure.
2. **Edits are working rows until committed.** `vcs.edit` records uncommitted
   ops (`committed_event_id IS NULL`, no log event, no state mint); `vcs.commit`
   folds them into a messaged snapshot by **re-keying the same rows** (never
   re-inserting — provenance columns survive commit); `vcs.push` is the only
   main-advance (fast-forward-only, build-gated). Commit messages are
   **mandatory** — a new, free semantic signal v1 never had.
3. **Per-repo logs.** Every repo has its own log `vcs:repo:<path>` with heads
   `main` / `ctx:<contextId>`; the workspace view is a composition
   (`composeRepoStates`, now `composeRepoStatesMirrored` in the DO) over a
   durable context base pin (`vcs_context_bases`).
   `VCS_LOG_ID` is gone. Commit ancestry is **event-keyed**
   (`gad_worktree_heads.commit_event_id`, `gad_transition_parents.parent_event_id`,
   `commitAncestors`) so identical content states from distinct commits don't
   conflate.
4. **History surfaces exist.** `fileHistory` returns a path's edit ops in
   commit-lineage order (ancestry traversal, **not** global `log_events.seq`)
   with the uncommitted working tail appended; `editsByActor` / `editsByTurn` /
   `editsByInvocation` / `listCommitEdits` cover the causal directions.
5. **Hunks are exact character-offset ranges** (`{start, end, oldText?,
   newText}` against the base the author saw), and a whole-file `write` over an
   existing text file is **auto-diffed into replace hunks** — so fs-library
   writes carry the same hunk-level provenance as the agent replace tool, and
   the v1 "write resets identity" barrier shrinks to create/binary/no-diff
   writes.

**Verdict.** The v1 _retrieval architecture_ — structural provenance for
exactness, FTS similarity for recall, session-density as a re-ranking signal —
and the _claims model_ survive review unchanged. The v1 _foundation_ does not:
a physical `gad_fibers` table whose `edited` rows are projected alongside
`gad_worktree_edit_ops` would be a **dual-write of provenance the VCS already
records** — a second copy that can drift, guarded only by discipline. Per the
project's standing directives (mechanisms over discipline; one provable
mechanism per job), the unified edge table is dropped. The provenance graph is
**logical**: SQL views over the native tables, plus exactly one small physical
table for behavioral signals that have no native home (§4). "Fibers" survive as
the name of edges in that logical graph, not as a storage design.

Everything else in this spec is the v1 architecture rebased onto that
foundation, with the new signals (commit messages, working-vs-committed
distinction) folded in.

### 0.1 The narrow-host split (v3 rebase, 2026-07)

Between v2 and v3, the main worktree began landing the **narrow-host VCS
split** (`docs/narrow-host-vcs-plan.md`): the host VCS (`src/server/gadVcs/`)
is deleted; semantics move to a pure `workspace/packages/vcs-engine/`
(EditEngine, MergeEngine, diff3) plus the gad-store DO, which now owns
edit/commit composition, ctx-head merges, and all history reads; the host
shrinks to `src/server/vcsHost/` — a mains-only ref table
(`refs.updateMains`, batch CAS, single-writer = the gad-store DO), a
host-minted invocation-token table for on-behalf-of attribution, build as a
service, a batch approval gate with a diff-review UI, and disk projection.
Audit of the working tree (2026-07-03): P1/P2/P3.5 and the P5b/c/d semantics
migration are substantially landed; **P3 has not flipped** (host push
pipeline, `ProvenanceFollower`, after-the-fact provenance recording still
live); P4/P5 not started.

Consequences for this spec, folded in throughout:

- **The substrate survives.** Every §2 ground-truth structure made the move
  intact: `gad_worktree_edit_ops` (all columns), commit-by-re-key,
  `IngestWorktreeStateInput.editOps`, event-keyed ancestry, the history
  surfaces (now userland-dispatched DO RPCs `vcsFileHistory`,
  `vcsEditsBy*`, …), mandatory messages, per-repo logs, `gad_claims`,
  `gad_memory_fts`.
- **Renamed seams**: `buildEditOpRows` → `EditEngine.applyEditOps`
  (`vcs-engine/src/editEngine.ts`); `insertWorkingEditOps` →
  `insertWorkingEditRows` (gad-store DO); `commitRepo` → `commitWorking`;
  `diff3Merge` → `vcs-engine/src/diff3.ts` (a pure package — which makes U3
  easier, not harder); agent tools →
  `workspace/packages/harness/src/tools/edit.ts` / `write.ts`.
- **The whole graph is now one-DO-local.** History reads, claims, FTS, and
  the touches table all live in the gad-store DO — §6's density query and
  §9's views need no host round-trips. §7.2's parallel-read gotcha stands
  unchanged (content bytes stay on the fs/host side).
- **A new native signal exists**: the host **main-ref log** (`writer`,
  token-resolved `onBehalfOf`, `reason`, `operation`, nullable `new`) is
  host-verified provenance for every main movement — stronger than anything
  the DO records; the graph adopts it for main-advance attribution (§2).
- **Sequencing is now coupled to P3** (§11): main-advance/merge provenance
  moves from the host follower into the DO in P3, and U1–U3 are specified
  against that post-P3 world. They should be contributed *into* P3, not
  retrofitted after it.

## 1. Goals

1. **Blame that works in production** — for any file/line/head, recover which
   edit changed it, in which commit, by which invocation/turn/actor — including
   the uncommitted working tail.
2. **Read-time provenance attachment** — on each read, attach a compact
   summary at the agent-requested depth, ranked by relevance to the current
   session and floored so it only renders what is worth reading. Deeper
   exploration is on-demand.
3. **Two-source retrieval, density-reranked** — candidates from **structure**
   (blame, edit lineage, claim links) and **similarity** (FTS recall over
   claims, commit messages, messages, files), ordered by **session density**:
   how strongly the current session connects to each candidate. Density is a
   re-ranking signal on top, never the sole gate.
4. **Hermeneutic memory** — claims-as-nodes + relations as the agent's durable
   working memory, linked to the trajectories that touch them, recalled by
   similarity + density.
5. **SQL-first** — expose the graph as clean tables/views and prompt the agent
   to chase provenance with its own SQL, judiciously. Do not over-wrap.

## 2. Ground truth this builds on (post-rework)

- **Edit provenance is live.** Every `vcs.edit` writes `gad_worktree_edit_ops`
  rows: `kind` (`replace|write|create|delete|chmod`), `path` (repo-relative),
  `old_content_hash`/`new_content_hash`, `hunks_json` (offset ranges; auto-diffed
  for text writes), `actor_id`/`actor_json`, `invocation_id` (self-asserted
  `toolCallId` from the agent tools), `turn_id` (denormalized at write),
  `edit_seq`/`ordinal` (replay order),
  `committed_event_id`/`committed_seq`/`output_state_hash` (NULL while working;
  stamped by `commitWorking`'s re-key on commit). Indexes exist for
  path-in-lineage order, actor, turn, and invocation lookups.
- **Turn's source of truth is the join**: `invocation_id →
  trajectory_invocations(turn_id, log_id, head)`. The stored `turn_id` column
  is a write-time denormalization (v3 amendment: the narrow-host substrate
  stamps it; the join stays authoritative and yields the edit's **session**
  (trajectory branch) — no session column needed on edit ops).
- **Commit ancestry is event-keyed**: `commitAncestors` walks
  `gad_transition_parents.parent_event_id` from `gad_worktree_heads
  .commit_event_id`. `fileHistory` orders committed ops by that traversal and
  appends the working tail.
- **Non-agent edits degrade to actor.** The fs-write bridge records edits with
  `actor` only (no invocation); merge/bootstrap/fork commits pass `editOps` at
  ingest. Blame on those rows reports actor + commit, no producing turn — it
  degrades to structure rather than lying.
- **Claims exist, producer-less.** `gad_claims(claim_id, trajectory_event_id,
  invocation_id, subject, predicate, object, status)` is projected from
  `knowledge.claim_recorded/updated/retracted`, and claims are FTS-indexed in
  `gad_memory_fts` — but **no tool emits the events**. We add producers (§8).
- **FTS recall exists**: `gad_memory_fts` (claims, messages, committed files)
  behind `vcs.recall`. Commit messages are **not yet indexed** (§10 tweak T3).
  File indexing is now split: the host decodes bytes and calls the DO's
  `indexMemoryFiles`; `memidx:` markers live DO-side (bears on U5).
- **File reads are recorded nowhere.** The dead `gad_file_observations` /
  `gad_file_mutations` / `gad_file_change_hunks` projections, their
  `state.file_*` event kinds, and `blameGadFileSnippet` are slated for
  deletion with the bang (the narrow-host tree still carries and GC-references
  them). Reads get a soft signal (§4), not a log event.
- **Main movement has a host-verified record (new in v3).** The host main-ref
  log (`writer`, token-resolved `onBehalfOf`, `reason`, `operation`, nullable
  `old`/`new`) is authoritative attribution for every push/merge/delete/
  restore of a main — the DO reads it through the refs bridge. The graph uses
  it for main-advance attribution; it complements, never replaces, the
  self-asserted edit-time `invocation_id`.

## 3. Anchors

Nodes of the logical graph, reusing the existing `anchor_kind`/`anchor_id`
convention:

| anchor_kind  | anchor_id                                                       |
| ------------ | --------------------------------------------------------------- |
| `file`       | `repo:relative/path` (repo-qualified; workspace paths resolve via repo discovery) |
| `commit`     | commit **event id** (never the state hash — states conflate, events don't) |
| `invocation` | invocation id                                                   |
| `turn`       | turn id                                                         |
| `session`    | trajectory branch (log_id + head); authority is branch-chain reachability, §6.4 |
| `claim`      | claim id                                                        |

## 4. The graph: native edges + one soft table

### 4.1 Edge catalog

**Native (organic) edges** — already recorded by an existing mechanism; the
graph reads them through views (§9), never copies them:

| edge                                                     | src → dst           | backed by                                                        |
| -------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `edited`                                                 | invocation → file   | `gad_worktree_edit_ops.invocation_id` (+ actor for non-agent)     |
| `committed_in`                                           | file → commit       | `gad_worktree_edit_ops.committed_event_id`                        |
| `asserted`                                               | invocation → claim  | `gad_claims.invocation_id` / `trajectory_event_id`                |
| `supports`/`contradicts`/`about`/`refines`/`depends_on`  | claim → claim       | `gad_claim_relations` (new, event-backed, §8)                     |

Native edges are real provenance: log-derived (or derived from the working-edit
mechanism, which is itself the system of record for uncommitted work),
replayable where their source is replayable, never pruned, and covered by
whatever integrity covers their source table. There is **no** separate fiber
row to keep consistent — the constraint that prevents drift is that no second
copy exists.

**Soft (behavioral) edges** — signals with no native home, recorded in one
physical table:

| kind       | src → dst        | base weight | written by                                                    |
| ---------- | ---------------- | ----------- | ------------------------------------------------------------- |
| `observed` | session → file   | 0.5         | the agent read tool (every read, even suppressed-block reads) |
| `cited`    | session → claim  | 0.7         | drill-down on a claim; claim-id args in tools                  |

Soft edges are **session-anchored, not invocation-anchored** — deliberately.
Every read is a fresh invocation, so an invocation-keyed edge could never
coalesce: `hits` would always be 1 and the counted-upsert design would be dead
on arrival. The session (trajectory branch) is the unit that re-reads a file
five times; the edge belongs to it, and `last_invocation_id` on the row keeps
the most recent producing invocation for drill-down.

Soft edges are best-effort _signal_, not provenance. **The per-read DO write is
accepted on purpose: recording that a read happened is the point.** What they
must not do is bloat the canonical log — a hash-chained, replayed, forkable log
event per read would inflate it 10–100×. So they live **off the log** as
counted upserts, coalesced per edge identity within a session, excluded from
integrity/replay, and **prunable**.

Note what is **deliberately absent**, carried over from v1 and still binding:
no `included` fiber (the system showing something to the agent must not feed
its own future ranking — a rich-get-richer loop a low coefficient only slows,
never makes safe) and no `probed` fiber (the agent's budget dial is not a
graph signal). Density is reinforced **only by the agent's real behavior** —
reads, edits, assertions, citations. And no `edited` soft rows: that edge is
native now.

### 4.2 Soft-signal schema

```sql
CREATE TABLE gad_touches (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- observed | cited
  session_log_id TEXT NOT NULL,    -- src: the trajectory branch (hint — §6.4)
  session_head TEXT NOT NULL,
  dst_kind TEXT NOT NULL,          -- file | claim
  dst_id TEXT NOT NULL,
  last_invocation_id TEXT,         -- most recent producing tool call (drill-down)
  turn_seq INTEGER,                -- latest touching turn's ordinal (turn-decay)
  hits INTEGER NOT NULL DEFAULT 1, -- coalesced repeat count
  last_block_sig TEXT,             -- observed only: signature of the last block
                                   -- rendered to this session for this file (§7.1)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_touches_dst ON gad_touches(dst_kind, dst_id, id);
CREATE INDEX idx_touches_session ON gad_touches(session_log_id, session_head, id);
-- One counted row per (kind, session, target): repeats bump hits/turn_seq.
CREATE UNIQUE INDEX idx_touches_coalesce
  ON gad_touches(kind, session_log_id, session_head, dst_kind, dst_id);
```

`last_block_sig` makes the coalesced observed row do double duty: it is also
the re-read-suppression memory (§7.1) — the row the read upserts anyway is
exactly the per-(session, file) slot the suppression check needs, so
suppression costs zero extra tables and zero extra writes.

Density reads a soft edge as its kind weight scaled by a _sublinear_ function
of `hits` (default `sqrt`, a tuning knob §12) — bounded accumulation — while
native repeats compound by adding rows (distinct edits/assertions).

Pruning: the periodic server-driven pass (same shape as `runGadGcMark/Sweep`)
ages out soft rows below a relevance floor. Because degree is computed at query
time (§6.5), there is no degree counter to keep in sync on removal — the
v1 "symmetry rule" footgun is gone by construction.

## 5. Blame: the hunk chain becomes a guaranteed invariant

The row set is already served: `fileHistory(repoPath, path, head)` = the path's
committed ops in commit-lineage order (event-keyed ancestry, not global seq)
plus the uncommitted working tail. Joining `invocation_id →
trajectory_invocations` yields turn/session; `committed_event_id` yields the
commit and its mandatory message.

**Line-level blame is an interval problem in offset space**, and offset
composition is only correct if each op's base **is** the previous op's output.
Today that chain holds within a head (working edits are CAS-serialized and
`EditEngine.applyEditOps` derives `old_content_hash` from the composed map)
but has two genuine holes: **merge commits record no per-file ops at all**
(host-side merge/heal ingests carry no `editOps`, and the DO's `vcsMerge`
clean-commit path needs the same verification), and nothing *enforces*
continuity where ops are supplied to an ingest. We do not work around those
holes with query-time content-diff fallbacks — **we close them in the VCS**, so
the chain is total by construction and blame is exact:

### 5.1 VCS upgrades (the substrate changes, not just the consumer)

- **U1 — hunk completeness invariant.** Every edit op that mutates an existing
  **text** file carries `hunks_json` — enforced at insert time in the store
  (`insertWorkingEditRows` and the ingest `editOps` path), not left to caller
  goodwill. `hunks_json IS NULL` is legal only for `create`, `delete`, `chmod`,
  binary content, and **explicitly-marked synthetic ops** (below), and binary
  is **marked explicitly** on the row so blame can distinguish "no line
  structure" from "missing data". A violating insert is rejected loudly.
  **Synthetic carve-out (v3):** the narrow-host P3 crash-heal keeps a degraded
  fallback — a main matching no recorded publish intent is caught up by a
  synthetic ingest of the ref's tree, which cannot carry true hunks. Those ops
  are **stamped synthetic on the row**; blame (§5.2) and the U2 integrity
  chain check treat them as chain restarts (like `create`), never as silent
  gaps and never as integrity failures.
- **U2 — chain continuity invariant.** An op's `old_content_hash` must equal
  the path's content at its base: for working rows this is already structural
  (the composed working map produces it — assert it anyway); for ingest-supplied
  `editOps` (bootstrap/merge/fork) the store validates each op against the
  **first parent state** and rejects on mismatch. `checkGadIntegrity` gains a
  per-path chain check — walking each path's first-parent lineage,
  `op[k+1].old_content_hash == op[k].new_content_hash` — so a broken chain is a
  loud integrity failure, never a silent mis-blame.
- **U3 — provenance-preserving merges.** `diff3Merge` (now
  `vcs-engine/src/diff3.ts` — a pure package, so this change is clean and
  host-free) already computes the full base/ours/theirs chunk alignment
  internally and throws it away, returning only merged text. Extend it (and
  `MergeEngine`'s per-file results) to also return **merge hunks against the
  OURS side**, each annotated with origin: `{start, end, newText, origin:
  "theirs" | "resolved", theirsStart?, theirsEnd?}` — a region theirs changed
  and ours didn't is a `theirs` hunk carrying its source range in the other
  parent's content; a conflict the agent resolved is `resolved` (authored by
  the resolving session's own edit ops). The merge engine already holds
  base/ours/theirs per file, so this is recording what it already knows. The
  merge ingest then passes these as `editOps` (`old_content_hash` = ours,
  `new_content_hash` = merged — satisfying U2 against the first parent), using
  the `IngestWorktreeStateInput.editOps` path that already exists. This
  applies to **both** merge sites in the narrow-host world: the DO's
  `vcsMerge` (ctx-head merges, P5d — verify its clean-merge commits record
  ops at all) and the P3 gad push/merge orchestration. Merges stop being
  blame holes; they become exactly-routable nodes.

### 5.2 The blame algorithm (exact, no fallback)

`blameLines(repoPath, path, lineRange, head)` — a helper, not inline SQL:

1. **Materialize** the file at `head` (the read already has the bytes) and map
   the query lines to character offsets.
2. **Walk the first-parent chain newest→oldest** (working tail first; at a
   merge commit, first parent = ours, `gad_transition_parents.ordinal = 0`),
   carrying each query offset back through every later op's delta: a hunk
   shifts offsets after it by `newText.length − (end − start)`. To test op
   _k_, map the offset through ops _k+1…latest_ into _k_'s post-state
   coordinates, then check containment in `[start, start + newText.length)`.
   The first containing op wins; its `invocation_id`/`committed_event_id` is
   the answer.
3. **Route through merges.** A hit inside a merge op's hunk resolves by
   origin: `resolved` blames the resolving session's edit ops (which precede
   the merge commit on the same head); `theirs` maps the offset into the other
   parent's coordinates via the recorded `theirsStart`/`theirsEnd` and
   **continues composing along that parent's own first-parent chain**. All
   contexts commit to the same per-repo log, so the other branch's ops are
   present with their true authors — routing terminates at a `create` or at
   lines older than the log.
4. **Semantic stops only.** `create`, binary ops, and **synthetic ops** (the
   marked crash-heal catch-up ingests, U1) end the walk because identity
   genuinely begins (or provably restarts) there — the only remaining
   "barriers" are true ones, and a synthetic stop reports itself as degraded
   rather than blaming the healing actor. There is **no content-diff
   fallback**: U1–U3 make the chain total, and an unmarked gap is an
   integrity bug to fix, not a case to paper over.

Bounded per-file computation at query time — O(ops reachable for this path),
not stored state. Non-agent ops blame to actor + commit with no producing
turn.

## 6. Retrieval: provenance ∪ recall, re-ranked by session density

Three layers, most-exact first — unchanged from v1 in architecture:

1. **Provenance (structure)** — blame, edit lineage, claim links. Exact, never
   "ranked away."
2. **Recall (similarity)** — FTS over `gad_memory_fts` (claims, commit
   messages once indexed, messages, committed files). Surfaces a relevant claim
   even when no structural path reaches it. The read tool steers it with
   explicit `recallKeywords` (§7.1); absent those, the query is the file path
   plus the session's recent touch anchors.
3. **Density (re-ranking signal)** — bounded 2-hop spreading activation seeded
   from the session's touch-set, ordering the union of (1) and (2). A pure FTS
   hit with no structural path still appears; it just sorts below an
   equally-similar candidate the session already worked near.

`touch(S)` — the anchors the current session touched — is **not loop-held
state**. It is reconstructed inside the gad-store DO from its own records,
scoped to the session's trajectory branch: edits via
`idx_edit_ops_invoc ⋈ trajectory_invocations(log_id, head)`, claims via
`gad_claims.trajectory_event_id`, reads/citations via `idx_touches_session` —
each capped to the last `K`. It grows as the session works, which is why
ranking sharpens over a turn.

### 6.1 Score

```
rank(C) = w_sim · sim(C)                          // FTS relevance; 0 if not an FTS hit
        + w_prov · idf(C) · Σ_{ paths p : touch(S) ⇝ C, len(p) ≤ 2 }
                              Π_{ edge e ∈ p }  w_kind(e) · decay(e) · norm(src(e))
```

- `w_kind(e)` — flat per-kind base weights (native `edited`/`asserted`/relation
  edges 1.0/0.8; soft `cited` 0.7, `observed` 0.5). Edit _magnitude_
  (lines/hunks) is **never** a weight input — it structurally biases toward
  bulk/generated files; relationship depth emerges from accumulation and kind.
- `idf(C) = 1 / log(2 + degree(C))` — specificity: a node connected to
  everything is background hum.
- `norm(X) = 1 / sqrt(outDegree_kind(X))` — stops a 50-file refactor or a
  promiscuous bridge node from flooding the ranking.
- `decay(e)` — logical, never the query-time wall clock (§6.3).

### 6.2 Weighting

Flat per kind; discriminate with `idf`/`norm`; magnitude never an input. (v1
§6.2, unchanged.)

### 6.3 Decay basis: logical, two clocks

- **Session-recency leg** (`touch(S) → X`): decay in **turns ago** within the
  branch chain (`turn_seq` delta / trajectory_turns ordinal).
- **Historical leg** (`X ~ C`): decay in **per-anchor ordinality** — e.g. how
  many later edits to that file exist past the edge, counted on the
  `idx_edit_ops_path` order. **Never global `log_events.seq`** (polluted by
  unrelated logs) — and note the native `fileHistory` ordering already obeys
  this rule via ancestry traversal. Wall-clock `created_at` is display-only.

### 6.4 Session identity: a position in the trajectory DAG

Unchanged from v1: no authoritative session id. A fiber/edge belongs to its
event/invocation on the immutable trajectory DAG; "the current session" is
branch-chain reachability from the current head — the same recursive
parent-chain scoping `materializePiMessages` uses. Mid-session forks are
correct for free. The `gad_touches.session_*` columns are a denormalized hint
for the no-fork fast path; a fork falls back to branch-chain scoping.

### 6.5 Cost: bounded inline, no counters to maintain

O(neighborhood), independent of total log size — two indexed join passes, not
`RECURSIVE`, with caps that double as quality controls: seed = last `K`
touches; per-node fan-out = top-`M` by recency; candidates = top-`N`.

**Degree is computed at query time**, as capped indexed `COUNT`s over
`idx_edit_ops_path` / `idx_touches_dst` / claim-relation indexes — candidates
number ≤ `N·M`, each count is an index-range scan, and there is no incremental
counter to drift (v1's `gad_node_degree` + prune-symmetry rule are deleted from
the design). If profiling on real logs shows the counts biting, a
`gad_node_degree` materialization by the periodic pass is the named lever — an
optimization, not a correctness mechanism. The same periodic pass is the
escape hatch for richer-than-2-hop affinity if 2-hop proves insufficient.

## 7. Read-time attachment: agent-budgeted, parallel, best-effort, warmed

Carried from v1 with two new signal lines (commit messages, working-edit
status). Restated compactly; v1's rationale holds where not amended.

**Behavioral grounding, stated once.** Agents do not seek context; they use
what is in front of them — push beats pull, always. Agents follow verbatim
pre-written affordances but essentially never page (`+N more` is chased only
when a warning or the task points into it), so the system's value concentrates
in the **first handful of items**: page-one ranking quality is the product, and
paging is a safety valve. And agents habituate to boilerplate within a few
reads — a block that is filler on most reads gets skimmed forever after,
including the day it carries a critical contradiction. **Silence preserves
salience**: an attachment worth reading every time it appears beats one that
always appears. These facts drive §7.5 — and they shape how the tier is
prompted (§7.1, §13): as a policy the agent sets and tunes, not a per-file
whim.

### 7.1 The mandatory tier: informed judgment the agent owns and tunes

`read` takes a **mandatory** `provenance: "none" | "moderate" | "deep"` — the
agent's context budget for the read:

| tier       | does                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `none`     | file content only — no attachment                                                           |
| `moderate` | blame (last-commit + working-edit lines) + FTS recall + 1-hop density re-rank               |
| `deep`     | `moderate` + full 2-hop density + claim-relation walk (`supports`/`contradicts`/`refines`)  |

The known failure mode of a mandatory per-call arg is collapse to a constant —
models settle into whatever the last few calls used. We keep the tier mandatory
anyway, and meet the failure mode with **judgment, not a lookup table**. The
spec deliberately prescribes **no tier↔situation mapping**: we have no idea
how well each tier is actually tuned for any given situation — whether an
agent executing a set plan needs `moderate`, `none`, or `deep` is an empirical
question only the agent's own experience answers. So the prompt (§13) does two
things and no more:

- **Makes the tiers legible** — what each one computes, what it costs, what it
  tends to surface — so the choice is informed rather than ritual.
- **Instructs the agent to choose from its situation and its experience**:
  what it is doing right now (merely using code, executing a plan, planning a
  change — each *bears on* how much history matters, without dictating a
  tier), crossed with how the system has actually been behaving for it —
  insightful, chatty, redundant, distracting — on this codebase, lately.

The tier distribution is instrumented (§12) as a judgment health-check:
situation-responsive variation is what good use looks like; a reflexive
constant means the prompt needs pressure — never a silent default.

**Re-read suppression still applies underneath nonzero tiers.** The system
detects redundancy better than any policy: suppression has its **own key**,
not the warm cache's `touch_version` (which advances on *every* touch —
including the `observed` touch each read writes — so a version-keyed check
would never fire). Define a **block signature** per (session, path): hash of
(the path's content hash, the path's latest edit-op id, the path's
exception-item set). The read tool's coalesced `observed` upsert already lands
on exactly the per-(session, path) row this needs, so the signature is stored
there (`gad_touches.last_block_sig`, §4.2): recompute is one indexed lookup,
and when the signature is unchanged the block is suppressed — zero extra
tables, zero extra writes. A file changed by another session, or one that
gained an exception item, changes the signature and re-attaches — exactly the
re-read that must not be silent.

The runtime enforces hard ceilings regardless (`PROV_BUDGET_MS`, per-tier item
caps), so even reflexive `deep` cannot blow up compute or context — the tier
is a request within system bounds, not authority.

`recallKeywords: string[]` (optional) steers the similarity leg beyond the
file's own text. Expect it to be used sporadically at best — optional steering
args always are — so the fallback (path + session touch anchors) must carry
the recall leg on its own; keyword steering is a bonus, never load-bearing.

The item budget is counted in **items, not tokens** (each item one bounded
`insight + handle` line), and the low-ranked tail is **withheld but
advertised**: every truncated section reports `K of M` and the exact call to
fetch the rest. Under-budget is recoverable, so the low default budget is safe.

**Drill-down contract.** `provenance(target, after?)` — the tool, also
reachable via eval (`gad.provenanceForFile({ path, head, tier, after })`) —
returns `{ items, shown, total, nextCursor }`: unbounded paging on top of the
cheap first page; deepen one item (`provenance("claim#42")`) or page a file.

**Every read leaves a trace**: one coalesced `observed` touch, at every tier,
even when the block is suppressed. The tier is the agent's budget dial, not a
graph signal — nothing records what depth was asked.

**Token-budget realism.** A working agent reads 20–40 files per turn; at ~5
items × ~40 tokens that is 4–8k tokens/turn of attachments. The salience floor
(§7.5) and re-read suppression are what keep the attachment from becoming the
first thing context-window pressure squeezes out.

### 7.2 Run it in parallel — content and provenance are different services

Read bytes come from the fs RPC against the materialized working tree; the
provenance/recall/density work is **one** gad-store DO call. The two
round-trips overlap; wall-clock is `max`, not sum. **Gotcha to preserve:** this
holds only while content stays off the gad-store DO — don't "consolidate" reads
onto `readGadFileAtState`.

### 7.3 Breathing room: standalone budget + speculative warm

The attachment is consumed by the model's _next generation_, not by the read —
so its ceiling is a deliberate `PROV_BUDGET_MS` (tens–low-hundreds of ms), and
a warm cache gives density room:

- **Speculative warm (primary).** On `turn.opened` and during generation,
  precompute `moderate`-tier blocks for the session's likely-next files
  (recent touch neighborhood, recently-edited files on the head) into
  `gad_provenance_cache(head, path, touch_version, rendered_json, created_at)`,
  keyed by a `touch_version` that advances with the session's touch-set.
  Disposable, never authority.
- **Graceful degrade (rare miss).** Return content now with a one-line
  `provenance ready — provenance("path")` hint; write the computed block to the
  cache. The read still emits its `observed` touch — it records what the agent
  did, never what a block might have displayed.

### 7.4 Ordering & determinism

Compute the attachment against the pre-read touch state; write this read's own
`observed` touch after the query resolves. The **native** graph (edits, claims,
relations) is log/mechanism-derived and covered by integrity; the soft layer is
explicitly non-deterministic (timing-, cache-, and FTS-state-dependent) and
sits outside integrity/replay. Do not paper over this — it is why the soft
layer is soft. The rendered block is ephemeral and never persisted.

### 7.5 Attachment format: exceptions first, then density, floored

Fuses three layers, cheapest-to-richest, **never generating prose on the hot
path** — semantics are recalled (claims, commit messages), not synthesized:

1. **Structural skeleton + handles** — edit recency, committing sessions,
   co-edited files; short handles (`claim#42`, `commit:9f2e`, `file:retry.ts`)
   as the query surface for follow-ons.
2. **Derived structural signals** — hub-ness, coupling, churn, staleness,
   contradiction flags, **uncommitted-working status** ("2 uncommitted edits
   from this context"). Deterministic, high value-per-token.
3. **Recalled semantics** — claims and **commit messages** surfaced by the
   similarity leg, verbatim: a past agent's already-distilled,
   provenance-anchored judgement at zero generation cost.

Two ordering/visibility rules, both consequences of the §7 behavioral
grounding:

- **Exception class sorts first, above density.** Asserted contradictions and
  **cross-session concurrency** ("session:X has 2 uncommitted edits on this
  file") always render, at the top, regardless of score. The warning is the
  line the agent must not skim past — and the concurrency line is exactly the
  context that prevents co-editing collisions.
- **Salience floor.** Non-exception items render only above a minimum score;
  when nothing clears it, the block is the bare one-line header — or nothing
  at all. **Do not pad with structural filler** ("edited 3 turns ago · 2
  sessions") just because it is available: filler on every read trains the
  agent to skim the block, and then the good items die with it. v1's "degrades
  gracefully to structure" is rescinded as a display policy — sparse eras get
  thin blocks, and that is correct. (Structure is still computed and reachable
  via `provenance()`/SQL; the floor is about what is *pushed*.)

Standard example:

```
prov · src/foo.ts · 5 of 19 items
● ⚠ contradicts claim#7 "retries are caller-controlled" → provenance(claim#42)
● session:retry-rework has 2 uncommitted edits on this file
● last commit c:9f2e "clamp the retry budget before dispatch" · 2 turns ago
● claim#42 "foo owns the retry budget" ·supports #7· 4 sessions touched it [●●●●○]
● co-edited with src/retry.ts ×3 of last 5 commits [●●○○○]
  +14 more (8 claims · 4 commits · 2 files) → provenance("src/foo.ts")
```

`deep` expands the claim-relation graph and the 2-hop neighborhood. Early
(sparse claims) the block is thin by design and fattens toward semantics as
memory accrues — the seeding pass (§8) exists to shorten that era.

## 8. Hermeneutic claims

A claim can stand as an **entity**, a **predicate**, or a full **statement**.
Keep `gad_claims` (columns already nullable), add `claim_kind TEXT` and a
free-`text` column (clean reset); add the relations table:

```sql
CREATE TABLE gad_claim_relations (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,          -- the knowledge.* log event that asserted it
  src_claim_id TEXT NOT NULL,
  relation TEXT NOT NULL,          -- supports | contradicts | about | refines | depends_on
  dst_claim_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claim_rel_src ON gad_claim_relations(src_claim_id);
CREATE INDEX idx_claim_rel_dst ON gad_claim_relations(dst_claim_id);
-- Replay/fork folds one event under multiple heads: dedup by constraint,
-- exactly like gad_state_transitions — never by check-before-insert.
CREATE UNIQUE INDEX idx_claim_rel_ident
  ON gad_claim_relations(event_id, src_claim_id, relation, dst_claim_id);
```

Agent tools (thin emitters of the already-projected `knowledge.claim_*` events
plus a new `knowledge.claims_related` kind):

- `record_claim({ text | subject,predicate,object, kind })` — **dedup-on-write**:
  FTS the text against existing claims first; on a near-duplicate return the
  candidates so the agent revises/relates instead of forking a second
  near-identical node. Cold-start is when dup risk peaks and FTS is the one
  signal that works there.
- `relate_claims({ src, relation, dst })` — relations are **agent-asserted**,
  never auto-detected; the attachment's "⚠ contradicts" surfaces a previously
  asserted contradiction.
- `revise_claim` / `retract_claim`.

**Capture rides the commit flow, because voluntary bookkeeping loses.** Every
deployed memory system has learned the same lesson: agents skip optional
memory tools even under strong prompting — at the moment of insight the
gradient pulls toward finishing the task, so a standalone `record_claim`
yields single-digit claims per long session. The one moment an agent reliably
stops and verbalizes "what I did and why" is the **mandatory commit message**.
So:

- **The commit _tool_ accepts an optional `claims: [...]`** (each a
  `record_claim` payload, run through the same FTS dedup): recording durable
  insight costs zero extra tool calls at the moment of maximal clarity, and
  the claims are born linked to the commit event.
- **Layering is strict**: claims are projections of `knowledge.claim_*` events
  on the agent's **trajectory** log, and `vcsService` appends only to per-repo
  **vcs** logs — it must never write trajectory events. So `claims:` lives on
  the **harness commit tool**, which calls `vcs.commit` and, on success, emits
  the claim events through the agent's normal claim path (right log, right
  causality, commit event id attached as the claim's anchor). Anyone
  implementing claim-writing inside `vcsService` is breaking event-sourcing
  ownership.
- **Dedup never blocks the commit.** The commit stands regardless; near-
  duplicate candidates come back in the tool result for the agent to revise or
  relate on the next call.
- **The commit result nudges** when no claims were passed and the diff is
  non-trivial: one line — "anything durable to record? (`claims:` on commit,
  or `record_claim`)". A nudge in a tool result, at the right moment, moves
  agent behavior more than a paragraph of system prompt.
- **Commit messages carry the early load.** They are FTS-indexed (T3) and
  provenance-anchored, so expect them to be the dominant semantic recall
  source at first, with claims accreting on top. That is fine — it is the same
  loop with a shallower artifact.

**Seed the claim base at the bang.** An empty claims table means weeks of thin
attachments — and habituation (§7) gets decided in the first days. Ship a
**one-time distillation pass**: an agent sweep over the workspace's docs,
design files, and recent history that records initial claims (through the
normal `record_claim` path, so dedup and FTS indexing are exercised
immediately). Seeded claims are ordinary claims — provenance-anchored to the
seeding trajectory, revisable, retractable.

Claim↔trajectory links are the native `invocation_id`/`trajectory_event_id`
columns; claim↔claim relations participate in density through the views.

## 9. SQL-first surface

Ship views + one helper, not a thick API:

- `provenance_for_file` — edit ops ⋈ trajectory invocations ⋈ commits (message,
  actor, turn) for a path.
- `edge_graph` — the UNION view over native edges + `gad_touches`, in one
  `(kind, src_kind, src_id, dst_kind, dst_id, weight_basis)` shape for ad-hoc
  traversal.
- `claim_graph` — claims + relations + touching invocations/sessions.
- `provenanceForFile({ path, head, tier, recallKeywords, after? })` — the §6
  pipeline returning the item-budgeted page plus `{ shown, total, nextCursor }`;
  the one unit the warm cache, read attachment, and drill-down all call.
- `blameLines(repoPath, path, lineRange, head)` — §5; the offset composition
  must not be reimplemented in ad-hoc SQL.

Raw `gad.query` (read-only CTEs) returns **unranked** edges: SQL is for chasing
a specific handle, not re-deriving the ranked block. Follow-on ergonomics
(every line one insight + one handle; `K of M` counts; the pre-written next
query for the top thread) carry over from v1 verbatim.

## 10. VCS modifications this plan makes

The rework was built for exactly our direction, but this plan changes the
substrate where it falls short rather than working around it — four tool/service
seams (T1–T4) and five store/merge/recall upgrades (U1–U3 specified in §5.1;
U4–U5 below):

- **T1 — commit causality.** The `vcs.commit` schema carries neither
  `invocationId` nor `turnId`, so the commit _event_ is attributable only
  through its ops. Thread the committing tool-call id through `commit` →
  `commitWorking` → the ingest's causality, same self-asserted pattern as
  `vcs.edit`. (Ops keep their own invocations through the re-key; this is
  about blaming the commit itself, e.g. for merge/empty commits.) **v3
  timing:** cheapest folded into the narrow-host P3, which reopens the commit
  schema anyway — flagged in the handoff (A2).
- **T2 — keep invocation stamping mechanical.**
  `workspace/packages/harness/src/tools/edit.ts`/`write.ts` pass `toolCallId`
  by hand today (the executor supplies it positionally; each tool opts in).
  Move the stamp into the shared tool-executor wrapper so a future tool
  cannot forget it — mechanism over discipline.
- **T3 — index commit messages into `gad_memory_fts`** (`kind='commit'`,
  anchored to the commit event id) at commit-projection time, so the mandatory
  messages join the recall leg. They are the cheapest high-quality semantic
  signal in the system.
- **T4 — `claims:` on the commit tool** (§8): the **harness** commit tool
  accepts an optional claims array and, after `vcs.commit` succeeds, emits the
  claim events through the agent's own claim path (trajectory log — never via
  `vcsService`, which must not write trajectory events); dedup never blocks
  the commit; the tool result carries the one-line nudge when the diff is
  non-trivial and no claims were passed.
- **U1/U2/U3 — the blame-chain invariants and provenance-preserving merges**
  (§5.1): hunk completeness enforced at insert with explicit binary marking;
  chain continuity validated at ingest and checked by `checkGadIntegrity`;
  `diff3Merge` returns origin-annotated merge hunks vs ours and the merge
  ingest records them as `editOps`. These modify the VCS substrate itself —
  the plan upgrades the system rather than working around it.
- **U4 — owner-derived blob pruning (v3: half-landed upstream, one live
  hole).** The VCS file CAS and the general blobstore are **the same
  directory**, holding GAD file versions, spilled log-event payloads
  (referenced by the gad-store DO's `log_blob_refs`), and ad-hoc userland
  blobs. The narrow-host tree already ships the server-driven shape v2 asked
  for: `VcsGcScheduler` runs hourly with a 24h min-age, rooting on mains
  reachability unioned with the DO's `runGadGcMark().liveBlobDigests`. What
  remains of U4:
  1. **Close the working-edit hole — urgent, pre-bang.** `runGadGcMark`'s
     live set is the union of `gad_file_versions` + `log_blob_refs` +
     mutations + observations; it does **not** include
     `gad_worktree_edit_ops.new_content_hash`, and working-edit bytes reach
     the host CAS with no `gad_file_versions` row until commit — so an
     uncommitted edit older than the min-age can have its content swept and
     the eventual commit dangles. Add uncommitted edit-op hashes (new and
     old) to the mark union. Flagged as A1 in the handoff; fix belongs
     upstream regardless of this plan's timeline.
  2. **Demote the caller-supplied list.** `blobstore.pruneUnreferenced` (and
     the tree-object variant) still accept a caller-supplied `referenced`
     list over the shared CAS — delete the RPC or re-route it through the
     owner-derived root set. A caller-supplied list is never authority.
  3. **Align with P4.** The narrow-host plan's gad-declared pin/unpin root
     surface (for staging lineages, archives, pending intents) subsumes the
     rest of v2's U4 when it lands; until then the DO-mark union is the
     mechanism.
- **U5 — fail-loud file indexing (v3: seam moved, bug confirmed live).**
  Indexing is now split — the host decodes bytes and calls the DO's
  `indexMemoryFiles`; markers live DO-side — but the host half
  (`src/server/vcsHost/workspaceVcs.ts`, `indexRepoFiles`) still skips a
  missing CAS blob (`!bytes → continue`) and then advances the `memidx:`
  marker unconditionally — a transient miss permanently un-indexes that file
  version (the marker-equality fast path never revisits it) with no trace.
  Missing blobs **abort the pass** so it retries on the next advance, and
  every skip (size cap, binary sniff) is logged — no silent caps. Flagged as
  A4 in the handoff (cheapest fixed upstream while that code is fresh). Two
  adjacent seams land with it: `rebuildTrajectoryProjections` triggers a file
  reindex kick (replay wipes the `memidx:` markers but nothing re-runs the
  pass until the next per-repo `main` advance or server restart — an
  empty-file-recall window the recall leg must not have), and `recallMemory`
  dedups published copies (a `message.completed` projected on both the
  trajectory and channel logs indexes once per log and returns duplicate hits
  for the same text).

Explicitly **not** tweaked: `invocation_id` stays self-asserted (the DO cannot
verify a tool-call id; pre-release this is fine and T2 makes it mechanical);
the fs-bridge stays actor-only (honest degradation). Also **known and
accepted**: REFERENCE-class payloads (tool `request`/`result`/`output`/`error`,
`blocks[*].arguments`) are never FTS-indexed — deliberate, not a gap. Raw tool
bulk is not the recall surface; claims and commit messages are the distilled
one. Message and claim text can never arrive as a ref (storage classes make
block content INLINE with a hard emitter error on oversize), so the recall leg
has no silent spill hole by construction.

## 11. Build plan — one big bang

Everything ships together, in one schema bump, as a single coherent system. No
value gates, no bake-offs, no interim milestones: the differentiator is the
whole loop (blame → claims → density-ranked recall → read attachment), and it
is built and landed as one.

**v3 sequencing constraint: the bang lands after (or inside) the narrow-host
P3.** P3 moves main-advance/merge provenance from the host
`ProvenanceFollower` into the DO (write-ahead publish intents) and deletes the
host push pipeline — the exact substrate U1–U3 bind to. Building the blame
invariants against the follower now means building against code scheduled for
deletion; instead, U1–U3 (and T1) are contributed *into* P3 via the handoff
(`docs/gad-provenance-handoff-2026-07.md`, items A2/A3). Two handoff items are
pre-bang and independent of our timeline: the GC working-edit hole (A1 — the
urgent half of U4) and the index-marker fix (A4 — the upstream half of U5).

The workstreams below are a decomposition for
implementation order within the bang, not release phases — nothing is "done"
until all of them are:

- **Blame** — U1/U2 (insert-time invariants + the `checkGadIntegrity` chain
  check) and U3 (`diff3Merge` origin-annotated merge hunks + merge-ingest
  `editOps`), §5.1; T1 + T2 (§10); `blameLines` (§5.2); the
  `provenance_for_file` view.
- **Claims** — `record_claim` (FTS dedup-on-write) / `relate_claims` /
  `revise_claim` / `retract_claim`; `gad_claim_relations` + the
  `knowledge.claims_related` kind; `claim_kind`/`text` columns on `gad_claims`;
  T4 (`claims:` on commit + nudge); the one-time seeding distillation pass (§8).
- **Touches** — `gad_touches` + the read tool's coalesced `observed` upsert and
  drill-down `cited` upsert; the periodic prune pass.
- **Recall** — T3 (commit messages into `gad_memory_fts`); `recallKeywords`
  steering; U5 (fail-loud file indexing: abort-don't-advance on missing CAS
  blobs, logged skips, the post-replay reindex kick, and `recallMemory`
  dedup of published copies).
- **Blob-CAS safety** — U4: owner-derived server-driven mark-and-sweep prune
  for the shared blobs directory; caller-supplied `referenced` lists lose
  authority.
- **Density + attachment** — `provenanceForFile` (§6 pipeline over the views,
  query-time degree, capped 2-hop); the mandatory ternary `provenance` read
  arg with judgment-based guidance, plus mechanical re-read suppression
  underneath (§7.1); the exception class + salience floor (§7.5); parallel best-effort
  attachment (§7.2–7.5); `provenance()` tool + paging; the
  `edge_graph`/`claim_graph` views.
- **Speculative warm** — `gad_provenance_cache`; warm on `turn.opened` and
  during generation; degrade-to-hint on miss.
- **Prompt** — the §13 guidance lands with the tools, not after them: the
  machinery and the behavior that exploits it are one deliverable.
- **Instrumentation** — the four behavioral counters (§12) land with the bang:
  they are how we find out which behavioral bet is failing.

Tuning (§12) happens after the bang, on the logs the bang produces — decay λ,
caps `K`/`M`/`N`, kind weights, `w_sim`/`w_prov`, `observed`/`cited` weights
and the `hits` curve, the salience-floor threshold, density buckets,
`PROV_BUDGET_MS`, warm-set heuristic; materialize degree/affinity only if
profiling demands.

## 12. Resolved decisions & remaining knobs

Resolved (locked for the build):

- **No physical unified fiber table.** Native edges live in their source
  tables and are read through views; exactly one physical soft table
  (`gad_touches`) for behavioral signal. No dual-writes anywhere.
- **Anchors:** commits are identified by **event id**, never state hash.
- **Blame is exact, by invariant — not best-effort.** The hunk chain is total
  by construction (U1 completeness + U2 continuity, enforced at insert/ingest
  and checked by `checkGadIntegrity` — which today has no edit-op referential
  checks at all; the chain check is net-new); merges are provenance-preserving
  nodes (U3 origin-annotated hunks), not barriers; line blame = offset-space
  composition along the first-parent chain with merge routing (§5.2).
  Semantic stops are `create`, binary, and marked-synthetic crash-heal ops —
  there is no query-time content-diff fallback; an unmarked chain gap is an
  integrity bug, not a case.
- **Soft touches are session-anchored** (session → file/claim) — an
  invocation-keyed edge could never coalesce since every read is a fresh
  invocation; `last_invocation_id` is a column, not the key.
- **Re-read suppression is signature-keyed, on the observed row.** Block
  signature = (path content hash, latest edit-op id, exception-item set),
  stored in `gad_touches.last_block_sig` — never the warm cache's
  `touch_version`, which advances on every touch and would never suppress.
- **Decay:** logical, two clocks (turns-ago; per-anchor ordinality); never the
  query-time wall clock; never global `log_events.seq`.
- **Weighting:** flat per-kind; `idf`/`norm` discriminate; magnitude never an
  input.
- **Degree:** query-time capped counts; materialization is a named
  optimization lever, not a correctness mechanism.
- **Session identity:** trajectory-DAG position; `gad_touches.session_*` is a
  hint; forks fall back to branch-chain scoping.
- **The tier is mandatory, and the choice is judgment — no prescribed
  mapping.** Every read names `none`/`moderate`/`deep`. The spec deliberately
  binds no situation to a tier (nobody knows yet how well each tier fits any
  situation); the prompt makes the tiers legible and instructs the agent to
  choose from its situation crossed with its accumulated experience of how
  insightful vs. chatty the system has been, and to tune over time (§7.1,
  §13). The known collapse-to-a-constant risk is accepted, monitored via the
  tier distribution, and answered with prompt pressure — never a silent
  default. Mechanical block-signature re-read suppression still runs
  underneath nonzero tiers.
- **Exceptions first, floored.** Contradictions and cross-session concurrency
  always render, at the top, regardless of density; everything else clears a
  minimum score or the block is thin/absent. No structural filler — silence
  preserves salience (§7.5).
- **Claim capture rides the commit tool** (`claims:` + result-line nudge, T4),
  emitted through the agent's trajectory claim path after `vcs.commit`
  succeeds — `vcsService` never writes trajectory events, and dedup never
  blocks a commit. Standalone `record_claim` remains but is not the
  load-bearing path. The claim base is seeded at the bang (§8).
- Item-based budgets; withheld-but-advertised tails (`K of M` + paging);
  attachment parallel with the fs read on a standalone `PROV_BUDGET_MS`;
  warmed; `observed` records only what was actually read.
- **Determinism:** native graph is mechanism-derived and integrity-covered;
  the soft layer is explicitly non-deterministic and outside integrity/replay.
- **No `included`, no `probed`, no self-reinforcement from showing.**
- **Turn's source of truth is the join** (invocation → trajectory); the
  substrate's stored `turn_id` on edit-op rows is a write-time
  denormalization, never authoritative. No turn/session columns on any edge
  this plan adds.

Remaining knobs (set defaults now, tune on real logs): λ and `K`/`M`/`N`; kind
weights and `w_sim`/`w_prov`; the `hits` curve (default `sqrt`); whether the
historical leg decays at all or `idf` alone discriminates (default: mild decay
and `idf`); the salience-floor threshold; `PROV_BUDGET_MS`; warm-set selection;
per-tier item budgets; **exploration-sweep damping** — a grep-then-read-15-files
sweep floods the touch-set with shallow `observed` signal, so consider weighting
a read by whether the session later edits or cites near it, or capping the
read-only share of the density seed. Scope is the agent read tool only, never
the fs RPC or panel/programmatic reads.

**Instrumentation (ships with the bang, §11).** Four behavioral counters tell
us which bet is failing, and they are the tuning inputs: (1) the **tier
distribution over time and situation** — the health check on §7.1's judgment
bet: situation-responsive variation is what good use looks like, and a
reflexive constant means the prompt needs pressure, (2) drill-down/paging
rate, (3) claims
recorded per session — split commit-borne vs standalone, (4) **attached-claim
action rate**: how often an item we pushed gets cited, deepened, or
edited-near downstream. (4) is the system's real KPI — it measures whether the
attachment is being read or skimmed. If it sags while attachments are being
rendered, the salience floor is too low; raise it before touching anything
else.

## 13. Prompting the agent

The machinery pays off only if the agent acts on the block and feeds the
memory. The prompt is short on exhortation and long on concrete triggers —
abstract "use your tools wisely" guidance does nothing; named moments do.
Phrased to the agent roughly as:

**Choose your tier with judgment — yours, not a rulebook.** `provenance`
(`none` | `moderate` | `deep`) is mandatory on every read. Know what each
buys: `none` is just the bytes; `moderate` adds blame, concurrent edits, and
recalled claims about the file; `deep` adds the wider belief structure — the
claim relations, contradictions, and 2-hop neighborhood around it. Nobody has
pre-tuned these tiers to situations — there is no fixed mapping from "kind of
task" to "right tier", and we genuinely don't know, for instance, how much
provenance an agent executing a set plan needs. You find out. Weigh two
things:

- **Your situation.** How much does this file's history bear on what you're
  about to do? Merely running or calling code is different from changing it;
  conceptualizing a change is different from executing one you've already
  planned; a file at the center of your task is different from one at the
  periphery. Let that judgment — not a habit — pick the tier.
- **Your experience.** Notice what the blocks have actually been doing for
  you on this codebase lately. If they've been insightful — saving you from
  re-deriving things, flagging collisions — spend more freely. If they've
  been chatty, redundant, or distracting, dial down and pull detail on demand
  with `provenance(...)` instead. Your experience is data the system's tuning
  doesn't have; use it.

Re-examine the choice when your situation changes, and don't let it fossilize
into a constant — if you notice you've typed the same tier twenty times
without thinking, that's the signal to think.

Whatever the tier, two lines demand action, not skimming: a **⚠ contradiction**
(reconcile it or relate the claims before building on either) and a
**concurrent-session line** (someone else has uncommitted edits here — check
before you collide). Pass `recallKeywords` when you want what we know about a
_topic_ while reading a file about something else.

**Read the block as a launchpad, not a verdict.** It is intentionally partial —
top-ranked items plus a `K of M` count of what was withheld. Chase a thread
(the pre-written `provenance(...)` call, or your own `gad.query`) when a line
flags something live — a ⚠ contradiction, a hub, a claim you cannot reconcile —
or the count says the detail you need is in the tail. Do not reflexively
expand every read.

**Commit time is memory time.** Your commit message is recalled verbatim by
future sessions touching these files — write the one-line insight they should
see, not a changelog. When the work taught you something durable — an
invariant, an ownership boundary, a gotcha, a decision and its reason — put it
in `claims:` on the commit; it costs nothing extra at the moment you are
already summarizing. Use standalone `record_claim`/`relate_claims` when
insight lands mid-task and won't keep until commit. If dedup shows a
near-duplicate, revise or relate instead of recording a second copy —
fragmented memory is weaker than one claim that accretes.

**Trust but verify.** Provenance is recalled, not generated — a claim is a past
judgement with a handle. If it matters, follow the handle to the trajectory,
commit, or edit that produced it.

**Take a degrade gracefully.** A `provenance("path")` hint instead of a block
is the system protecting your latency — call it if the file matters, ignore it
if not.
