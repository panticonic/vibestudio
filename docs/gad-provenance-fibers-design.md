# GAD Provenance Fibers — Design Spec

Status: proposal for review. Pre-release; **no backward compatibility** — schema
is reset on bump (`GadWorkspaceDO.dropPersistenceTables`), so we add/rename
freely.

This spec turns GAD's existing ledger kernel into a single, queryable
**provenance graph** that joins the worktree VCS, the agent trajectory, and a
hermeneutic claim model — and feeds the agent a compact, semantically ranked
provenance summary at read time. It is the concrete plan behind the June 2026
GAD review (`docs/gad-system-review-2026-06.md`).

## 1. Goals

1. **Blame that works in production** — for any file/state, recover which edit
   changed which lines, in which trajectory, by which invocation/turn.
2. **Read-time provenance attachment** — on first read of a file in a session,
   attach a compact, *semantic* summary (claims first, then sessions/files),
   ranked by relevance to the current session. Deeper exploration is on-demand.
3. **Session-density ranking** — rank attached provenance by the density of
   "relationship fibers" connecting the current session to each candidate, and
   improve that ranking as the session accumulates context.
4. **Self-reinforcing provenance** — the act of querying/including context is
   itself recorded as a fiber, so co-accessed nodes wire together over time.
5. **Hermeneutic memory** — a simple claims-as-nodes + relations model the agent
   uses as working memory, fiber-linked to the trajectories that touch it.
6. **SQL-first** — expose the graph as clean tables/views and prompt the agent
   to chase provenance with its own SQL, judiciously. Do not over-wrap.

## 2. Ground truth this builds on

- The worktree side of blame is already live: every `vcs.applyEdits` writes
  `gad_worktree_edit_ops` rows with `path`, `old_content_hash`,
  `new_content_hash`, `hunks_json` (exact line ranges for `replace`),
  `output_state_hash`, and the producing `event_id`
  (`workspace/workers/gad-store/index.ts:3491-3508`;
  `src/server/gadVcs/workspaceVcs.ts:1450-1455`).
- The normalized `gad_file_mutations` / `gad_file_change_hunks` tables and
  `blameGadFileSnippet` are **dead** — only populated by `state.file_mutation_applied`
  events that no live path emits. They are deleted by this spec.
- The worktree state graph lives on a dedicated log (`VCS_LOG_ID`) with per-context
  heads (`ctx:{id}`, `main`) — `src/server/gadVcs/store.ts:506` — *separate* from
  the agent trajectory log. The link is `contextId`.
- `applyEdits` does **not** thread the editing invocation/turn into the state
  event, so `gad_state_transitions.invocation_id` is null on the live path. This
  is the keystone gap.
- `knowledge.claim_*` events and `projectKnowledge` already exist
  (`index.ts:2650`) but have **no producer**. We add producers.
- File reads are **not recorded** anywhere today. We add read fibers.

## 3. The fiber abstraction

A **fiber** is a typed, directed, timestamped, weighted edge in one provenance
graph. Nodes are anchors, reusing the existing `anchor_kind`/`anchor_id`
convention:

| anchor_kind | anchor_id |
| --- | --- |
| `file` | normalized path |
| `state` | worktree state hash |
| `invocation` | invocation id |
| `turn` | turn id |
| `session` | trajectory branch / head id |
| `claim` | claim id |

Fiber kinds:

| kind | src → dst | written by |
| --- | --- | --- |
| `edited` | invocation → file | edit-op ingestion (keystone wire) |
| `observed` | invocation → file | read tool |
| `asserted` | invocation → claim | `record_claim` / `revise_claim` |
| `cited` | invocation → claim | claim referenced during a turn |
| `included` | invocation → claim \| file \| session | read-time attachment + provenance tool |
| `supports` / `contradicts` / `about` / `refines` / `depends_on` | claim → claim | `relate_claims` |

`included` is the self-reinforcing fiber: emitting a provenance attachment writes
`included` fibers from the current invocation to whatever was shown, so showing a
node strengthens its future density.

### Schema

```sql
CREATE TABLE gad_fibers (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,          -- log event that asserted the fiber (replay/audit)
  kind TEXT NOT NULL,
  src_kind TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  session_id TEXT,                 -- branch/trajectory that created the fiber
  invocation_id TEXT,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_fibers_src ON gad_fibers(src_kind, src_id);
CREATE INDEX idx_fibers_dst ON gad_fibers(dst_kind, dst_id);
CREATE INDEX idx_fibers_kind ON gad_fibers(kind);
CREATE INDEX idx_fibers_session ON gad_fibers(session_id);
```

Fibers are a projection of fiber-events on the existing log kernel (append a log
event, project a `gad_fibers` row). They are replayable like every other
projection. They are **not** separate authority from the log.

## 4. Keystone: persist the edit → trajectory causal edge

The single highest-leverage change. Thread causality from the agent tool down to
the state event:

1. `vcs.applyEdits` accepts an optional `causality: { trajectoryId, invocationId,
   turnId }` (the edit/write tools already run inside an invocation; pass it
   through — `harness/src/tools/edit.ts`, `write.ts`, `tool-vcs.ts`).
2. `WorkspaceVcs.applyEdits` → `ingestWorktreeState` stamps the state event's
   `causality_json` with that invocation/turn.
3. `projectStateTransition` reads `envelope.causality.invocationId` (it already
   does — `index.ts:2546`) so `gad_state_transitions.invocation_id` is populated.
4. Edit-op ingestion additionally emits an `edited` fiber per changed path:
   `invocation:{id} --edited--> file:{path}` (weight may scale with hunk size),
   carrying `session_id` and `output_state_hash` for joins.

After this, "which conversation/turn/invocation produced this hunk" is a direct
join, and blame is real.

## 5. Blame, rebuilt over edit_ops

Delete `gad_file_mutations`, `gad_file_change_hunks`, and `blameGadFileSnippet`.
Provide blame as a view/query over `gad_worktree_edit_ops` joined to the log and
fibers. Sketch — "who last changed these lines of this file at this state":

```sql
-- file history at/under a state: every edit op touching the path, newest first,
-- joined to the producing trajectory event + invocation.
SELECT eo.path, eo.hunks_json, eo.old_content_hash, eo.new_content_hash,
       eo.output_state_hash, le.event_id, le.causality_json,
       st.invocation_id
FROM gad_worktree_edit_ops eo
JOIN log_events le ON le.envelope_id = eo.event_id
LEFT JOIN gad_state_transitions st ON st.event_id = eo.event_id
WHERE eo.path = ?
ORDER BY le.seq DESC;
```

Line-level blame walks `hunks_json` ranges to find the newest op overlapping the
requested lines; whole-file `write` ops (no hunks) fall back to old/new content
hash diff on demand. This is a query concern, not stored state.

## 6. Session-density ranking

**Density** = personalized spreading activation seeded from the current session's
**touch-set**, restricted to ~2 hops, with recency decay.

- `touch(S)` = anchors the session has touched = `dst` (and `src`) of fibers with
  `session_id = S` (files observed/edited, claims asserted/cited/included,
  invocations). It grows as the turn proceeds, which is why ranking improves.
- For a read of file `F`, candidate nodes are claims/sessions/files reachable
  from `F`'s editing sessions:
  1. editing sessions of `F`: `... --edited--> file:F` → their `session_id`s.
  2. claims those sessions touched: `invocation(in those sessions) --asserted|cited--> claim`.
  3. co-edited files: files those sessions also `edited`.
- Score a candidate `C`:

```
score(C) =  Σ_{X ∈ touch(S)} w(S,X)·decay(X)  ·  Σ_{fiber X~C} w(X,C)·decay(X~C)
          +  boost · directIncludedFibers(S → C)
```

i.e. weighted count of 2-hop paths from the current session's touch-set into `C`,
plus a boost for direct prior `included` fibers (Hebbian reinforcement).
`decay` is exponential in age (turns or wall-clock). Computable with a bounded
recursive CTE seeded at `touch(S)`; cap candidates and depth so it stays cheap.

The attachment ranks by `score` desc, claims before sessions before files,
top-N capped.

## 7. Read-time attachment

**Trigger policy: first-touch + on-demand** (chosen).

- On the **first** read of a given `file:{path}` within a session, the read tool
  appends a compact provenance block to the tool result and emits `included`
  fibers `invocation:{id} --included--> {shown nodes}`.
- An explicit `provenance(path | claim | query)` tool (and raw SQL) lets the
  agent go deeper at will. Subsequent reads of the same file do **not** re-attach
  automatically.
- The system prompt instructs the agent to be judicious: rely on the first-touch
  summary, pull deeper provenance only when a change's ramifications are unclear,
  not after every read.

Attachment shape — semantic-first, compact, density-ranked, raw hunks omitted:

```
provenance · src/foo.ts (last edited 3 turns ago, 2 sessions)
  ● claim#42 "foo owns the retry budget" — supports claim#7 · 4 editing sessions touched it [●●●●○]
  ● session "rework-retries" edited L40–58 · recorded 2 claims you've touched this session [●●●○○]
  ● co-edited with src/retry.ts in 3 of last 5 edits [●●○○○]
```

The density meter is a coarse bucketing of `score`. Emitting this writes the
`included` fibers, closing the reinforcement loop.

## 8. Hermeneutic claims

A claim is a node that can stand as an **entity**, a **predicate**, or a full
**statement**; a relations table connects them. Keep the existing `gad_claims`
columns; make subject/object nullable and add `claim_kind`.

```sql
ALTER ... gad_claims ADD claim_kind TEXT;  -- 'entity' | 'predicate' | 'statement'
-- (clean reset; just add to the CREATE TABLE)

CREATE TABLE gad_claim_relations (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  src_claim_id TEXT NOT NULL,
  relation TEXT NOT NULL,          -- supports | contradicts | about | refines | depends_on
  dst_claim_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claim_rel_src ON gad_claim_relations(src_claim_id);
CREATE INDEX idx_claim_rel_dst ON gad_claim_relations(dst_claim_id);
```

This fills the never-built `gad_claim_edges` slot. Claim↔trajectory links are
fibers (`asserted` / `cited` / `included`), not columns.

Agent tools (thin emitters of the already-projected `knowledge.claim_*` events
plus `gad_claim_relations`):

- `record_claim({ text | subject,predicate,object, kind })`
- `relate_claims({ src, relation, dst })`
- `revise_claim` / `retract_claim`

`record_claim`/`cite` also emit `asserted`/`cited` fibers from the current
invocation. The prompt frames this as the agent's durable working memory:
record what you learn, relate it, and it comes back through density-ranked
provenance later.

## 9. SQL-first surface

Ship tables + a few views, not a thick API:

- `provenance_for_file(path)` — view joining edit ops + trajectory + fibers.
- `fiber_graph` — flat fiber view for ad-hoc traversal.
- `claim_graph` — claims + relations + touching sessions.
- one density helper (parameterized by session + seed node) — the only piece
  that benefits from being a function rather than hand-written SQL.

Everything else the agent reaches via `gad.query` (read-only CTEs already
allowed). Prompt the agent that it can traverse provenance to arbitrary depth
with SQL when a goal warrants it.

## 10. What gets deleted

- `gad_file_mutations`, `gad_file_change_hunks` tables and their projection
  branch (`projectStateTransition`'s `mutationPath` block).
- `blameGadFileSnippet` (replaced by edit-op blame view).
- `gad_file_observations` as currently shaped is folded into `observed` fibers
  (keep a thin observation projection only if reads need extra columns).

## 11. Phased plan (implementation order, post-approval)

1. **Keystone + blame** — causality through `applyEdits`; `edited` fibers;
   `gad_fibers` table + projection; edit-op blame view; delete dead tables/API.
2. **Read observation + claims** — `observed` fibers from the read tool;
   `record_claim`/`relate_claims`/`revise_claim` tools; `gad_claim_relations`.
3. **Density + attachment** — density helper; first-touch read-time attachment;
   `included` fibers; `provenance()` tool; prompt guidance.
4. **Tune** — decay constants, candidate caps, density buckets; verify cost on
   realistic logs.

## 12. Open questions

- Decay basis: turns vs. wall-clock (lean turns; deterministic and replayable).
- Fiber weight for `edited`: flat vs. scaled by hunk size/line count.
- Whether `session` should be the branch head or a coarser conversation id when
  branches fork mid-session.
- Cost ceiling for the density CTE on large logs; may need a materialized
  per-session touch-set cache.
