# GAD Provenance Graph — Design Spec

Status: proposal, v2 (reformulated 2026-07 after the per-repo VCS rework landed).
Pre-release; **no backward compatibility** — schema is reset on bump
(`GadWorkspaceDO.dropPersistenceTables`), so we add/rename freely.

**Durability boundary.** Resetting on bump is free for the _runtime_ projections,
but memory which wipes on every bump is not long-term memory. This spec keeps
claims and touch signals on the reset-on-bump substrate _deliberately_: within a
schema era they are durable working memory; across a bump they are gone. That is
acceptable only while pre-release. Graduating the knowledge ledger to survive
schema change — a durable sub-ledger or real migrations — is a **precondition for
calling the memory pillar "real," not a later nicety.** V1 builds the loop; it
does not yet claim cross-era persistence, and the prompt (§13) must not promise
the agent more permanence than the substrate delivers.

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
   `harness/src/tools/edit.ts:131`, `write.ts:47`), and turn **by join**
   (`edit_ops.invocation_id → trajectory_invocations.turn_id`, the single
   source of truth — `editsByTurn`). "Which invocation/turn produced this edit"
   no longer needs new infrastructure.
2. **Edits are working rows until committed.** `vcs.edit` records uncommitted
   ops (`committed_event_id IS NULL`, no log event, no state mint); `vcs.commit`
   folds them into a messaged snapshot by **re-keying the same rows** (never
   re-inserting — provenance columns survive commit); `vcs.push` is the only
   main-advance (fast-forward-only, build-gated). Commit messages are
   **mandatory** — a new, free semantic signal v1 never had.
3. **Per-repo logs.** Every repo has its own log `vcs:repo:<path>` with heads
   `main` / `ctx:<contextId>`; the workspace view is a composition
   (`composeRepoStates`) over a durable context base pin (`vcs_context_bases`).
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

## 1. Goals

1. **Blame that works in production** — for any file/line/head, recover which
   edit changed it, in which commit, by which invocation/turn/actor — including
   the uncommitted working tail.
2. **Read-time provenance attachment** — on each read, attach a compact summary
   at the agent-requested depth, ranked by relevance to the current session.
   Deeper exploration is on-demand.
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
  `toolCallId` from the agent tools), `edit_seq`/`ordinal` (replay order),
  `committed_event_id`/`committed_seq`/`output_state_hash` (NULL while working;
  stamped by `commitRepo`'s re-key on commit). Indexes exist for path-in-lineage
  order, actor, turn, and invocation lookups.
- **Turn is derived, never stored on the edit**: `invocation_id →
  trajectory_invocations(turn_id, log_id, head)`. This also yields the edit's
  **session** (trajectory branch) — no session column needed on edit ops.
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
- **File reads are recorded nowhere.** The dead `gad_file_observations` /
  `gad_file_mutations` / `gad_file_change_hunks` projections, their
  `state.file_*` event kinds, and `blameGadFileSnippet` are deleted (schema
  v22). Reads get a soft signal (§4), not a log event.

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

| kind       | src → dst          | base weight | written by                                   |
| ---------- | ------------------ | ----------- | -------------------------------------------- |
| `observed` | invocation → file  | 0.5         | the agent read tool (every read, any tier)   |
| `cited`    | invocation → claim | 0.7         | drill-down on a claim; claim-id args in tools |

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
  src_kind TEXT NOT NULL,          -- invocation
  src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL,          -- file | claim
  dst_id TEXT NOT NULL,
  session_log_id TEXT,             -- denormalized hint: trajectory branch at creation
  session_head TEXT,               --   (not authority — §6.4)
  turn_seq INTEGER,                -- creating turn's ordinal in its branch (turn-decay)
  hits INTEGER NOT NULL DEFAULT 1, -- coalesced repeat count
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_touches_dst ON gad_touches(dst_kind, dst_id, id);
CREATE INDEX idx_touches_session ON gad_touches(session_log_id, session_head, id);
-- One counted row per edge identity per session: repeats bump hits/turn_seq.
CREATE UNIQUE INDEX idx_touches_coalesce
  ON gad_touches(kind, src_kind, src_id, dst_kind, dst_id, session_log_id, session_head);
```

Density reads a soft edge as its kind weight scaled by a _sublinear_ function
of `hits` (default `sqrt`, a tuning knob §12) — bounded accumulation — while
native repeats compound by adding rows (distinct edits/assertions).

Pruning: the periodic server-driven pass (same shape as `runGadGcMark/Sweep`)
ages out soft rows below a relevance floor. Because degree is computed at query
time in V1 (§6.5), there is no degree counter to keep in sync on removal — the
v1 "symmetry rule" footgun is gone by construction.

## 5. Blame, on `fileHistory`

The row set is already served: `fileHistory(repoPath, path, head)` = the path's
committed ops in commit-lineage order (event-keyed ancestry, not global seq)
plus the uncommitted working tail. Joining `invocation_id →
trajectory_invocations` yields turn/session; `committed_event_id` yields the
commit and its mandatory message.

**Line-level blame is an interval problem in offset space.** Hunk ranges are
recorded against _their own base_ — a hunk that replaced offsets 400–580 no
longer lives there once an earlier-in-file edit shifts the tail. "Who last
changed line N at head H" is therefore **not** "the newest op whose recorded
range contains N's offset". The composition `git blame` does must be done here,
in a `blameLines(repoPath, path, lineRange, head)` helper — not inline SQL:

1. **Materialize** the file at H (the read already has the bytes) and map the
   query lines to character offsets.
2. **Walk `fileHistory` newest→oldest** (working tail first), carrying each
   query offset back through every later op's delta: a replace hunk shifts
   offsets after it by `newText.length − (end − start)`. To test op _k_, map
   the offset back through ops _k+1…latest_ into _k_'s post-state coordinates,
   then check containment in `[start, start + newText.length)`. The first
   containing op wins; its `invocation_id`/`committed_event_id` is the answer.
3. **Barriers.** An op with `hunks_json IS NULL` (create, binary write,
   no-diff) is a coordinate barrier: every line is "changed by" it unless an
   on-demand `old_content_hash → new_content_hash` content diff proves a line
   passed through. Text writes don't hit this — they carry computed hunks.

Bounded per-file computation at query time — O(ops on this path), not stored
state. Non-agent ops blame to actor + commit with no producing turn.

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

**Degree is computed at query time in V1**, as capped indexed
`COUNT`s over `idx_edit_ops_path` / `idx_touches_dst` / claim-relation indexes
— candidates number ≤ `N·M`, each count is an index-range scan, and there is no
incremental counter to drift (v1's `gad_node_degree` + prune-symmetry rule are
deleted from the design). If profiling on real logs shows the counts biting, a
`gad_node_degree` materialization by the periodic pass is the named lever — an
optimization, not a correctness mechanism. The same periodic pass is the
escape hatch for richer-than-2-hop affinity if 2-hop proves insufficient.

## 7. Read-time attachment: agent-budgeted, parallel, best-effort, warmed

Carried from v1 with two new signal lines (commit messages, working-edit
status). Restated compactly; v1's rationale holds.

### 7.1 The mandatory tier and the item budget

`read` takes one **mandatory** argument plus one optional steer:

- `provenance: "none" | "moderate" | "deep"` — the coarse budget for _this_
  read: which layers run, and the default **item budget** (items, not tokens —
  each item is one bounded `insight + handle` line). Mandatory on purpose: a
  deliberate per-file judgement, biased _toward_ spending (`moderate` is the
  normal choice; the failure mode to police is under-asking, not overspend).
  The runtime still enforces hard ceilings (`PROV_BUDGET_MS`, per-tier caps),
  so "always deep" cannot blow up compute.
- `recallKeywords: string[]` (optional) — steers the similarity leg beyond the
  file's own text.

| tier       | does                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `none`     | file content only — no queries                                                             |
| `moderate` | blame (last-commit line + working-edit line) + FTS recall + 1-hop density re-rank          |
| `deep`     | `moderate` + full 2-hop density + claim-relation walk (`supports`/`contradicts`/`refines`) |

The low-ranked tail is **withheld but advertised**: every truncated section
reports `K of M` and the exact call to fetch the rest. Under-budget is
recoverable, so the low default budget is safe.

**Drill-down contract.** `provenance(target, after?)` — the tool, also
reachable via eval (`gad.provenanceForFile({ path, head, tier, after })`) —
returns `{ items, shown, total, nextCursor }`: unbounded paging on top of the
cheap first page; deepen one item (`provenance("claim#42")`) or page a file.

**Every read leaves a trace**: one coalesced `observed` touch, regardless of
tier. The tier is the agent's budget dial, not a graph signal.

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
sits outside integrity/replay. Do not paper over this — it is why the soft tier
is soft. The rendered block is ephemeral and never persisted.

### 7.5 Attachment format

Fuses three layers, cheapest-to-richest, **never generating prose on the hot
path** — semantics are recalled (claims, commit messages), not synthesized:

1. **Structural skeleton + handles** — edit recency, committing sessions,
   co-edited files; short handles (`claim#42`, `commit:9f2e`, `file:retry.ts`)
   as the query surface for follow-ons.
2. **Derived structural signals** — hub-ness, coupling, churn, staleness,
   contradiction flags, **uncommitted-working status** ("2 uncommitted edits
   from this context"). Deterministic, high value-per-token.
3. **Recalled semantics** — claims and **commit messages** surfaced by the
   similarity leg, ordered by density, verbatim: a past agent's
   already-distilled, provenance-anchored judgement at zero generation cost.

`moderate` example:

```
prov · src/foo.ts (edited 3 turns ago · 2 sessions · couples with retry.ts) · 5 of 19 items
● last commit c:9f2e "clamp the retry budget before dispatch" · 2 turns ago
● 2 uncommitted edits on this context (yours, this session)
● claim#42 "foo owns the retry budget" ·supports #7· 4 sessions touched it [●●●●○]
● ⚠ contradicts claim#7 "retries are caller-controlled" → provenance(claim#42)
● co-edited with src/retry.ts ×3 of last 5 commits [●●○○○]
  +14 more (8 claims · 4 commits · 2 files) → provenance("src/foo.ts")
```

`deep` expands the claim-relation graph and the 2-hop neighborhood. The block
degrades gracefully to structure early (sparse claims) and bootstraps toward
semantics as memory accrues.

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

## 10. Upstream tweaks required (small, surgical)

The rework was built for exactly our direction, but three seams need touching:

- **T1 — commit causality.** The `vcs.commit` service handler passes neither
  `invocationId` nor `turnId`, so the commit _event_ is attributable only
  through its ops. Thread the committing tool-call id through `commit` →
  `commitRepo` → the ingest's `causality_json`, same self-asserted pattern as
  `vcs.edit`. (Ops keep their own invocations through the re-key; this is about
  blaming the commit itself, e.g. for merge/empty commits.)
- **T2 — keep invocation stamping mechanical.** `edit.ts`/`write.ts` pass
  `toolCallId` by hand today. Move the stamp into the shared tool-executor
  wrapper so a future tool cannot forget it — mechanism over discipline.
- **T3 — index commit messages into `gad_memory_fts`** (`kind='commit'`,
  anchored to the commit event id) at commit-projection time, so the mandatory
  messages join the recall leg. They are the cheapest high-quality semantic
  signal in the system.

Explicitly **not** tweaked: `invocation_id` stays self-asserted (the DO cannot
verify a tool-call id; pre-release this is fine and T2 makes it mechanical);
the fs-bridge stays actor-only (honest degradation).

## 11. Phased plan

1. **Blame** — T1 + T2; `blameLines` (§5); `provenance_for_file` view; surface
   last-commit + working-edit lines through the read tool (a degenerate
   `moderate` with no recall/density yet). _Much smaller than v1's phase 1 —
   the keystone landed upstream._
2. **Claims + touches** — `record_claim` (FTS dedup-on-write) / `relate_claims`
   / `revise_claim` / `retract_claim`; `gad_claim_relations`;
   `knowledge.claims_related` kind; `gad_touches` + the read tool's `observed`
   upsert; T3 (commit-message FTS).

   **Value gate before phase 3.** Phases 1–2 already deliver the
   differentiators — blame that works, claims that return on recall, commit
   messages in recall. Confirm that is visibly useful on real trajectories
   before building the density engine, whose every knob (§12) can only be tuned
   on logs that do not exist yet. The honest baseline to beat is **FTS recall +
   working blame**; treat phase 3 as a bake-off against that baseline, not a
   foregone build.

3. **Recall + density attachment** — `provenanceForFile` (§6 pipeline over the
   views, query-time degree, capped 2-hop); the mandatory ternary `provenance`
   read arg + `recallKeywords`; parallel best-effort attachment (§7.2–7.5);
   `provenance()` tool + paging; prompt guidance (§13).
4. **Speculative warm** — `gad_provenance_cache`; warm on `turn.opened` and
   during generation; degrade-to-hint on miss.
5. **Tune** — decay λ, caps `K`/`M`/`N`, kind weights, `w_sim`/`w_prov`,
   `observed`/`cited` weights and the `hits` curve, density buckets,
   `PROV_BUDGET_MS`, warm-set heuristic; materialize degree/affinity only if
   profiling demands.

## 12. Resolved decisions & remaining knobs

Resolved (locked for the build):

- **No physical unified fiber table.** Native edges live in their source
  tables and are read through views; exactly one physical soft table
  (`gad_touches`) for behavioral signal. No dual-writes anywhere.
- **Anchors:** commits are identified by **event id**, never state hash.
- **Blame:** built on `fileHistory` (event-keyed ancestry order + working
  tail); line blame = offset-space composition in `blameLines`; barriers only
  at hunk-less ops.
- **Decay:** logical, two clocks (turns-ago; per-anchor ordinality); never the
  query-time wall clock; never global `log_events.seq`.
- **Weighting:** flat per-kind; `idf`/`norm` discriminate; magnitude never an
  input.
- **Degree:** query-time capped counts in V1; materialization is a named
  optimization lever, not a correctness mechanism.
- **Session identity:** trajectory-DAG position; `gad_touches.session_*` is a
  hint; forks fall back to branch-chain scoping.
- **Attachment:** mandatory ternary tier biased toward `moderate`; item-based
  budgets; withheld-but-advertised tails (`K of M` + paging); parallel with the
  fs read on a standalone `PROV_BUDGET_MS`; warmed; `observed` records only
  what was actually read.
- **Determinism:** native graph is mechanism-derived and integrity-covered;
  the soft layer is explicitly non-deterministic and outside integrity/replay.
- **No `included`, no `probed`, no self-reinforcement from showing.**
- **Turn is derived** (invocation → trajectory join), never stored on edges.

Remaining knobs (set defaults now, tune on real logs): λ and `K`/`M`/`N`; kind
weights and `w_sim`/`w_prov`; the `hits` curve (default `sqrt`); whether the
historical leg decays at all or `idf` alone discriminates (default: mild decay
and `idf`); `PROV_BUDGET_MS`; warm-set selection; per-tier item budgets. Watch
the tier distribution — if it collapses to `none`, fix the prompt, never add a
silent default. Scope is the agent read tool only, never the fs RPC or
panel/programmatic reads.

## 13. Prompting the agent

The machinery pays off only if the agent wields the budget, the block, and the
follow-ons well. Concrete guidance, phrased to the agent roughly as:

**Triage every read.** `provenance` (`none` | `moderate` | `deep`) is mandatory
and is your whole context budget for the read — a one-second judgement. **When
in doubt, pick `moderate` — under-reading context costs you more than a few
tokens of provenance.** `none` only for files you know cold; `deep` before you
change a file with non-obvious ramifications or need the belief structure
around it. Pass `recallKeywords` to steer recall beyond the file's own text.

**Read the block as a launchpad, not a verdict.** It is intentionally partial —
top-ranked items plus a `K of M` count of what was withheld. Chase a thread
(the pre-written `provenance(...)` call, or your own `gad.query`) only when a
line flags something live — a ⚠ contradiction, a hub, a claim you cannot
reconcile — or the count says the detail you need is in the tail.

**Record what you learn as claims, and write commit messages as memory.** When
you establish something durable — an invariant, an ownership boundary, a gotcha,
a decision and its reason — `record_claim` it and `relate_claims` it. Your
commit messages are recalled the same way: write them as the one-line insight a
future session should see when it touches these files, not as a changelog. If
`record_claim` shows a near-duplicate, revise or relate instead of recording a
second copy — fragmented memory is weaker than one claim that accretes.

**Trust but verify.** Provenance is recalled, not generated — a claim is a past
judgement with a handle. If it matters, follow the handle to the trajectory,
commit, or edit that produced it.

**Take a degrade gracefully.** A `provenance("path")` hint instead of a block
is the system protecting your latency — call it if the file matters, ignore it
if not.
