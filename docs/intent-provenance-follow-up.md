# Intent-aware provenance rendering

**Status:** proposed follow-up, 2026-08-06
**Depends on:** [Provenance-directed net-effect merge](net-effect-merge-plan.md)
landing — the `stated` tier populated by the write-side `intent` argument,
synthesized-default deletion done, and merge decisions existing as
provenance nodes
**Scope:** one shared intent resolver; intent-aware read-injected workspace
memory; tier-aware blame; intent-first provenance continuations;
effective-history queries (a coordinate's purpose over time); the skill
docs that teach reading them

## 0. Why

The merge plan built the intent ladder (`stated | trigger | mechanical`,
tier always visible, never fabricated) for one consumer: the merge review
surface. But the system's *highest-frequency* provenance surface is not
merging — it is the workspace memory injected into ordinary reads, which
already answers "why do these lines exist" from `vcs.readMemory`. §3.5 of
the merge plan promises a symmetry — *today's write-side intent is
tomorrow's read-side memory* — and builds only the write half. This plan
builds the read half.

It is also the incentive mechanism the write side needs. Tool descriptions
can exhort agents to state intent; seeing your own and others' stated
intents rendered back every time managed text is read *teaches* it. The
loop closes when the string an agent writes at edit time is the string the
next reader sees above the bytes.

The plan is deliberately small. It adds **no new query engine and no new
provenance kind**, and almost no storage — with one principled exception
(§2.0): a few capture-time evidence fields on work units, which exist
because intent evidence must live exactly as long as the history it
explains, and the trajectory/command-journal state it currently lives in
is operational, deliberately torn down with contexts. Everything else
takes evidence the merge cutover already persists and renders it on
surfaces that already exist. That
includes its most novel piece: effective-history queries answer "what has
this file been *for*, over time" — intent-diachrony rather than
content-diachrony, something no mainstream VCS offers — yet they cost one
annotation on an existing surface plus a taught prompting pattern, because
agents compose tools well when the right primitive exists (§2.4).

## 1. Design laws

Laws 1.3–1.8 of the merge plan apply unchanged; three specifics govern
this work:

### 1.1 One resolver, N renderers

Intent resolution — work unit in, `{ text, tier }` out, by the exact
ladder — is implemented **once**, as a pure shared component, and consumed
by every surface: the merge intents projection, read-injected workspace
memory, blame, and provenance continuations. Two implementations of the
ladder will drift, and a drifted one will launder `mechanical` up to
`stated` somewhere. The merge plan's WP4 builds this resolver as shared
from day one; this plan adds renderers, never resolution logic.

### 1.2 Prose where one subject is in focus; references where many are

Intent *text* renders on surfaces with one subject in view (workspace
memory for the displayed lines, `inspect` of a work unit or decision).
Dense many-subject surfaces (blame spans) carry the `workUnitId` and the
resolved *tier* — one enum value — never the text. Bounded surfaces stay
bounded; the text is one `inspect` away.

### 1.3 Only active evidence explains current bytes

A counteracted (`undone`) change's intent must never be presented as the
explanation of bytes that exist now. Undone intents are story — reachable
through history and merge attribution — not memory attached to a live
read. The activity rules the merge plan pins for attribution govern
rendering too.

### 1.4 The attachment spends the reader's attention

Workspace memory is injected into nearly every read of managed text; it is
the most-rendered surface in the system, and every line it emits is a line
of somebody's context window. It is a **bounded sampler, and says so**:
complete coverage lives one taught continuation away in cursored `blame`
and `provenance` walks — not in `vcs.readMemory`, whose episode and
history caps have no cursor and are not meant to grow one. Within the
sample, **selection is coverage-first, ordering is salience**: episodes
are chosen to explain as much of the displayed range as the bound allows
(salience must never cause displayed lines to go unexplained while
explained lines repeat), then rendered surprise-first. Three further
consequences, all rendering defaults and never gates:

- **surprise before routine** — episodes render in salience order, not
  positional order: what arrived by merge, crossed an import boundary,
  involves counteraction, or was authored by another context leads; the
  reader's own routine authorship trails;
- **self-work collapses, but keeps its why** — an episode caused by the
  reading agent's own context renders as one line carrying the resolved
  intent, dropping the causal/decision detail. The incentive loop this
  plan is built on (§0) is agents seeing their own stated intent rendered
  back; collapse trims narration, never the why. "Self" is context
  identity, not a recency clock;
- **boilerplate appears once** — continuation instructions render once per
  block, never once per episode. A block that reads as ritual gets
  skimmed, and a skimmed attachment is worse than none: it discounts the
  surface exactly when it carries something surprising.

### 1.5 Evidence kinds never impersonate each other

Intent (the ladder's three tiers), commit messages, and turn summaries are
different evidence with different weight. Each renders under its own
label; nothing falls back *silently* into the "why" slot. This retires the
current renderer's `intentSummary ?? commit.message ?? turnSummary ??
triggerText` chain, which is tier-laundering implemented in string form.

## 2. Design

### 2.0 Evidence capture at authoring — the one storage addition

The resolver's `trigger` tier and the renderer's self-collapse currently
depend on the command journal's trajectory linkage — and `dropContext`
deletes the context-scoped journal wholesale, by design, as operational
idempotency state. Committed work units outlive it; their trigger evidence
and author-context identity do not. After a subagent closes, its unstated
work would silently degrade `trigger → mechanical`, and "self versus other
context" would be underivable — gutting the ladder for precisely the
merge-review case it was built for.

The fix is capture-time denormalization onto the work unit, where evidence
already lives as long as history: at work-unit creation persist

- `authorContextId` — the durable identity self-collapse and
  foreign-authorship salience key on (context identity, never a clock);
- when no intent is stated: the bounded `triggerExcerpt` and sender that
  the `trigger` tier renders — captured while the trajectory linkage still
  exists.

This is observable evidence the system already holds at that moment,
stored once, at its honest lifetime. It is not a cache of the journal (the
journal remains authoritative while it lives and is never read for this);
degradation to `mechanical` now means "no evidence ever existed," never
"evidence was torn down."

**Ownership and timing: these fields ship with the parent cutover** (its
WP4 now carries them), not with this follow-up — capture is
unretrofittable, and any window between the cutover and a later landing
would leave permanently evidence-less work. Because cutover instances are
recreated wholesale, every instance captures from its first work unit;
no gap exists by construction. This plan *specifies* the fields and owns
their read-side consumers.

**Semantics are inherited, not invented.** The captured fields form one
evidence class with `intentSummary`: identical participation in work-unit
identity, normalization, and integrity verification; identical visibility,
cloning, publication, and lifetime. A trigger excerpt is user-authored
text entering durable semantic history — exactly as it already does
through commit messages and stated summaries that quote or paraphrase it —
bounded at capture, never auto-sanitized (unreliable sanitization is worse
than none), and subject to no special retention regime. If redaction of
semantic history is ever needed, that is a general capability designed
once for the whole class, not a bolt-on for these two fields.

### 2.1 One pure ladder, one loader, schemas carry the result

Resolution splits where the subsystem boundary actually is:

- `resolveIntent(evidence) -> { text, tier }` — the **pure ladder** over
  supplied evidence (stated summary / captured trigger excerpt /
  canonical effects), one implementation, no storage access;
- `intentForWorkUnit(workUnitId)` — the **workspace-source loader** that
  acquires the evidence (work unit fields, §2.0 captures, effects) and
  applies the ladder. External-delta work units resolve `stated` from
  their declared description, as the merge plan specifies.

Every public schema that renders intent — readMemory episodes, history
entries, blame tiers, the merge intents projection, provenance/inspect
projections — carries the **resolved `{ text, tier }` produced by the
loader**. Harness-side renderers consume what the schema delivers and
never re-derive: they cannot reach the loader, and a second acquisition
path is exactly the drift law 1.1 exists to prevent. Parity means: one
ladder, one loader, N carriers, zero re-derivations.

### 2.2 Read-injected workspace memory: the full rendering contract

The service projection (`vcs.readMemory`) already carries the right
evidence — blame-derived episodes, decision entries with rationale, the
causal chain to trigger text, exact copyable roots. The deficits are in
the harness renderer's last mile, so this section specifies the rendered
block completely.

**Content, per episode (active changes only, law 1.3):**

1. the resolved intent of the authoring work unit, tier-labeled by the
   shared resolver — `stated: "delete this cache: it masks the race, not
   fixes it"` / `asked: "add retry to the loader"` / `mechanical: edit
   src/loader.ts`. The current silent fallback chain is deleted (law 1.5);
   commit message and turn summary may still render, but only under their
   own labels (`committed as`, never as the why);
2. **merge arrival context** when the bytes entered through a merge
   application: the merge decision, the source side's headline intent, and
   for hunk-composed content — whose `incorporates` mappings are
   byte-exact — both parents' intents. The headline needs **no special
   mechanism and no tier change**: a spawn task brief is the child's
   *assignment* — trigger evidence, sender the parent — and the child's
   own work units capture exactly that through §2.0. The source headline
   is the source side's root captured trigger evidence, rendered at
   `trigger` tier with its true author. (An earlier draft had
   `merge_subagent` write the brief into the merge work unit's
   `intentSummary`; that was tier-laundering by our own law 1.5 — it made
   the child's assignment impersonate the merger's stated purpose — and
   is retired. The merge work unit's `intentSummary` is whatever the
   *merger* actually states, or honestly absent);
3. **decision context is application-anchored, never coordinate-guessed.**
   A stable coordinate accumulates many reachable decisions over its life,
   so a bare coordinate lookup cannot say *which* decision explains *this*
   episode. The exact joins exist structurally and are the only ones used:
   for adopted/composed bytes, episode → its merge application → work
   unit → decision (the coordinate selects the entry *within* that
   decision); for `current`-resolved bytes — which did **not** arrive
   through the merge — the nearest *later* decision-bearing application on
   the spine whose entry covers this coordinate. Rendering tells the truth
   about direction: adopted/composed bytes "arrived via merge …";
   `current` bytes render as authored by their edit (byte blame unchanged)
   with "accepted as merged truth by decision …, superseding ‹source
   chain›". Singular claims are made only where the anchor is singular;
   the coordinate's full decision history remains a list reachable via
   `inspect`;
4. import boundaries and counteraction references as today;
5. nothing else. Bounded, derived, no agent-selected tiers or keywords.

**Presentation:**

- **line ranges, not code units.** Episodes currently print UTF-16
  code-unit ranges under a header that speaks in lines — the agent just
  read lines and cannot cheaply map an episode to the code it explains,
  which severs the salience link. The harness holds the content and the
  read range; it converts and renders line ranges (code-unit coordinates
  remain in the underlying result for exact continuation);
- **salience order** (law 1.4): merge arrivals and decision-bearing
  episodes first, then import boundaries and counteraction-involved
  episodes, then other-context authorship (stated tier before
  mechanical), then the reader's own prior work — positional order only
  within a band;
- **self-collapse** (law 1.4): episodes caused by the reading context
  render as one trailing line — resolved intent plus work unit, nothing
  else;
- **one footer** teaching both taught continuations — depth and drift —
  with per-episode copyable roots retained inline but instruction prose
  appearing exactly once.

**Target shape** (normative for structure and labeling, not exact bytes):

```text
workspace memory · why src/loader.ts lines 12-40 exist · verified against this exact content
● lines 12-19 · arrived via merge (decision …) · child task "tighten retry logic" ·
  stated "cap backoff at 30s" · composed with yours "migrate config to zod"
● lines 20-27 · imported from outside workspace history · git github.com/… @ abc123
● lines 28-36 · asked: "add retry logic to the loader" · committed as "retry support"
● lines 37-40 · yours · stated "migrate config to zod" (work unit …)
earlier file history
- "…" · {…root…}
dig deeper · provenance({ target: … }) on any subject above · history with
intents for how this file's purpose has drifted (§2.4)
```

The existing `provenance({ target })` continuation remains the deeper
path. Its rendering becomes **intent-first**: lead with the intent chain
(what was being attempted, by whom, in which decision context — the
law-1.8 intent-shaped map), with the edge-level causal walk beneath it
unchanged for when mechanics matter.

### 2.3 Blame carries tier, not prose

`vcs.blame` spans gain two fields: the authoring `workUnitId` (if not
already surfaced path-friendly) and the resolved intent `tier`. That is
the whole change. It lets an agent scanning a file see instantly that a
suspicious span is `mechanical`-tier — "no intent evidence here; read
harder" — versus `stated`, without bloating a dense surface with text.
Blame through merge events works as the merge plan specifies (mapped
`incorporates` edges for composed content; decision-level linkage for hand
merges); this plan adds only the tier projection on top.

### 2.4 Effective history: a primitive plus a prompting pattern

The question — "what has this file been *for*, over time, and how did
that drift?" — is intent-diachrony, and no mainstream VCS can answer it.
This system can, and the guiding constraint is that agents compose tools
well when the right primitive exists: the answer here is **one annotation,
not a curated projection**.

The primitive: **two annotations on file-coordinate history entries**,
optional and defined only for entries that carry an authoring work unit
(event-root history entries are untouched — the shared entry schema means
the fields must be optional, not required):

- the authoring work unit's resolved intent — `{ text, tier }` from the
  loader — removing the only real friction (one `inspect` per entry just
  to learn each touch's purpose, which priced the question out of being
  asked);
- `viaDecisionId?` when the change entered this line through a merge
  application. This annotation is not optional-in-spirit: file history
  emits the *original authored change* for adopted work, with no merge
  marker of its own, so without it the drift pattern cannot distinguish
  imported purpose from local drift at all.

Nothing else changes: no episode collapsing, no headline substructure, no
new view mode. An agent that wants purpose-episodes or merge headlines
composes them from history + blame + `inspect` + the decision nodes —
that is interpretation, and interpretation is the agent's half of
law 1.8.

The prompting pattern: the provenance skills (WP5) teach purpose-drift as
a worked question — walk intent-annotated history, note where the tier
drops to `mechanical` (no purpose evidence), where intent shifts without a
`viaDecisionId` (local drift), and where it shifts with one (imported
purpose; follow the decision). One taught pattern over existing tools,
zero new surface beyond the two annotations.

### 2.5 What deliberately does not exist

- no intent index, table, or cache — resolution is derived at read time
  from stored evidence (store-once law);
- no after-the-fact intent editing or annotation — a wrong stated intent
  is itself honest evidence of what the author believed;
- no per-line or per-span intent storage;
- no intent search or embeddings — the merge projection and work-unit
  `inspect` cover every known need; build search when an agent demonstrably
  lacks it, not before;
- no curated effective-history projection — no episode collapsing, merge
  headlines, or purpose-segmentation schema; the annotation plus a taught
  pattern over existing tools covers it, and agents interpret (§2.4);
- no fourth consumer invented to justify the resolver.

## 3. Work packages

### WP1 — Evidence capture and resolver split guard

Two items to flag to the in-flight merge implementation **now**:

1. the §2.0 capture-time fields (`authorContextId`; bounded
   `triggerExcerpt` + sender when unstated) persisted at work-unit
   creation — retrofitting capture after contexts have been torn down is
   impossible by definition;
2. the §2.1 split: pure ladder over supplied evidence, workspace-source
   loader, resolved `{ text, tier }` carried in every intent-bearing
   schema.

Unit tests owned here: ladder order, tier labeling, external-delta
resolution, no synthesized text on any path, and the teardown test —
`dropContext` on the authoring context leaves `trigger`-tier resolution
and self/foreign identity fully intact for its committed work units.

### WP2 — Workspace memory rendering

`vcs.readMemory` (service projection) and
`workspace/packages/harness/src/tools/read-memory.ts` (renderer) — the
full §2.2 contract:

1. per-episode resolved intent with tier label via the shared resolver,
   active changes only; **delete the `intentSummary ?? commit.message ??
   turnSummary ?? triggerText` fallback chain** — commit messages and turn
   summaries render only under their own labels (law 1.5);
2. merge arrival context from the merge decision + `incorporates`
   mappings; subagent task-brief headline where the source was a subagent
   merge;
3. **line-range rendering**: harness converts episode code-unit ranges to
   line ranges of the displayed read; code-unit coordinates remain in the
   result for exact continuation;
4. **salience ordering** per the §2.2 bands, positional within a band;
5. **self-collapse**: episodes caused by the reading context render as one
   trailing line carrying resolved intent plus work unit (context
   identity, no recency clock; the why is never dropped — law 1.4);
6. **single footer** with both continuations (provenance depth,
   intent-annotated history drift); per-episode instruction lines deleted;
7. bounds as a complete budget contract, not a comparison: **this WP owns
   the budget constant** (a character budget, set here alongside the
   existing 280-char field bound). Within it, coverage-first selection then
   salience decide what appears. When even one episode exceeds its share,
   fields degrade in a **defined order** — composed second intent, then
   source headline, then rationale, then commit message — each dropped
   field replaced by nothing, the episode's copyable root always retained;
   a **rendered truncation marker** (distinct from the service-side
   `truncated` flag, which describes episode/history caps) closes any
   block that dropped fields or episodes, pointing at the cursored
   continuations. No size comparison against today's rendering is claimed
   in either direction — earlier drafts' "never larger" and "strictly
   smaller for self" were both unkeepable as universals and are retired;
   the budget constant and once-only instruction prose are the whole
   contract;
8. `provenance({ target })` continuation rendering becomes intent-first
   with the causal walk beneath.

Exit: rendered-block snapshot tests cover every §2.2 band and label;
reading a file you just wrote yields one self line; no evidence kind
renders in another's slot.

### WP3 — Blame and history projections

`vcs.blame` span schema + implementation: `workUnitId` and `tier` per
span; no text field. `vcs.history` entry schema + implementation: optional
`intent: { text, tier }` and optional `viaDecisionId` on file-coordinate
entries with an authoring work unit (§2.4); event-root entries unchanged.
Schema tests for both root kinds; bounds unchanged.

### WP4 — Docs

- `vibestudio-vcs/references/provenance-and-blame.md`: reading tiers on
  blame spans; intent-first provenance continuations;
- `vibestudio-vcs/references/authoring-basics.md`: one added sentence
  closing the loop — "the intent you state here is what the next reader
  sees above these lines";
- `provenance-orientation` / `provenance-tuning` skills: teach the
  read-side rendering — what each tier means when encountered, when a
  `mechanical` span warrants reading code instead of trusting prose, how
  merge-arrival context chains to the source side — and the purpose-drift
  pattern (§2.4): intent-annotated history walked as a worked question,
  composed from existing tools;
- the workspace-memory guidance in `SKILL.md` (the "answer from it when
  conclusive" bullet) updated to name intent and arrival context as part
  of what may be conclusive.

### WP5 — System assertions

Extend the merge plan's WP8 system test (same instance, follow-up run):
after the conflict scenario completes, a fresh agent reads the merged file
and the injected workspace memory shows the child's stated intent and the
merge arrival context — proving write-to-read round trip through real
trajectories, not fixtures.

## 4. Test matrix

1. read of lines authored with `intent` → attachment shows `stated` text;
2. read of lines authored without → `trigger` excerpt with sender, else
   labeled `mechanical`; no tier ever silently substituted — and a work
   unit with only a commit message renders `committed as` with a
   `mechanical` why, never the message in the why slot;
3. read of counteracted-then-restored content → the undone chain's intent
   absent from memory, reachable via history (law 1.3);
4. episode ranges render as line ranges of the displayed read and map to
   the correct lines across multi-episode files;
5. salience order — a file with a merge arrival, an import, a foreign
   edit, and the reader's own work renders in exactly that band order,
   with self collapsed to one line;
6. block weight — every block renders within the budget constant,
   including a pathological single episode with headline, decision, and
   two maximal intents (fields degrade in the defined order, root
   retained, rendered truncation marker present); instruction prose
   appears exactly once per block; coverage-first selection never leaves
   displayed lines unexplained while explained lines repeat;
7. read of hunk-composed content → both parents' intents with the merge
   decision named; byte ranges follow the `incorporates` mappings;
8. read of hand-merged (`current`) content → byte blame to the authoring
   edit; the decision found **by coordinate**; rendered as "accepted as
   merged truth, superseding …", never as "arrived via merge";
9. read of subagent-merged content → the source headline renders as the
   child's root captured trigger evidence (`trigger` tier, sender the
   parent) **after the child context is closed and torn down** — proving
   its durable home is the child work units' §2.0 capture, not the
   supervisor's run table, the deleted command journal, or any
   merge-time copy;
10. blame spans carry `workUnitId` + `tier`; dense files stay within
    existing bounds;
11. history entries carry optional resolved intent and `viaDecisionId`;
    a coordinate authored under shifting intents shows the drift, adopted
    work is distinguishable from local edits by its decision marker, and
    an agent following the taught pattern reconstructs the purpose story
    from history + `inspect` alone; event-root history is unchanged;
12. provenance continuation leads with the intent chain; the edge walk is
    intact beneath it;
13. resolver parity, per carried projection: for identical work units,
    every text-bearing surface (merge projection, workspace memory,
    history) reports the identical `{ text, tier }`, and blame — which
    deliberately carries no text — reports the identical `tier`. Parity
    means agreement on what each schema carries, sourced from the one
    loader; it never obliges a surface to carry more than its contract.

## 5. Rollout

Pre-release, same discipline as the parent plan: no compatibility surface.
Ships after the merge cutover; instances are already new-model. Schema
additions (blame span fields) replace atomically; the read-attachment
format changes in place — no dual rendering. Skill docs update in the same
change (source-template content; fresh instances pick them up with it).

Instrumentation: counters for tier distribution rendered on reads (a
falling `stated` share is the earliest signal the write-side norm is
decaying) and resolver parity violations (must be zero).

## 6. Acceptance

1. One resolver serves every intent-rendering surface; parity is tested,
   and no surface contains a second ladder implementation.
2. Reading managed text shows, bounded and tier-labeled, why the displayed
   bytes exist — including merge arrival with both intents for composed
   content — from real stored evidence only, active changes only; episodes
   speak in the line coordinates the reader just read; no evidence kind
   renders in another's slot.
3. The attachment respects attention (law 1.4): coverage-first selection,
   salience-banded ordering, self-work collapsed by durable
   `authorContextId`, instruction prose once per block, a fixed rendering
   budget — verified by snapshot tests — and complete coverage always
   reachable through the taught cursored continuations (`blame`,
   `provenance`), which the block's footer names.
4. Intent evidence survives its authors: after any context teardown,
   committed work resolves the same tiers and the same self/foreign
   identity it did before — nothing degrades because operational state was
   reclaimed.
5. Blame exposes tier without text; history entries expose optional
   resolved intent and merge-arrival markers; bounded surfaces stayed
   bounded, and the purpose-drift question is answerable by tool
   composition an agent is actually taught.
6. The write-to-read loop is proven end-to-end by trajectory: an intent
   stated through an ordinary tool is later rendered to a different
   reading agent — including after the authoring child has closed.
7. Nothing in §2.5's exclusion list was built.
