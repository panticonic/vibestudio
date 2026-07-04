# GAD System Review — June 2026

A first-principles review of the GAD subsystem against its original ambition:
a combined **memory / hermeneutics + task / goal / issue tracking + VCS** engine
for agents.

This document is a design review, not a change set. It states ground truth,
scores the system against the three-pillar vision, and proposes a redesign with
no attachment to the current architecture.

---

## 1. Ground truth: what GAD actually is today

GAD is one Durable Object class, `GadWorkspaceDO`
(`workspace/workers/gad-store/index.ts:715`):

- ~5,960 lines, **73 `@rpc` methods**, **~28 required tables**, **schema v18**.
- Schema changes are **big-bang resets**: on a version bump it drops every
  `trajectory_*`, `channel_*`, `gad_*`, `log_*` table and recreates from scratch
  (`index.ts:740-775`). There is no migration path.

Underneath the sprawl is one genuinely good idea, the **ledger kernel**:

- A unified, hash-chained, append-only event log (`log_events` / `log_heads`)
  with a single `log_kind` discriminator and one write path, `appendLogEvent`
  (`index.ts:1301-1303`). `appendTrajectoryBatch` and `appendChannelEnvelope`
  are thin wrappers over it (`index.ts:4503-4512`, `4685-4690`).
- Content-addressed storage: `gad_blobs`, `gad_file_versions`,
  `gad_manifest_nodes/_entries`, `gad_worktree_states`, with state identity by
  hash.
- A state-transition DAG (`gad_state_transitions` / `gad_transition_parents`),
  mutable refs with a reflog (`refs` / `ref_log`), and cheap branch/fork.
- Typed projections rebuilt from the log, plus integrity/replay
  (`checkGadIntegrity`, `rebuildTrajectoryProjections`) and two-phase blob GC.

That substrate — an event-sourced, content-addressed, forkable log with typed
projections — is the rare and valuable part. **The problem is not the kernel.
The problem is that only one domain was actually built on it, while the other
two pillars were specified as more tables and never given producers or
agent-facing tools.**

`GadWorkspaceDO` simultaneously owns six concerns: the event log, the agent
trajectory/conversation store, the channel/PubSub transport history, the
worktree VCS object store, the memory FTS index, and the GC engine.

---

## 2. Scorecard against the three-pillar vision

### Pillar 3 — VCS engine: **strongest, ~70% real**

Live and working through `vcs.applyEdits`:

- content-addressed blobs, manifest trees, state hashes;
- state-transition DAG, refs + reflog, fork, edit-first commits;
- `diffGadStates` (B), 3-way merge (`MergeEngine` + vendored `diff3` in
  `src/server/gadVcs/`, merge-base discovery in the store);
- the build system already subscribes to state-advance events.

The two layers are not duplicate engines: `src/server/gadVcs/` is the
orchestration/algorithm layer; `GadWorkspaceDO` is the storage backend it drives
over RPC. No genuine data duplication.

**The gap is the differentiator.** The line-level provenance — the
"blame back to the tool call / conversation that produced this hunk" story that
was the whole reason to build a bespoke VCS instead of using git — is
**test-only populated**:

- `gad_file_mutations` and `gad_file_change_hunks` are written only in the
  `state.file_mutation_applied` branch of `projectStateTransition`
  (`index.ts:2571-2640`).
- The live `applyEdits` / snapshot / merge paths emit `state.snapshot_ingested`
  / `state.merge_applied`, never `state.file_mutation_applied`. The only emitters
  of the mutation/observation events in the repo are test files.
- Therefore `blameGadFileSnippet` (`index.ts:3336-3359`), which reads those
  hunks, **returns empty in production**. The capability is advertised but inert.

`gitBridge.ts` (export/import to real git) is built and tested but **not wired
into the server** — instantiated only in its own test.

Verdict: a working git-replacement core, but the provenance/blame layer that
justified building it is aspirational, and a believed-but-empty blame API is
worse than none.

### Pillar 1 — Memory / hermeneutics: **weakest, mostly aspirational**

What actually works:

- A lazily-created FTS5 index (`gad_memory_fts`) over **conversation messages**
  (`projectMessage` → `indexMemoryRow`, `index.ts:2271`) and **committed file
  content** (`indexMemoryFiles`).
- Exposed to the model as one real tool, `memory_recall`
  (`agent-vessel.ts:1198`), returning snippets with provenance. This is genuine
  and useful retrieval memory.

What is plumbed but **never fed**:

- **Claims.** `gad_claims`, the `knowledge.claim_recorded/updated/retracted`
  events, the projection (`projectKnowledge`, `index.ts:2650`), and claim-text
  FTS indexing all exist — but **nothing emits a claim event**. There is no
  agent tool and no code path that records a claim. The entire knowledge sidecar
  is a consumer with no producer.

What is **absent entirely**:

- **Hermeneutics** — belief revision, contradiction detection, theory
  versioning. The design docs specify `gad_theories`, `gad_theory_versions`,
  `gad_contradictions`, `gad_claim_edges`; the live schema contains **none** of
  them (0 references). `knowledge.claim_edge_*` events exist in the protocol but
  have no table, projection, producer, or API.

And the whole pillar is undercut by the big-bang schema reset: a memory system
that **wipes itself on every schema bump** cannot be long-term memory.

Verdict: text retrieval over messages+files is real; the "claims → edges →
contradictions → theories" hermeneutic graph that was the point does not exist.

### Pillar 2 — Task / goal / issue tracking: **absent**

The only task concept in the codebase is an **ephemeral in-chat TODO widget**
(`pubsub/src/todo-types.ts`) — the SDK `TodoWrite` format rendered as MDX in the
transcript. It is not durable, not stored in GAD, not queryable, has no goals,
issues, dependencies, assignment, or state machine. There is no first-class
task/goal/issue model anywhere in GAD.

Verdict: this pillar was never started.

---

## 3. Cross-cutting problems

1. **Documentation describes three different schemas.** `gad-architecture.md`
   describes `pi_*` + `gad_events`; `gad-session-tree-journal-plan.md` describes
   `pi_session_entries`; the live code uses `trajectory_*` + `log_events`.
   `gad-pi-persistence.md` is self-marked stale; `agentic-architecture.md` still
   references `pi_sessions` tables that the store drops at init. You cannot reason
   about a system whose canonical docs disagree on the table names.

2. **God object.** Six unrelated responsibilities in one 5,960-line DO with no
   internal delegate boundaries. Channel transport, agent memory, VCS, search,
   and GC all share the same class, the same tables (via `log_kind`), and the
   same blast radius. Independent evolution and isolated testing are effectively
   impossible.

3. **Schema-first, producer-never** is a recurring pattern. Both the claims layer
   and the file-mutation/blame layer have complete table + event + projection
   definitions and **no live writer**. Effort went into specifying storage shapes
   rather than into the thing that fills them or the thing that uses them.

4. **The agent barely touches GAD's richness.** The model's only GAD-facing
   affordances are implicit trajectory writes and one `memory_recall` read. Every
   sophisticated capability — diff, blame, state-producer, claims, lineage — is
   built for **panels, diagnostics, and humans**, not for the agent. This is the
   heart of the user's framing: GAD was designed to *observe and record* the
   agent, at a time when the assumption was that agents needed to be tracked. A
   modern agent can *actively curate* memory, *maintain* a task graph, and
   *reconcile* its own beliefs — but GAD gives it almost no tools to do so.

5. **No migrations** is acceptable for pre-release runtime projections but is
   fatal for the memory/task pillars, whose entire value is accrual over time.

---

## 4. First-principles redesign

### The unifying insight

Memory, hermeneutics, task tracking, and VCS are **the same shape**: an
append-only, content-addressed, branchable log of *typed, anchored events*
projected into queryable state over a shared provenance graph. GAD already built
exactly that substrate — and then used it for only one domain.

So the redesign is **not** "replace the kernel." Keep the event-sourced,
content-addressed, forkable ledger; it is the genuinely good part. The redesign
is three moves:

### Move A — Split the kernel from the domains (kill the god object)

Reduce `GadWorkspaceDO` to a small **ledger kernel**: append log, CAS/blobs,
refs + fork, projection runner, integrity/replay, GC. Nothing domain-specific.

Move each domain to its own projection module (and, where load warrants, its own
DO) over that kernel:

- `trajectory` (conversation), `channel` (transport), `worktree` (VCS),
  `knowledge` (claims/edges), `intent` (tasks/goals/issues).

Each domain owns its event kinds, projections, and RPC surface. They share the
kernel's hash chain, CAS, and fork semantics but not each other's blast radius.
This is a refactor of boundaries, not a rewrite of mechanics.

### Move B — Make every domain agent-first, not record-only

The single highest-leverage change. Treat the agent as the **producer and
curator** of the semantic and task layers, not a subject to be logged. Give it
first-class tools alongside `memory_recall`:

- Knowledge: `record_claim`, `revise_claim`, `link_claims(supports|contradicts|
  derived_from)`, `retract_claim`. These finally feed the existing-but-starved
  `gad_claims` pipeline.
- Tasks: `open_task` / `update_task` / `close_task`, `set_goal`,
  `link_task(blocks|subtask_of|about_file|justified_by_claim)`.
- Retrieval: extend recall beyond FTS text to graph queries (by anchor, by file,
  by task, by recency/decay) and, eventually, embeddings.

Memory and hermeneutics stop being passive projections and become a loop the
agent runs: assert → link → detect contradiction → revise. That loop is the
"hermeneutics," and it only exists once the agent can write to it.

### Move C — Collapse the three pillars into one anchored graph

The differentiator versus "git + a vector DB + a kanban board" is that all of it
is **one provenance graph anchored on the same event log**:

- conversation nodes (turns/messages), world nodes (file states/mutations),
  knowledge nodes (claims), intent nodes (tasks/goals/issues);
- edges: `produced-by`, `about-file`, `supports`, `contradicts`,
  `derived-from`, `blocks`, `justified-by`.

This is what makes it *combined*: a task can point at the claims that justify it,
the file states that satisfy it, and the conversation turn that spawned it; a
contradiction can point at the two claims and the file evidence that triggered
it; blame can walk from a file hunk to the task it served. None of that is
possible while the layers are separate and three of the four node types have no
producer.

### Two enabling fixes

- **Make line-level provenance real or delete it.** Either wire `applyEdits` to
  emit the file-mutation/hunk events so blame works in production, or remove the
  dead tables and the `blameGadFileSnippet` API. Do not ship a believed
  capability that silently returns empty.
- **Make the durable layers survive schema changes.** Separate the durable
  knowledge/intent ledger from the churny runtime projections, or introduce real
  migrations, so accumulated memory and tasks are not vaporized on every bump.

### What to keep / what to discard

- **Keep:** the unified content-addressed event log, refs + reflog + fork, typed
  projections, integrity/replay, GC. This is the asset.
- **Discard / repackage:** the monolithic DO boundary; the unfed claims pipeline
  *as currently shaped* (re-home it behind agent producers); the dead blame path;
  the three contradictory design docs (consolidate to one that matches the live
  schema).

---

## 5. Prioritized roadmap

1. **Truth-in-docs.** Delete/merge the stale design docs into one architecture
   doc that matches `trajectory_*` / `log_events` / `gad_*`. Cheap, unblocks all
   future reasoning. *(Low effort, high leverage.)*
2. **Resolve the blame lie.** Wire `applyEdits` to emit mutation/hunk events, or
   remove the blame API. *(Medium effort.)*
3. **Feed the knowledge pillar.** Ship `record_claim` / `link_claims` /
   `revise_claim` agent tools that emit the *already-implemented*
   `knowledge.claim_*` events; surface them in `recall`. Smallest path to a real
   memory/hermeneutics loop because the storage already exists. *(Medium.)*
4. **Add contradiction + edges.** Introduce `gad_claim_edges` and a contradiction
   surface; let the agent reconcile. *(Medium.)*
5. **Introduce the intent domain.** A real durable task/goal/issue model with a
   state machine, anchored to claims and file states. *(Larger.)*
6. **Split the god object** into kernel + domain modules once the domains exist
   and their boundaries are clear. *(Larger; do it after, not before, the domains
   are real.)*
7. **Durability/migrations** for the knowledge and intent ledgers. *(Larger.)*

The throughline: GAD built an excellent ledger substrate and then used it to
*watch* the agent. The upgrade is to let the agent *use* it — to curate its own
memory, reconcile its own beliefs, and track its own goals — over the same
graph that already records what it did to the world.
