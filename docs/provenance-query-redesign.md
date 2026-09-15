# Provenance as abduction: the semantic-VCS query redesign

**Status:** proposed, 2026-08-14; revised same day, twice — first after
adversarial review (authorization model for the query surface, honest
scan budgets, one-resolver preservation, identifier hygiene), then by a
simplification pass that removed the charter/contest apparatus (latent
axioms are guesses; conclusions are ordinary files — §2.5), cut the
walk vocabulary to three, and deferred `connect` behind eval evidence
**Builds on:** [Net-effect merge](net-effect-merge-plan.md) (landed),
[Intent-aware provenance rendering](intent-provenance-follow-up.md)
(landed: one resolver, read-memory contract, tier-carrying blame/history)
**Scope:** the agent-facing query surface over the semantic graph — walks,
a relational view contract, search, batch inspection, rendering economics,
rejection evidence — plus the evals that keep it honest.
**Explicitly out of scope:** the storage model. The normalized immediate-edge
schema, work-unit/change/decision vocabulary, intent ladder, and store-once
laws are correct and unchanged. This plan is about how agents *ask*.

## 0. The problem, stated precisely

The purpose of provenance in this system is not audit. It is **theory
maintenance**: an agent operating in shared tracked state must be able to
reconstruct *why things are the way they are* well enough to impute the
latent axioms behind what users asked for — and to know when those axioms
are relevant to the work in front of it. Users prompt in consequences
("cap the backoff at 30s"); the axiom ("this deploy target kills
long-lived connections") is rarely stated. Good agents abduce it from
evidence. The provenance system's job is to make that evidence cheap to
reach and honest when reached.

The right mental model — and the one this plan is built around — is
heuristic search:

- the **database is the graph**: the normalized semantic tables plus the
  mirrored trajectory tables already form one well-typed relation set in
  a single SQLite store, joinable in one place;
- the **agent's context window is the agenda**: what it holds are open
  questions and partial theories, each costing token rent for the rest of
  the session;
- a **tool call is the expansion operator**: it spends one round trip and
  some rendered tokens to replace a question on the agenda with either an
  answer or better-targeted questions.

The design question is then: *what is the right granularity of the
expansion operator?* Today's answer — one node plus one page of five
adjacent edges per call — is the wrong granularity for almost every
question agents actually ask. It optimizes per-call bytes while
pessimizing per-question cost, which is the only cost that matters.

### 0.1 The questions agents actually ask

Observed and anticipated, the provenance questions reduce to seven
canonical shapes. Everything below is designed against them:

- **Q1 — why do these bytes exist?** (highest frequency; already answered
  well by the read-memory attachment; unchanged here)
- **Q2 — what was actually being attempted?** From any artifact, up the
  causal chain to the originating human statement: applied change → work
  unit → command → invocation → turn → trigger message(s). The abduction
  workhorse.
- **Q3 — what else happened under that intent?** The cohort: everything
  the same work unit / command / turn / task touched. Axioms are imputed
  from *patterns across a cohort*, not from single edits.
- **Q4 — how are these two things related?** A bounded typed path between
  two subjects (this file and that decision; this line and that
  conversation).
- **Q5 — what has this coordinate been *for*, over time?** Purpose drift;
  partially served today by intent-annotated history.
- **Q6 — what was tried and rejected here?** Counteractions, reverts,
  superseded external deltas, `ours`-resolved merge coordinates. Negative
  evidence — the user saying *no* — is the strongest axiom evidence the
  system holds, and today it is the hardest to reach.
- **Q7 — which subjects match a description?** Entry by content ("where
  did anyone state anything about retries?") rather than by identity.
  Today there is no entry point at all: you cannot walk to a node you
  cannot name.

### 0.2 The cost model

One question's cost = (number of tool calls × round-trip latency) +
(rendered tokens × the remaining length of the session, since every
rendered line pays rent in the agenda for the rest of the context).
Two consequences:

1. **Depth must not cost calls.** Q2 is a chain of 5–8 hops with
   branching factor ≈ 1 along the spine. Paying one call and one page
   render per hop is pure waste: ~6 round trips and ~6 rendered pages,
   of which perhaps 15 lines were ever wanted.
2. **Unfollowed edges are the dominant token waste.** A page of five
   edges from which one is followed renders four lines of rent-paying
   noise. The fix is not smaller pages — it is rendering *spines and
   answers*, not frontiers.

Targets, normative for this plan: each canonical question above is
answerable in **≤ 2 tool calls** and **≤ ~1,500 rendered tokens** in the
common case, from a cold start (no prior refs in context). The eval
harness (§5) measures exactly this.

## 1. Assessment of the current system

What is right and must be preserved:

- **The substrate is exactly what the vision calls for.** One SQLite
  store, normalized immediate edges, no stored transitive closures, the
  trajectory mirror (`trajectory_invocations/turns/messages`) in the same
  database as the semantic tables, joined by exact cause linkage in the
  command journal. The graph *is* a relational database already.
- **The intent ladder** (`stated | trigger | mechanical`, tiers never
  laundered, capture-time evidence surviving context teardown) is the
  honest epistemic core. Nothing here touches it.
- **Read-memory** answers Q1 at the decision boundary with a bounded,
  salience-ordered, budget-controlled attachment. It is the model for
  what a good surface looks like: rich projection, small default render.
- **Compact refs** (`@r…`) keep 70-char content-addressed identities out
  of the model's mouth while trusted code retains exact roots.

Where it falls short of the problem:

- **F1 — the expansion operator is one hop.** `provenance` returns one
  node summary plus ≤ 20 adjacent edges. Q2 costs 5–8 calls; Q3 costs a
  fan-out of calls; Q4 is effectively unanswerable (bidirectional search
  by hand, page by page); Q6 requires knowing the schema-level trick
  (walk `counteracts` backwards) that nothing surfaces.
- **F2 — there is no set-oriented access at all.** The store is
  relational; the surface is a pointer walk. "All work units touching
  this repository in the last 20 events with tier `stated`" is one SQL
  statement against existing indexes and is currently expressible only
  as an unbounded interactive crawl. The provenance-tuning skill
  currently *bans* a raw SQL route outright — the right instinct
  (protect the canonical tables, keep authorization server-side) drawing
  the wrong boundary (no relational access at all). §2.2 revises this.
- **F3 — no entry by content (Q7).** Every entry point is an identity or
  a path. There is no way to *find* the decision, intent, or message you
  suspect exists. Intent text, rationales, commit messages, and trigger
  excerpts are stored but not searchable.
- **F4 — rendering pays rent on the wrong lines.** Frontier pages render
  edges-that-won't-be-followed; continuation refs render as full
  `provenance({"target":"@r…"})` call syntax repeated per line; node
  summaries inline `command <70-char-id>` strings the agent must not
  even use. The economics are inverted: mechanics are cheap to render
  and intents expensive, when the reader wants the opposite.
- **F5 — negative evidence is buried (Q6).** Counteraction edges,
  revert work units, superseded deltas, and `ours` merge resolutions
  exist as first-class rows but no surface collects "what was rejected
  at this coordinate and why". For theory update, a rejection is worth
  ten confirmations.
- **F6 — the trajectory side is a second-class citizen.** The chain ends
  at `trajectory-message` nodes with truncated text and blobstore
  digests, but turns/messages are only reachable by walking node-by-node
  from an invocation. The originating *human* statement — the terminal
  of every Q2 — is several unguided hops from where every walk starts.

The one-page-per-call design is not a mistake to be ashamed of — it is
the correct *safety* posture (bounded, exact, authorized, cursor-stable)
attached to the wrong *ergonomic* unit. The redesign keeps the posture
and changes the unit.

## 2. Design

Four surfaces, one substrate. Everything below compiles to SQL over the
existing tables inside the workspace-source DO; nothing adds storage
beyond one FTS index and the persisted resolved-intent columns
(§2.2.1).

### 2.1 Named walks: the expansion operator sized to the question

`provenance` gains a `walk` parameter — a small closed vocabulary of
curated multi-hop traversals, each compiled to bounded recursive SQL
server-side and rendered as a **spine**, not a frontier:

- `walk: "cause"` (from any subject) — the Q2 chain: applied change →
  work unit → command → invocation → turn → trigger message, continuing
  through message `sourceMessageId` links until it reaches a human-role
  message or a boundary (subagent spawn brief, external delta
  declaration, import snapshot). Renders as one indented causal
  narrative, intent-first: each level's resolved `{tier, text}` leads,
  mechanics trail. Boundaries render as what they are ("assignment from
  parent task …", "declared external delta …") — the walk never
  fabricates continuity across an evidence boundary.
- `walk: "cohort"` — the Q3 neighborhood: from a subject, up to its
  work unit / command / turn (caller chooses the level with
  `scope: "work-unit" | "command" | "turn"`, default `command`), then
  *down* to everything else that scope touched: sibling changes grouped
  by file coordinate, decisions, commits. Rendered as a grouped manifest
  ("under this command: 4 files, 9 changes, 1 decision"), one line per
  coordinate.
- `walk: "rejections"` — the Q6 surface: for a file or coordinate range,
  every counteracted change (with the counteracting work unit's resolved
  intent — *why it was undone*), revert work units, superseded external
  deltas, and merge entries resolved `ours`/`current` against this
  coordinate, newest first. This is the theory-update view: each entry
  is "someone tried X; it was rejected because Y (tier-labeled)".
That is the whole vocabulary: **three walks**, each with an
unambiguous compilation to bounded SQL and a question it demonstrably
answers. Candidates an earlier draft included and this one defers, with
the evidence that would revive each:

- *drift* (Q5): the landed intent-annotated history (intent follow-up
  §2.4) already answers it in one `history` call plus interpretation;
  a dedicated walk is warranted only if the Q5 eval shows agents
  failing to compose that;
- *arrival*: read-memory already renders arrival context inline, and
  its decision ref is a valid `cause` target — the composition is two
  taught moves, not a missing operator;
- *connect* (Q4): a bounded bidirectional typed-path search is real
  engineering (frontier caps, path ranking, refusal semantics) for a
  question whose observed shape is usually "are these two things
  related *via the cause/cohort structure*" — answerable by
  cause-walking both subjects and intersecting, or by one query join
  once §2.2 lands. Build the dedicated operator only if the Q4 eval
  shows those compositions failing or chronically exceeding budget;
  its design (bounded search in trusted DO code over the
  `neighborEdges` enumeration, typed `no-path-within-bound` refusal)
  is recorded here so revival is a decision, not a redesign.

The bar is the same writer/reader test as §2.5: every walk kind is
surface area — taught, rendered, evaluated, maintained — and earns
existence by a demonstrated question, not by completeness of the
vocabulary.

**Identifier hygiene (a walk-surface law).** Agents have historically
mangled long hashes and content-addressed identities, and one mistyped
identity fails closed with a confusing refusal. Therefore, on every walk
surface: raw content-addressed IDs (`work-unit:9f3a…`, 70 chars) are
**never rendered to the model** — every subject renders as a short human
label (kind, path, tier-labeled intent excerpt) plus a compact `@ref`;
entry is only ever by friendly target (path, `session`, search hit) or
by a returned `@ref`; and the model is never asked to copy, compare, or
construct an identity. Exact typed roots live exclusively behind the
reference store, as they already do for continuations — this extends
that discipline from continuations to *all* subject rendering. The
current renderers violate this in places (`command <id>`,
`counteracts <changeId, …>`, decision ids inline in history entries);
those renderings are replaced, not grandfathered.

**One reference store, one grammar, shared with `vcs`.** Walks ride the
same `provenance` tool and the same agent-reference store
(`agent-pagination`) that `vcs` compare/blame continuations already use.
A ref returned by `vcs blame` is a valid walk target and vice versa; the
legend/footer contract (§2.4) applies to both tools; ergonomic
improvements land once and both surfaces inherit them. No second ref
syntax, no walk-only reference namespace.

Properties shared by all walks: depth and fan-out bounds are fixed
server-side per walk (they are query shapes, not policies); every
rendered node carries a compact ref; cursors exist only where a walk is
legitimately long (cohort manifests, rejection lists) and are advertised
as complete refs exactly as today; walks never cross authorization
boundaries silently — a pruned branch renders as a labeled boundary.

Single-hop `neighbors` remains, unchanged, as the fallback for questions
no walk anticipates — it becomes the *rare* move rather than the only
move.

### 2.2 The relational contract: views, not tables — but real SQL

This is the largest revision, and it implements the original vision
directly: let the agent treat the record as a database, because it is
one.

**Mechanism.** A read-only query operation:

```
provenance({ query: "SELECT … FROM prov_work_units WHERE …" })
```

executed inside the workspace-source DO against a **versioned set of SQL
views** (`prov_*`), never against canonical tables. The views are the
public contract; the tables stay private and freely refactorable —
exactly the boundary the current skill-level SQL ban was protecting,
drawn where it belongs.

**The view schema** (initial set; each ~direct over existing tables and
indexes):

- `prov_work_units(work_unit_id, kind, intent_tier, intent_text,
  author_context_id, command_id, created_at, content_class)` — intent
  columns sourced per §2.2.1, never re-derived in SQL;
- `prov_changes(change_id, work_unit_id, kind, file_id, repository_id,
  base_path, result_path, effect_digest)`;
- `prov_applied_changes(applied_change_id, application_id, change_id,
  ordinal)` and `prov_content_edges(child_applied_change_id,
  parent_applied_change_id, relation)`;
- `prov_events(event_id, kind, message, created_at)` with
  `prov_event_parents`, `prov_event_applications`;
- `prov_decisions(decision_id, work_unit_id, target_state_id, …)` with
  `prov_decision_entries(decision_id, coordinate_id, resolution,
  rationale, result_change_id)`;
- `prov_counteractions(change_id, counteracted_change_id)`;
- `prov_commands(command_id, method, status, cause_invocation_id,
  cause_log_id, created_at)`;
- `prov_invocations`, `prov_turns`, `prov_messages(message_id, turn_id,
  role, sender_kind, sender_id, text_excerpt)` — the trajectory mirror,
  with message text bounded at the view (excerpt + blobstore digest for
  full text);
- `prov_files(file_id, repository_id, path, presence)` for the current
  working state (state-pinned variants come through walks, not the query
  surface — see guardrails).

#### 2.2.1 Intent columns without a second resolver

SQL views evaluate at query time and cannot call the TypeScript
`intentForWorkUnit` loader, so a naive "view expression carries the
ladder" is a second resolver implementation — exactly the drift the
landed one-resolver law forbids. The fix: the resolved `{ tier, text }`
is **persisted onto the work-unit row at creation, computed by the one
loader**, alongside a `resolver_protocol` version column. This is legal
because the ladder is a pure deterministic function of evidence fields
that are themselves immutable once the row exists (the intent follow-up
§2.0 already made all evidence capture-time); the stored value is
derived-but-frozen input, not a cache that can go stale under it. A
resolver protocol change ships with a migration that recomputes the
columns — through the same loader — and bumps the version. This
knowingly revises the intent follow-up's "no intent table or cache"
exclusion; the alternative (a hand-maintained SQL reimplementation of
the ladder) violates the more important law. Every carrier — views,
walks, read-memory — reads the persisted columns; the loader remains
the only code that ever computes them.

#### 2.2.2 Authorization: caller-scoped execution, not magic views

Visibility today is enforced host-side per explicit reference: the host
resolves the caller's reachable context authorities and the DO answers
reachability from that context set (committed-event ancestry, working
chain, published main, integration sources — `referencesReachable`).
A static SQLite view cannot vary by caller, and an arbitrary query
supplies no references to check. So the query surface does not pretend
otherwise; it reuses the exact existing model at a different grain:

1. the host authorizes the operation and passes the caller's reachable
   `contextIds` with the query — the same input `referencesReachable`
   receives today; the DO never trusts the query for identity;
2. the executor materializes, per query, the caller's **readable basis
   set** into temp tables (`_vis_events`, `_vis_applications`): the
   event-ancestry closure of the caller's committed heads plus published
   main plus recorded integration sources, and the caller-reachable
   working chains — the same closure `referenceStateReachable` walks
   per-reference today, computed once instead of per reference;
3. `prov_` views are *defined against the temp visibility tables*:
   every state-anchored view joins through `_vis_*`; rows whose
   anchoring state is outside the basis set do not exist for this
   query. Trajectory views are scoped to the caller's own trajectory
   plus invocations causally linked from visible commands, mirroring
   `isCallerTrajectoryRoot`.

Cost note: the closure is bounded by workspace event history and is
recomputed per query; if profiling shows it dominating, the remedy is a
cached-per-context closure with event-append invalidation *inside the
DO* — an implementation option behind the same contract, decided on
measurement in P2, never a change to the model. The invariant to test:
for every row any query can return, a hand-built legal walk to that
row's subject exists for the same caller — and vice versa for refusals.

#### 2.2.3 Budgets: what is actually enforceable

DO `SqlStorage` has no SQLite authorizer, progress handler, or
interrupt; it exposes execution plus per-cursor `rowsRead` accounting.
An injected `LIMIT` bounds returned rows, not work: sorts, grouping,
and bad joins can scan arbitrarily before the first row. The budget
contract is therefore layered and honest about which failures are
refused *before* work and which are stopped *during* it:

1. **plan-time refusals (typed, pre-execution):** AST validation —
   single SELECT, `prov_` tables only, no PRAGMA/ATTACH, **no recursive
   CTEs** (recursion is what walks are for, with server-owned bounds);
   plus an `EXPLAIN QUERY PLAN` gate that refuses full scans over
   tables above a size threshold and cartesian joins, naming the
   offending term. This catches the pathological class outright;
2. **row-streamed abort:** results are consumed through the cursor with
   `rowsRead` checked between rows against the scan budget; a breach
   stops iteration and returns a typed partial-with-refusal. This
   bounds everything that streams;
3. **the residue** — plans that pass the gate but buffer heavily before
   the first row (large sorts/aggregations under the size threshold) —
   is bounded only by the DO's own CPU limits, and the plan says so:
   post-hoc `rowsRead` is recorded and logged per query, which is
   enough to see whether the residue is a real problem. A per-caller
   scan quota is deliberately *not* built up front — it is stateful
   machinery for an abuse pattern not yet observed in a trusted
   environment; the recorded accounting is exactly the evidence that
   would justify adding it. No pretense of a pre-exhaustion guarantee
   the runtime cannot deliver.

If workerd later exposes an interrupt or authorizer hook, layer 3
tightens to a true mid-execution abort behind the same typed refusal —
a swap, not a redesign.

**Remaining guardrails:**

4. **no content bytes**: text fields are bounded excerpts; full content
   stays behind `read`/blobstore with digests;
5. **versioned contract**: `prov_schema_version` view; the schema doc
   ships in the vibestudio-vcs skill; additive changes only within a
   version; agents discover columns via one taught
   `SELECT * FROM prov_schema` catalog view (table, column, meaning) —
   self-describing, so the skill teaches the *pattern*, not the DDL;
6. **identifier hygiene at the boundary**: result rendering replaces
   id-column values with compact `@ref`s (the legend contract, §2.4),
   and query text may use `@ref`s as values (`WHERE work_unit_id =
   '@r3-9c1a'`) — the executor resolves them to exact identities from
   the reference store before execution. Joins between `prov_` tables
   need no literal ids at all; the model never transcribes a
   content-addressed identity in either direction.

**Why this is safe where "raw SQL" was banned.** The ban protected three
things: canonical-table refactoring freedom (kept — views are the
contract), server-side authorization (kept — via caller-scoped
execution, §2.2.2), and bounded reads (kept in the honest, layered form
§2.2.3 specifies — plan-time refusal where decidable, streamed abort
where not, quota for the residue). What the ban actually cost was the entire set-oriented
question class (F2), which is most of Q3/Q6/Q7 and the analytical half
of abduction. The provenance-tuning skill's exclusion list is revised by
this plan (§4).

**Why SQL and not a bespoke query DSL.** Agents already know SQL to an
extraordinary depth; a bespoke DSL trades that free competence for a
teaching burden and a parser. The failure modes of agent-authored SQL
(unbounded scans, wrong tables) are exactly what the guardrails remove.
The latency/token balance lands well: one call, one result table
rendered as an actual table (dense, no per-row prose), refs in the id
columns.

### 2.3 Entry by content: search (Q7)

One SQLite FTS5 index over the prose the system already stores:
work-unit intent text and trigger excerpts, decision rationales, event
messages, external-delta descriptions, and trajectory-message text
(bounded excerpts). Exposed two ways:

- `provenance({ target: "search: retries backoff" })` — ranked, typed
  hits, each one line (`kind · resolved intent/tier or excerpt · ref`),
  default 10;
- as `prov_search(subject_kind, subject_id, text)` in the query surface,
  so search composes with relational filters ("decisions mentioning
  retries in repository X").

The index is derived, rebuildable, and updated in the same transactions
that write the source rows. This deliberately crosses the intent
follow-up's "no intent search — build it when an agent demonstrably
lacks it" line: Q7 is that demonstration — without content entry, every
question that starts from a hunch instead of an identity is unaskable,
and the abduction loop starts from hunches. No embeddings; FTS only.
If lexical search demonstrably misses (the eval will show it), that is
a future decision made on evidence.

### 2.4 Rendering economics and batch inspection

- **`inspect` accepts up to 10 refs per call**, rendering each node's
  one-line summary under a shared header — the "expand these five agenda
  items" move that currently costs five calls.
- **Spines over frontiers**: walk output leads with resolved intents and
  indents mechanics; edges not on the spine are counted, not listed
  ("… and 3 sibling applications · @r7").
- **A legend, once**: within one rendered block, repeated subjects
  render as their compact ref after first mention; continuation calls
  render as bare `@ref` in a single footer line ("continue: pass any
  @ref back as target"), not as repeated full call syntax. (This
  tightens the intent follow-up's "boilerplate appears once" law from
  read-memory to every provenance surface.)
- **Tables for sets**: query results and cohort manifests render as
  markdown tables; narrative prose is reserved for causal chains where
  order is meaning.

### 2.5 Recovered theories are ordinary files

Abduction's product is a theory: "this user holds axiom A." Two facts
about that product decide its representation.

First, **the axioms are latent, permanently**. They exist in a user's
head and reach the record only through natural language; every
recovered axiom is a *guess* — a defeasible interpretation of evidence,
never a fact the system can hold as settled. Giving a guess a
structured stored kind launders interpretation into something that
renders like ground truth: a schema field reads as authoritative in a
way a paragraph of prose never does. The evidence/interpretation
boundary is the system's most important epistemic line — the intent
ladder guards it on the evidence side by refusing to fabricate tiers;
the same law on the theory side means *conclusions must look like what
they are*: prose, attributed, dated, revisable.

Second, a stored kind needs a writer. An earlier draft of this plan
gave recovered theories a bespoke record ("charters", with citations,
supersession, and a "contest" record for disagreement). Review killed
it, by a test this plan now adopts as a law:

> **No stored kind without a straightforward writer.** A durable data
> structure earns existence only when something writes it routinely as
> a side effect of work it was already doing. A structure whose write
> path is "an agent decides to do special curation work, then a user
> confirms it" will be written rarely, staled silently, and gamed
> occasionally — and each such kind drags a lifecycle apparatus
> (revision, supersession, dispute) that must itself be designed,
> taught, and evaluated.

Applied here: a recovered axiom is **prose, so it lives where prose
lives — an ordinary managed file** (a `NOTES.md`, a decision doc, a
module README). Everything the charter machinery tried to build, the
existing system already provides for files, for free:

- **durability and provenance**: the file is tracked; the work unit
  that writes it states *its* intent ("record the payments-API retry
  constraint recovered from ‹rejections›") — with refs in the prose if
  the author wants citations;
- **surfacing at the right coordinates**: agents already read the
  neighboring docs of code they work on, and read-memory explains the
  note file itself — who wrote this conclusion, when, triggered by
  what — with tier honesty intact (the note is `stated`-tier work like
  any other);
- **revision, supersession, and disagreement**: *editing the file*.
  The edit carries its own intent, history shows the theory's
  evolution, and a deleted claim is a counteracted change — the entire
  contest lifecycle collapses into machinery that already exists and
  that every agent already knows how to operate. "When would contests
  be introduced?" has the honest answer: never — disagreeing with prose
  is editing prose, with the disagreement recorded as intent;
- **discovery**: note files are grep-able and readable today; if the
  Q7 evidence later shows agents failing to find prose conclusions,
  extending the FTS index to managed-file content is an indexing
  decision, not a schema one.

What this deliberately gives up relative to charters: structured
citations (prose refs suffice), machine-readable "under axiom X"
linkage at write time (the intent text can just say it), and rendered
confirmation status (file authorship and history already attribute).
None of these had demonstrated readers.

Background automation fits the same shape: if we later want standing
conclusions maintained without agent initiative, that is a scheduled
task that *writes summary files* from walk/query output — a new writer
for an existing kind, not a new kind. It composes with everything above
and can be adopted or dropped without schema consequence.

The theory-maintenance loop, restated with no new machinery: evidence
(walks, queries, rejections) → agent abduction → a stated-intent edit
to an ordinary notes file → future agents encounter it by reading, as
they encounter all prose → disagreement is an edit. And because the
axioms stay latent, a note is a *prior*, not an answer: the abduction
pattern (§4) teaches treating an inherited conclusion as a hypothesis
to check against the evidence walks when the stakes warrant it —
exactly how it treats any prose. The plan's contribution to the loop is
entirely on the *evidence* side — making Q2/Q3/Q6 cheap enough that
re-running abduction in context is normal, since a guess that can be
cheaply re-derived from evidence is worth more than a stored conclusion
that can't be cheaply questioned.

### 2.6 What deliberately does not exist

- no client-side graph cache, persisted traversal session, or stored
  transitive closure — every surface derives from immediate edges at
  read time. Two scoped exceptions, both inside the DO and both
  invisible to the contract: the persisted resolved-intent columns
  (§2.2.1 — frozen output of the one loader over immutable evidence)
  and, only if P2 measurement demands it, a per-context visibility
  closure cache with event-append invalidation (§2.2.2);
- no write access of any kind through the query surface;
- no embeddings/vector search (FTS first; evidence before machinery);
- no LLM-in-the-loop summarization inside the DO — rendering is
  deterministic; interpretation stays in the agent (law 1.8 of the
  merge plan, unchanged);
- no bespoke theory, claim, annotation, or dispute store of any kind —
  recovered conclusions are ordinary tracked prose files (§2.5), and
  any future background summarization is a writer of such files, never
  a new stored kind;
- no new intent tiers, no relaxation of ladder honesty anywhere;
- no cross-state comparison smuggled into the query surface:
  state-coordinate views (`prov_files`) are pinned to the caller's
  working state; historical rows (work units, events, decisions) carry
  their own anchors, and comparing two exact states remains the job of
  walks, history, and `compare` — which name their states — never of an
  unanchored join.

## 3. Latency/token balance, restated as a contract

| Question | Today (typ.) | Target | Mechanism |
| --- | --- | --- | --- |
| Q1 why these bytes | 0 extra calls | 0 | read-memory (unchanged) |
| Q2 what was attempted | 5–8 calls | 1 | `walk: "cause"` |
| Q3 the cohort | 4–10 calls | 1–2 | `walk: "cohort"`, query |
| Q4 how related | often abandoned | ≤ 3 | cause-walk both subjects + intersect, or query join; dedicated `connect` walk only on eval evidence (§2.1) |
| Q5 purpose drift | 3–5 calls | 1–2 | intent-annotated history (landed) + taught pattern |
| Q6 what was rejected | rarely attempted | 1 | `walk: "rejections"` |
| Q7 find by content | impossible | 1 | search / `prov_search` |

Render budget per call: the read-memory constant (6,000 chars) becomes
the shared default for every provenance surface, with the same defined
degradation order and truncation marker. Latency: every mechanism above
is one DO round trip executing indexed SQL; nothing here adds a second
service hop.

## 4. Ergonomics: skills and the contract with the agent

- **provenance-orientation** is rewritten around the seven questions:
  "name your question, then use its mechanism — a walk (Q2/Q3/Q6), a
  taught composition (Q4/Q5), `query` when the question is a set,
  search when you can't name a subject, `neighbors` when nothing
  fits." The question-first framing replaces edge-walk pedagogy.
- **The abduction pattern is taught explicitly**: gather (cause +
  cohort + rejections) → hypothesize the axiom → check the hypothesis
  against rejections and intent-annotated history → if it will recur,
  write it down as prose in the relevant notes file, with the edit's
  intent naming the evidence it came from — and treat any inherited
  note as a prior to re-check, never as ground truth, because the
  axioms are latent and every written form of one is a guess (§2.5).
  This is the agent's half of the loop; the tools are sized so each
  step is one call.
- **provenance-tuning** drops "raw SQL route" from its exclusion list,
  replacing it with the real invariants: no canonical-table access, no
  unbounded scans, no authorization bypass, views-are-the-contract; and
  gains a section on diagnosing slow `query` calls (row-budget aborts
  point at missing view indexes, never at raising budgets).
- **vibestudio-vcs skill** gains `references/querying-provenance.md`:
  the view catalog pattern (`prov_schema`) and worked examples for each
  canonical question, including the Q4 and Q5 compositions.
- Tool descriptions carry the question-shaped router in one paragraph;
  the schema-level details live in the skill, not the description
  (descriptions are rent too).

## 5. Evals: the balance is measured, not asserted

A provenance eval suite in `packages/eval`, run against seeded fixture
workspaces with real recorded trajectories (the merge plan's WP8
instance generalized):

- one scenario per canonical question, graded on (a) correctness of the
  recovered answer, (b) tool calls spent, (c) rendered provenance tokens
  consumed — asserting the §3 targets;
- **the abduction scenario is the flagship**: a fixture in which a user
  made three requests and two rejections downstream of one unstated
  axiom; the agent is asked a task that violates the axiom; grading is
  whether it recovers the axiom (from cause + rejections + cohort)
  before acting, and at what cost. Run it against the old surface once
  to fix the baseline; every phase must not regress it;
- adversarial scenarios: a query whose plan the §2.2.3 gate can refuse
  is refused pre-execution with the offending term named; a streaming
  query that breaches the scan budget mid-flight returns a typed
  partial-with-refusal; a walk or query that would cross the caller's
  visibility basis renders the boundary (and the §2.2.2 parity property
  holds: query-reachable ⇔ walk-reachable, per caller); an agent whose
  gathered evidence contradicts an inherited notes-file conclusion
  surfaces the conflict and revises the note (or flags it to the user),
  rather than silently obeying the note or silently overriding it;
- **ID-hygiene probes**: scenarios run on a deliberately less capable
  model assert that no surface ever requires transcribing a
  content-addressed identity, and that a mangled `@ref` fails with a
  recovery hint (re-enter by friendly target), never a silent wrong
  answer.

## 6. Work packages

### P1 — Walks (`cause`, `cohort`, `rejections`)

The three highest-leverage walks, compiled server-side, spine rendering,
compact-ref legend shared with the `vcs` tool's reference store,
walk-aware refs (a ref can retain a walk + position), and the
identifier-hygiene sweep of existing renderers (§2.1). Includes the
batch `inspect`. Exit: Q2/Q3/Q6 eval scenarios hit targets; ID-hygiene
probes pass on every walk surface.

### P2 — Relational contract

`prov_` views + `prov_schema` catalog; persisted resolved-intent
columns with `resolver_protocol` and the recompute migration (§2.2.1);
caller-scoped execution with the `_vis_*` basis materialization
(§2.2.2, including the closure-cost measurement that decides whether a
DO-internal cached closure is needed); the layered budget contract
(§2.2.3: AST + plan gate, streamed abort, scan accounting); `@ref`
binding in query text; table rendering; versioning. Exit: Q3-as-set and
Q4-join scenarios pass; the §2.2.2 visibility parity property is tested
both directions; adversarial plan-gate and mid-flight-abort scenarios
render their distinct typed refusals; a canonical-table refactor under
test changes no view output; resolved-intent parity — persisted columns
equal the loader's output for every fixture work unit, including across
a simulated resolver-protocol migration.

### P3 — Search

FTS index + `search:` target + `prov_search` view, transactional
maintenance, rebuild path. Exit: Q7 scenario; search → walk composition
scenario (find the decision, then cause-walk it) in ≤ 2 calls.

### P4 — Rendering economics + composition evidence

Legend/footer contract applied to every provenance surface (including
`vcs` compare/blame); budget constant unified. Run the Q4 and Q5
composition scenarios (§2.1's deferred-walk bar) and record the
verdicts: each deferred walk is revived, or its deferral is confirmed,
on that evidence. Exit: render-budget snapshot tests across all
surfaces; Q4/Q5 verdicts recorded with measurements.

### P5 — Skills and docs rewrite

§4 in full. Exit: fresh-agent scenarios (no prompt hints) show
walk-first behavior; the tuning skill's revised exclusion list is
enforced by its own diagnostic table.

Ordering note: P1 before P2 deliberately — walks establish the rendered
grammar (spines, refs, budgets) that query-result rendering then reuses;
and if walks alone hit the Q3 targets, P2's scope can narrow to the
analytical remainder before it is built.

## 7. Acceptance

1. Every canonical question meets its §3 call/token target under eval,
   measured, with the abduction flagship not regressed by any phase.
2. The canonical tables remain private and refactorable: a table
   refactor that preserves view semantics is invisible to every agent
   surface, proven by test.
3. Bounded-and-authorized survives the power increase: no surface can
   exceed the render budget or the caller's visibility basis (§2.2.2,
   parity-tested both directions); scan work is governed by the layered
   §2.2.3 contract, with each layer's refusal typed, distinct, and
   naming its bound — and no stronger enforcement is claimed than the
   runtime can deliver.
4. Negative evidence is first-class: rejections are one call from any
   coordinate, and the eval shows agents consulting them before
   repeating rejected work.
5. The theory loop closes without new machinery: recovered axioms live
   as ordinary attributed prose in tracked files (§2.5), reached by
   ordinary reads; the eval shows an agent inheriting one, treating it
   as a prior, and revising it by an ordinary edit when the evidence
   contradicts it — no bespoke theory store, no confirmation apparatus,
   no rendering that makes a guess look like ground truth.
6. No surface asks the model to transcribe a content-addressed
   identity, and the walk/vcs surfaces share one reference store,
   grammar, and legend contract — proven by the ID-hygiene probes on a
   less capable model.
7. Nothing in §2.6 was built beyond its two named exceptions; the
   intent ladder is bit-identical in semantics (one loader, persisted
   output, parity-tested); read-memory's Q1 contract is unchanged.

## 8. Appendix: comparison with QMD (written after the draft above)

QMD (Query Markdown Documents; Lütke's local agent-memory retrieval
tool) was reviewed after this plan was drafted, per instruction. It is a
retrieval system over unstructured markdown — a different substrate from
our typed relational record — but three of its choices bear on this
plan:

1. **Hybrid retrieval with reranking** (BM25 + local embeddings + LLM
   rerank, plus small-model query expansion). This plan's §2.3 stays
   FTS-only by the evidence-before-machinery rule, but QMD's experience
   suggests the likely first upgrade if the Q7 eval shows lexical misses
   is *query expansion at the harness* (the agent rephrasing into the
   FTS query language it already knows) before any embedding index —
   cheaper, and it keeps the DO deterministic. Recorded here so the
   future decision starts from this baseline, not from "add vectors".
2. **"The why travels with the what"** — QMD attaches human-authored
   context at folder level and returns it with every hit from beneath.
   That is read-memory's philosophy applied to containers, and in this
   plan it lands as a *convention*, not a mechanism: recovered
   conclusions are written into notes files adjacent to the code they
   explain (§2.5), where ordinary reading already surfaces them by
   location.
3. **Session-log indexing** — QMD indexes past conversations as
   first-class searchable memory. This plan already does the structural
   equivalent (trajectory messages in the FTS index and `prov_messages`
   view), with an advantage QMD cannot have: our trajectory records are
   *causally joined* to the artifacts they produced, so a hit in a past
   conversation is one `cause`/`cohort` walk from the code it explains,
   rather than a disconnected snippet.

What we deliberately do not adopt: QMD's flat-document model has no
notion of evidence tiers, authorship, or rejection — its memory is
whatever was written, with (by its own admission) no graceful
forgetting. Our conclusions are also prose files (§2.5), but prose
whose every line carries tracked authorship, tier-honest intent, and a
revision history with recorded counteractions — the mechanisms that
keep a long-lived shared record from decaying into confidently-worded
stale prose, and where this system should stay ahead of retrieval-first
designs.

## 9. Revisions from measurement (2026-08-14, after the first real-runtime run)

The plan asked for decisions to be made on evidence. The first agentic system
tests against a real workspace authority (`skills/system-testing/tests/
provenance-questions.ts`) produced it, and it revises several choices above.

**The instrument, first.** The base unit suites run on the sql.js fallback and
the host suites mock semantic dispatch. Both stayed green while `vcs.walk`,
`vcs.query`, and `vcs.search` were unreachable end to end (no `vcsWalk`/
`vcsQuery`/`vcsSearch` RPC method, no host dispatch case) and while the catalog
view exceeded the deployed SQLite compound-SELECT limit hard enough to stop the
workspace from booting. For DO-resident SQL, one real workspace answering one
query is cheaper and strictly stronger evidence than hundreds of fallback-engine
unit tests. The host dispatch table is now derived from the port interface with
`satisfies`, so an undispatched method is a compile error rather than a runtime
one.

**§2.1 cohort scope: the default becomes `turn`.** A command is one tool call,
so a command-scoped cohort is almost always the single coordinate the caller
already had — the measured Q3 run returned one work unit and one file for a
request that touched three. A cohort subject may also *be* a scope now: a commit
event seeds from every work unit in its chain rather than through one
representative, and a turn is accepted directly.

**§2.2.1 evidence capture: trigger evidence is no longer discarded.** The store
enforced, in a CHECK constraint, that trigger evidence exists only when no
author stated an intent. The effect was that for every work unit an author
bothered to describe, the requester's own words were destroyed at write time and
the spine could only ever show the author's paraphrase. Resolution is unchanged
— `resolveIntent` still prefers the stated rung and the persisted resolved
columns are bit-identical — but both are now stored, and walks carry the
statement beside the resolved intent.

**§2.2/§2.4 the statement is the answer, not a mention.** Rendering compacted
every quoted string to 160 characters, including the terminal human statement a
`cause` walk exists to deliver and the text of an inspected message. Q2 could
therefore reach the right subject and still fail the question. Prose that a
surface was *asked for* now renders within the shared budget; incidental
mentions still compact. `prov_messages` gains `text_length` so truncation is
visible, and its catalog entry no longer promises a blobstore digest it does not
expose.

**§2.2.3 the plan gate: an empty plan is a plan.** `EXPLAIN QUERY PLAN`
returning no rows means the statement scans nothing — the cheapest possible
query — and was being refused as `plan-unavailable`. Only a *throwing* EXPLAIN
now refuses. Separately, a raw engine limit (a `LIKE` pattern the deployed
SQLite rejects) escaped as an untyped tool failure telling the agent not to
retry; engine failures are now an `engine-error` refusal that quotes the bound
and says the query, not the authorization, is what needs changing.

**§2.2.3(5) the catalog must be answerable in one call.** `prov_schema` had one
row per column: 104 rows against a 50-row page, so the single taught discovery
query could never complete and an agent learned only the alphabetically-first
relations. It is now one row per relation with the column detail carried in a
`columns` cell.

**§2.1/§2.4 the single-hop fallback was exempt from its own law.** `neighbors`
listed every edge, so an agent landing on a commit event paged through dozens of
`contains-repository` lines. Repeated relations are now counted, as the spine
rule already required.

**Acceptance 4 needed a mechanism, not a surface.** Measured agents did not
consult rejections even when asked to check for prior work, because asking
requires suspecting first. Read-memory now reports the count of rejected work at
the coordinate — only when it is non-zero — with the walk that expands it. The
count is scoped to the caller's basis, behind an indexed existence check so the
ordinary read path pays nothing when there is nothing to say.

Still open: the §3 token and call *budgets* remain unmeasured — the coverage
added here is correctness on the deployed runtime, not economics — and the
§2.2.2 closure-cost measurement is still outstanding.

**§2.3 ranked search had never executed.** The FTS path joined the `prov_search`
view back onto its own index, which made every projected column ambiguous and
relied on a `rowid` a view does not have. Neither error could appear under the
fallback engine, where FTS5 is absent and the scan path runs instead, so the
ranked branch shipped having never run once. It now reads the index directly —
`MATCH` and `bm25` need the table, not a view over it — and re-derives
visibility by existence in `prov_search` rather than restating the predicate.
A ranked path that fails on the deployed engine now degrades to the scan and
reports `indexMode: "scan"`: ranking is an optimization, entry by content is the
capability, and the capability must not depend on the optimization.

**Fixture discipline, learned the same way.** The first version of these
scenarios wrote each reason into a code comment or a notes file, so an agent
could grep its way to a passing answer without touching a provenance surface —
grading retrieval as if it were recovery. The reasons now exist only in intents,
commit messages, undone changes, and trajectory messages. The flagship goes
further: its constraint is never written down at all, only implied by three
requests and one undone attempt, which is the abduction §0 claims the whole
design is for. Still uncovered: a merge coordinate resolved `ours`, which §2.1
counts as first-class negative evidence.

**A refusal must name the thing to fix.** A statement with a misspelled column
made `EXPLAIN QUERY PLAN` throw, which the gate reported as "scan cost cannot be
bounded" — sending the agent to fix the budget instead of the typo. A throwing
EXPLAIN is now classified by the engine's own message: `plan-unavailable` only
when EXPLAIN itself is unsupported, `engine-error` quoting the message
otherwise.

**Acceptance 4, measured, does not hold — and the reason is not the surface.**
The flagship runs repeatedly: the agent performs `cause`, `cohort`, and three
`rejections` walks, reads the undone attempt, and then reasons it away — "that
was specifically about backoff behavior, not keepalive" — and repeats the
rejected work under another name. Every mechanism behaved correctly and within
budget; the inference did not happen. Two responses landed. The orientation
skill now teaches the failure mode explicitly (a rejection is evidence about a
property, not about the coordinate it was recorded at), and — because an agent
doing ordinary work never opens that skill — the same reading rule is rendered
with the rejection evidence itself, as a fixed line, never an interpretation of
it. Neither changed the outcome in the runs so far. This is the honest state:
the redesign made the evidence cheap to reach, which was its stated job, and
cheap evidence is not sufficient for abduction. Recorded as a measured gap
rather than papered over by a prompt that hands the agent its answer.
