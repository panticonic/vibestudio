# Provenance-directed net-effect merge

**Status:** proposed redesign, 2026-08-06
**Scope:** the entire semantic VCS merge system — comparison, integration,
decisions, external deltas, publication revalidation, the subagent merge
supervisor, and agent-facing guidance
**Supersedes:** [Causal-frontier subagent integration](subagent-integration-causal-frontier-plan.md)

## 0. Why the aperture widened

The causal-frontier plan repaired a real contract violation inside the current
integration model: replay every source change transition-by-transition, in
source order, against the target. The repair was correct within that premise —
and its cost revealed the premise. To make replay honest we needed a derived
dependency graph, a joint-composability planner on every compare, a frontier
projection, a demotion pass, and a supervisor loop. That machinery defends a
property no caller wants: fidelity of *transition order* during merging.

Merging was never meant to be time-linear. What agents (and humans) need from
a merge is:

1. take the source's work — usually all of it;
2. know precisely where both sides touched the same thing, and with what;
3. keep every thread of provenance: who authored what, why a byte is what it
   is, which decisions incorporated or declined which work;
4. occasionally take a *part* — a file, a repository — never "transition 3 of
   5 in one file's undo chain."

This plan rebuilds the merge system around those needs, for every merge
condition the system has — subagent integration, cross-context integration,
external deltas, and publication revalidation — as **one engine**. If a merge
is unergonomic for a subagent it will be unergonomic everywhere; there is one
system or none.

The redesign keeps, and strengthens, the operation-based core. Operations
(change records with canonical effects and stable identities) remain the
single source of provenance and become the audited input of the merge. What
changes is their role: **operations are evidence the merge consults; they are no
longer steps the merge executes.**

Authoritative background:

- [Minimal provenance-native workspace version control](provenance-aware-diff-merge-plan.md)
- [Conversation Forking & Subagents](fork-and-subagents-plan.md)
- `workspace/skills/vibestudio-vcs/SKILL.md` and its references
- `workspace/packages/agentic-do/references/subagents.md`

The 2026-08-06 incident (`A -> B -> A -> C` on one file plus an independent
CSS edit, refused as a duplicate file state) is the motivating regression. In
this design it is not an edge case; it is unrepresentable, because a merge
produces at most one result per stable coordinate **by construction**.

---

## 1. Design laws

### 1.1 One merge engine for every merge condition

Cross-context integration, subagent integration, external-delta review, and
publication revalidation share one comparison, one planner, one decision
shape. No caller-specific merge logic, anywhere.

### 1.2 Net effect is the contract; order is provenance

The merged state is determined by each side's **net effect per stable
coordinate** relative to a common base. The order of operations matters only
*inside* one coordinate's own story, where it determines the final value and
the attribution sequence. There is no cross-coordinate ordering, no
dependency graph, no frontier, and no replay.

### 1.3 State is primary; operations must cover it

The net delta of a side is the fact-level diff between the base root and
that side's root — always well-defined, for any two states, over any
ancestry shape. Change records do not *produce* the delta; they must
*explain* it: every differing coordinate aspect must be fully attributable
to change records reachable on that side. This **coverage invariant** is
checked on every merge; an unexplained difference is a typed
`IntegrityFailure` naming the coordinate. That makes the operation layer
load-bearing and verified rather than decorative — provenance that cannot
account for the state is corruption, caught at the merge boundary, not at
publication — without ever requiring a linear operation sequence to exist.

### 1.4 Provenance is retained in full

Provenance survives a merge through two channels, and the law claims
exactly what each provides: every source change on a coordinate the merge
had to resolve — including intermediates later undone — is **named** by
that coordinate's decision entry; source work that netted to zero is
**preserved** through the ancestry the always-persisted decision
establishes, reachable and walkable but not re-listed in a ledger row
(demanding one would be the census fallacy, §2.7). Merged results reference
the exact source changes that produced them.
Manually merged results are new authored changes carrying derivation edges to
both parents' chains. Blame and "why" traversals cross a merge event into the
full source history. Nothing about abandoning replay abandons provenance.

### 1.5 Convergence is not a decision

When both sides independently arrive at the same value for a coordinate
aspect, the merge records the fact (joint attribution, both chains accounted)
and moves on. No evidence predicates, no reconcile ceremony, no unresolved
disposition. Requiring an explicit decision for coincidental equality was
purity taxing the agent; it is gone.

### 1.6 Store each fact once

Applications, changes, and merge decisions are the durable truth. Pending
merge state is always re-derived by comparison at the live head. There is no
merge session, checkpoint table, pending tree, or duplicate progress ledger.
The subagent run table keeps only its bounded lifecycle projection.

### 1.7 Integrity validation remains strict

The duplicate/unchanged fact checks in `workspaceFactChangeSet.ts` remain
mandatory and unchanged. The merge planner makes them unreachable from any
published plan; they stay as the last line of defense.

### 1.8 The machine draws the boundary; the agent owns the semantic side

Mechanical merging — adoption, convergence, orthogonal and hunk composition
— asserts *textual and structural* compatibility only. Semantic
compatibility is the agent's job, and the system's obligation is to hand the
agent an **intent-shaped map** of what was merged mechanically, not a
byte-shaped log: which intents were involved on each side, what composed
without a decision, and where a coherent intent was only partially adopted.
These are signals, never gates — reintroducing blocking ceremony for
machine-guessed risk would repeat the `already-satisfied` mistake. The
system makes the mechanically-merged territory cheap to survey and cheap to
dig into; whether to dig is agent judgment.

### 1.9 Every conflict names its remedy

A conflict is reported with the coordinate, the conflicting aspects, base /
ours / theirs values with human paths, both sides' attributions, and the
closed set of resolutions that discharge it. No refusal ever requires a
provenance forensics session to interpret, and no message tells an agent to
do something the service will reject.

---

## 2. Semantic model

### 2.1 Merge inputs and base

A merge relates three states:

- **theirs** `S`: a committed source event, or an external delta;
- **ours** `T`: the exact target working head (event or application);
- **base** `B`: for an event source, a common ancestor event of `T`'s
  committed lineage and `S` in the event DAG, found by the existing bounded
  ancestry walk; for an external delta, the delta's declared basis.

When criss-cross histories yield several maximal common ancestors, the base
set is computed (bounded by the existing ancestry ceilings) and one primary
base is chosen deterministically — greatest generation, ties broken by
canonical event ID — for diffs and attribution. But base plurality is a
**correctness** concern, not an efficiency one, and the plan does not
pretend otherwise: two maximal bases can hold *different values* for one
coordinate aspect, and against one base a divergence looks like "theirs
changed, adopt silently" while against the other it looks like "ours
changed, keep silently" — opposite outcomes, neither surfaced. The rule is
therefore conservative and simple: **for any coordinate aspect on which the
maximal bases disagree, the merge never resolves silently** — no silent
adopt, keep, convergence, or hunk composition; the aspect classifies as a
`conflict` carrying the disagreeing base values, and the agent decides with
the ambiguity in view. There is no recursive-base construction and no
virtual ancestor; base-agreeing coordinates (the overwhelming majority in
every real history) behave identically under any base choice, and
base-disagreeing ones are exactly the set where only a decision is honest.
A source already reachable from `T` yields an empty merge (`unchanged`).

### 2.2 Coordinates and aspects

The unit of merging is the **stable coordinate**:

- a file identity `fileId`, with aspects `presence`, `content`, `placement`
  (repositoryId + path), `mode`;
- a repository identity `repositoryId`, with aspects `presence`, `path`.

Aspects are exactly the existing canonical effect kinds (`content`,
`placement`, `mode`, `repository-placement`, plus presence transitions from
create/delete/restore). No new representation is invented.

### 2.3 Net delta and attribution

For each side independently, derive a **net delta**: per coordinate, per
aspect, the base value and the side's final value — computed directly as the
fact diff between `B`'s root and the side's root. This is deliberately *not*
a fold over an operation sequence: in the event DAG, second parents carry
ancestry and story while content enters a line only through applications on
its first-parent chain, so a linear "operations since B" sequence need not
exist when `B` lies across a merge. State diff exists unconditionally; it is
the primitive.

**Attribution follows the state-carrying spine.** The existing model's
separation is the ground truth here: state enters a line **only** through
applications on its first-parent chain; second parents carry ancestry and
story. A raw "everything reachable from the side but not from `B`"
enumeration would therefore overshoot — second-parent events contain
operations an earlier merge may have declined, superseded, or only
partially adopted, which never entered this side's state and cannot appear
in its attribution. The rule:

- enumerate the side's **first-parent application chain**, newest to
  oldest, filtering applied changes per coordinate and aspect through their
  canonical effects, in (application order, applied-change ordinal) order —
  this includes every touch, including changes later overwritten or
  counteracted on the line, marked `undone`;
- where an application on the spine is itself a **merge application**, its
  applied changes realize source changes (or authored merge changes), and
  attribution expands through the merge's own decision into the accounted
  source chain — exactly the work that *was* incorporated, and nothing the
  decision declined;
- the walk for a coordinate terminates at the nearest spine point that
  carries the base value, or at a merge application whose decision accounts
  the coordinate's introduction — every discontinuity must be a decision.

**Endpoint continuity uses all applied changes; activity governs value.**
Composition along the spine runs over every applied change in order —
counteracted ones included, since the inverse's base is the counteracted
change's result and skipping it would fabricate a gap. Activity
(counteraction) determines what contributes to the *net value*; it never
excises links from the endpoint chain. Where history is linear this all
reduces exactly to the intuitive chain.

- Counteraction keeps its existing meaning: a counteracted change is
  inactive and contributes no value, but remains in the attribution marked
  `undone`, so the story of the coordinate is complete.
- A `file-copy` mints a new coordinate whose story begins at creation; its
  `authored-copy-source` endpoint and derived `copies-content` lineage are
  untouched by this plan.
- Net delta and attribution are pure, bounded by the existing
  ancestry/application limits, and derived at read time. Nothing is
  persisted.

**Coverage invariant (law 1.3):** for every differing aspect, the spine's
applied changes compose continuously (all links, `undone` included) from
the walk's termination point to the side's final value, and the termination
point is either the base value or a decision-accounted introduction. An
unexplained discontinuity is `IntegrityFailure` with the offending
coordinates. Verified on every merge.

For the incident history `initial -> A -> B -> A -> C`, the source net delta
for `index.tsx` is one aspect delta — `content: initial -> C` — attributed to
the full four-change sequence. The undo chain is provenance, not procedure.

### 2.4 Merge classification

Per coordinate, compare the two net deltas:

| ours \ theirs      | untouched      | changed                       |
| ------------------ | -------------- | ----------------------------- |
| **untouched**      | not in merge   | `adopt` (take theirs)         |
| **changed, equal** | —              | `convergent` (auto-accounted) |
| **changed, other** | keep (ours)    | `conflict`                    |

Refinements:

- **Aspect orthogonality.** Within one coordinate, disjoint aspect changes
  compose: ours edited content while theirs moved the file → adopt their
  placement, keep our content, one merged result, no conflict. Equal aspects
  are convergent per aspect.
- **Presence dominates.** A side that deleted the coordinate conflicts with
  any other-side change to it (delete-vs-edit, delete-vs-move). Both deleted
  → convergent. Delete against an untouched side → adopt.
- **Structural validation is a set property.** The candidate merged state is
  validated as one set: path uniqueness per repository, repository presence
  for every placed file, repository-path uniqueness. Violations become
  **structural conflicts** naming both coordinates involved (e.g. each side
  created a different file identity at the same path).
- **Coupled groups.** Coordinates whose adoption is only valid together —
  a file placed into a repository the source created, a chain of moves
  through a vacated path — are grouped by the planner. Their semantics are
  exact, not gestural: build the structural-constraint graph over the
  adoptable/composed coordinates (an edge when one coordinate's merged
  validity depends on another's inclusion — repository presence, path
  vacancy); groups are its **connected components**, so groups never
  overlap. A group adopts as a unit; a group containing a conflicted or
  unresolved member is pending as a unit until that member resolves. A group
  larger than the per-call coordinate bound (§2.9) is refused with the
  existing typed `ScopeTooLarge` — a move-web that large is degenerate
  history, not a merge to be heroically planned.

  Named honestly: this is the residue of structural composability, and it is
  all that survives of the deleted dependency machinery. The difference is
  categorical, not rhetorical — groups are derived from state predicates
  among already-classified coordinates, order nothing, know nothing of
  change granularity, and impose no iteration protocol.

### 2.5 Hunk composition is part of classification

Aspect orthogonality extends *into* the content aspect. When both sides
edited a text file, the planner runs a deterministic three-way line merge
(base/ours/theirs):

- **non-overlapping hunks** → the coordinate is `composed`, exactly like
  content-vs-placement composition: the merged content applies
  automatically, authored as a new merge change with derivation edges to
  both chains (§2.7). Parent edits the top of a file, child edits the
  bottom — the single most common multi-agent collision — is not a conflict
  and requires no ceremony.
- **overlapping hunks**, or non-text content → an ordinary content conflict
  carrying both values and both attributions.

The text merge is a small pure function with one deterministic algorithm.
There is no flag to turn it off and no mode selector: one engine, one
behavior. A caller that wants a different merged result for a composed
coordinate expresses that the ordinary way — edit the file and commit; the
composition is honest history, not a guess to be suppressed.

### 2.6 Resolutions

Every conflict carries its closed resolution set:

```ts
type MergeResolution =
  | { kind: "theirs" }   // adopt source's net result
  | { kind: "ours" }     // keep target's value; declines their chain
  | { kind: "current" }; // accept the target head's *current* value as the
                         // merged truth (used after the agent hand-authors a
                         // merged result with ordinary edit tools)
```

Resolutions address any **unresolved** coordinate — conflicted or
cleanly-adoptable — as a whole: `{ coordinate, resolution }`. **Aspects are
diagnosis, not decision surface.** Per-aspect display tells the agent
precisely what diverged; the decision is per coordinate, because every
mixed outcome an aspect-scoped resolution could express is already
expressed better by the ordinary path — author the truthful combined state
with edit tools, then resolve `current`. `ours` on a conflicted coordinate
keeps the target's value; `ours` on an adoptable coordinate is the explicit
**decline** — the only honest way to take part of a source and settle the
rest, which §0's "take a part" requires. Simply omitting a coordinate from
the call leaves it pending for a later merge; declining it resolves it.
`ours` and `current` account the source chain as **declined** and
**superseded-by-merge** respectively; both satisfy completion. An optional
bounded `rationale` may accompany any resolution.
There are no evidence predicates: the evidence *is* the exact head the
resolution was made against, which the command's expected-basis check
already pins.

**`current` persists a decision entry and nothing else.** The truthful
merged value already exists at the head as ordinary authored history; a
second authored change for the same value would have no fact transition and
would (correctly) be refused by the strict unchanged-state validator. The
decision entry links the source chain to the coordinate; no change is
minted, no transition is forged.

A coordinate **materializes only when nothing about it remains in
conflict**. Aspect classification is fine-grained so diagnosis is precise,
but the fact model has one state per coordinate, so a coordinate with an
adoptable placement and a still-conflicting content aspect is pending as a
whole — partial truth per coordinate is not a state this system can
honestly represent, and it does not pretend to.

### 2.7 What a merge records — the provenance ledger

Every `vcs.merge` call persists, atomically, through the ordinary mutation
path:

1. **One application** on the working chain with at most one fact result per
   coordinate (by construction). The applied-change model keeps its existing
   shape — one `changeId`, one base/result pair, one realization edge per
   applied change; no "aspect-wise changeRef" is invented. The realization
   rule for each coordinate's transition:
   - when the transition's result **exactly equals one source change's
     result endpoint**, use `{ kind: "existing", changeId }` — the common
     case (any linear net chain ends at its last change's endpoint), and
     `realizes-change` works exactly as today;
   - otherwise — hunk-`composed` content, or a transition combining aspects
     from several source changes — author **one new merge change** whose
     payload records its contributors (`mergesChangeIds`: the relevant
     changes from each parent's attribution), realized normally by the
     application.
2. **Content lineage only where it is mechanically true.** The existing
   content-edge model (`preserves` / `copies` / `incorporates`) carries
   exact range mappings; it is not a causal label. Hunk-`composed` results
   derive real mappings from the three-way merge, so they record
   `incorporates` edges to both parents' applied changes — byte-level blame
   into both chains, honestly earned. A hand-authored `current` result has
   no derivable range mapping and gets **no content edge**: its byte-level
   blame goes to the ordinary edit that authored it, and its merge-level
   provenance ("this value was decided as the merge of these chains") lives
   in the decision entry, which is itself a traversable provenance node.
   No edge ever claims a mapping nobody computed.
3. **One merge decision — always, even when nothing materializes.** The
   decision is the durable carrier of the merge itself, not a side effect of
   adoption. A merge whose every coordinate is convergent, or whose source
   net delta is empty (a child that explored and undid everything), records
   a decision with source ref and its — possibly empty — entries, riding an
   application with no fact results, exactly as reconcile/decline decisions
   do today. That decision is what `commit` derives the multi-parent
   integration event from; the child's complete story, undone work included,
   becomes reachable ancestry instead of vanishing because it happened to
   net to zero. Entries are per coordinate — aspects live in compare's
   diagnosis, not in the durable record:

   ```ts
   {
     coordinate: { kind: "file" | "repository", id, path? },
     resolution: "adopt" | "convergent" | "composed" | "ours" | "current",
     accountedSourceChangeIds: string[], // full attribution across the
                                         // coordinate, undone included
     resultChangeRef?: ...,
     rationale?: string,
   }
   ```

4. **Ancestry**: commit continues to derive multi-parent integration events
   from the chain's recorded decisions, unchanged. The source event becomes a
   second parent; blame, `history`, and `neighbors` traverse through the
   merge event into the source's complete per-operation history.

**Accounting is state-anchored, not census-based.** The invariant is: every
coordinate at which source and base differ carries an entry resolving it,
and that entry's accounting names the coordinate's full attribution (the
union across its aspects). Changes on net-zero coordinates need no entry — their story is
preserved by ancestry reachability through the always-persisted decision,
and demanding a ledger row for work with no net effect would be the census
fallacy that made `already-satisfied` necessary. `push` revalidates the
state-anchored form: per integration parent, every differing coordinate
accounted — same guarantee, cheaper check.

Nothing else. No session, no checkpoint, no second ledger (law 1.6).

### 2.8 Completion

```text
resolution.complete === true      // derived: remainingCoordinateCount === 0
resolution.remainingCoordinateCount === 0
resolution.concluded === true
```

(`complete` is a derived convenience bit; the schema enforces its
consistency with the count, as the old contract did.)

Completion is state-anchored: a coordinate is remaining exactly when source
and target values differ at some aspect and no reachable decision entry
resolves it. Net-zero and convergent coordinates are complete by state, not
by ceremony.

`concluded` is the second, distinct bit: true exactly when a reachable merge
decision names this source (or the source event is already an ancestor of
the target). It distinguishes "nothing differs, because the work converged
or netted to zero" from "this source was actually merged." Without it the
model contradicts itself: an all-convergent child's compare would report
`complete` before any merge call, a supervisor would stamp success without
recording anything, commit would derive no source parent, and the child's
story would vanish — precisely the loss §2.7 point 3 exists to prevent.
Compare alone never concludes a merge; only a `vcs.merge` decision does.

`already-satisfied` no longer exists. Counts, empty pages, and "no
conflicts" are not substitutes; the supervisor and close consume
`complete && concluded`, and `push` revalidates the state-anchored
accounting.

### 2.9 Partial merges

`vcs.merge` accepts an optional coordinate subset. Any subset that respects
coupled groups is valid — the merge algebra guarantees that merging a
partition of the coordinates sequentially, in any order, equals merging them
at once (§7.3 tests this). The 200/500 bounds become simple pagination over
coordinates; there is no frontier, and no batch is ever invalid by
composition.

There is exactly one conflict behavior: clean coordinates apply, conflicts
return as remaining work, re-derived by the next compare. No `onConflict`
mode, no all-or-nothing flag — a caller that wants to act only on a
conflict-free merge reads `compare` first; that is what compare is for. One
default that is always safe beats two modes to choose between.

**Bounds are honest and explicit — and analysis is comparison-scoped, not
page-scoped.** The precise claim: **classification is global,
materialization is paged.** Every compare and every merge call derives the
full comparison — all touched coordinates, all groups, the whole intents
projection — bounded by the existing comparison ceilings (ancestry edges,
source-story size); a comparison exceeding those ceilings refuses with the
existing `ScopeTooLarge`, exactly as today. What the page bounds is the
*mutation*: one `vcs.merge` call materializes at most one bounded page of
coordinate results (the existing 500-row scale; exact constant set in WP3).
This is what makes pagination genuinely free at the review layer: `split`,
group membership, counts, and `resolution` are derived from the global
classification plus reachable decisions, so the agent sees an intent as
`split` (its conflict included) *before* any page is chosen, regardless of
which page materializes first — page order changes when facts land, never
what the reviewer knows. Coupled groups (derived globally) must fit within
one page or the merge refuses with `ScopeTooLarge`. "No loop" means no
*semantic* iteration protocol; it never meant unbounded single mutations —
nor did "page-bounded" ever mean the analysis is blind beyond the page.

---

## 3. Public contract

### 3.1 `vcs.compare` — the coordinate view

Compare is rewritten from a change-disposition listing to a **merge preview**.
For one exact target and source it returns:

```ts
{
  target, source,
  base,                                    // primary base, exact typed ref
  bases?: StateRef[],                      // full maximal set when > 1
  resolution: { complete, remainingCoordinateCount, concluded },
  counts: { adopt, convergent, composed, conflict, resolved },
  intentCounts: { merged, settled, split, contested, pending },
  coordinates: Array<{
    coordinate: { kind, id, paths: { base?, ours?, theirs? } },
    status: "adopt" | "convergent" | "composed" | "conflict" | "resolved",
    aspects: Array<{
      aspect: "content" | "placement" | "mode" | "presence" | "path",
      base, ours, theirs,                  // canonical bounded values
      baseValues?: Array<{ eventId, value }>, // §2.1: disagreeing maximal
                                              // bases — present exactly when
                                              // base ambiguity forced the
                                              // conflict, carrying the
                                              // evidence for the decision
      status: "adopt" | "convergent" | "composed" | "conflict" | "ours",
    }>,
    attribution: {
      ours: Array<{ changeId, workUnitId, undone?: true }>,
      theirs: Array<{ changeId, workUnitId, undone?: true }>,
    },
    group?: string,                        // coupled-group key, when coupled
    resolutions: MergeResolution["kind"][],// closed set, any unresolved row
    decisionId?: string,                   // when already resolved
    summary: string,                       // deterministic, from aspects
  }>,
  intents: Array<{                         // the semantic projection
    workUnitId, side: "ours" | "theirs",
    intent: {
      text: string,                        // resolved via the §3.5 ladder
      tier: "stated" | "trigger" | "mechanical",
    },
    coordinates: CoordinateRef[],          // bounded per entry
    state?: "merged" | "settled" | "split" | "contested" | "pending",
                                           // theirs-side only; ours-side
                                           // entries are context and carry none
  }>,                                      // bounded; see below
  intentsTruncated: boolean,
  nextCursor,
}
```

- Summaries are derived from aspects (`edit src/index.ts (content abc… vs
  def…, theirs also moved it)`) — presentation only, never parsed.
- `resolution`, `counts`, and every coordinate's classification are identical
  on every page of one logical comparison (compare recomputes per page over
  the same exact inputs, as today).
- Individual operations stay reachable through `inspect` / `history` /
  `blame` from the attribution entries; the merge surface itself never asks
  anyone to reason about transition order.

**The `intents` projection is the overview mechanism (law 1.8).**
Coordinates are the mechanical view; work units are the semantic one, and
agents reason in the second. The projection is one join — attribution
already carries work-unit IDs, and work units already record intent
summaries — grouped per side, derived at read time, no new state. Its
`state` field is the dig-here signal. It is a pure function of the global
classification plus reachable decisions — never of which pages happen to
have materialized — so it is page-invariant *and* truthful, describing
disposition rather than narrating adoption order:

- `merged`: every coordinate this intent touched is (or will mechanically
  be) adopted, composed, or convergent — the survey list for semantic
  review;
- `settled`: every coordinate is resolved, and at least one was settled by
  decision — declined (`ours`) or superseded (`current`) — rather than
  adopted; the intent is finished but *not* (entirely) incorporated, which
  is exactly what a reviewer must not confuse with `merged`;
- `split`: the intent's coordinates have **heterogeneous dispositions** —
  some mechanically mergeable or already resolved, some contested. The
  highest-risk state on the board: an intent may be indivisible, and its
  clean part may be invalidated by how its contested part resolves. The
  warning holds identically before and after any page lands;
- `contested`: every coordinate is in conflict; nothing mergeable yet;
- `pending`: cleanly mergeable, not yet concluded.

(`contested`, not `conflicted` — the latter name is retired with the old
run enum and stays greppable-dead.)

The same join annotates each conflict in place: an agent reading one
coordinate sees the recorded intent behind each side's bytes
(`ours: "migrate config to zod" / theirs: "add retry to loader"`), which is
the question a semantic merge actually answers. Byte values say *what*
diverged; intents say *whether it matters*.

**Intent is resolved through an explicit ladder, and degrades honestly.**
The system's standing commitment holds: private model reasoning is neither
persisted nor inferred, so intent is only ever *observable evidence*, and
its provenance tier is shown, never laundered:

1. `stated` — the intent argument supplied at authoring time (§3.5), or the
   work unit's recorded summary;
2. `trigger` — a bounded excerpt of the exact trigger message, rendered as
   what it is (`asked: "add retry logic to the loader"`): what was actually
   requested, with a named sender — different evidentiary weight than a
   self-report, and sometimes better;
3. `mechanical` — the effect-derived summary, labeled mechanical, when no
   intent evidence exists at all.

Three tiers, deliberately not more: self-report, request, and no-evidence
are the distinctions a merging agent acts on. (An earlier draft had a
fourth `turn` tier from optional turn summaries; it was taxonomy for its
own sake and is cut.)

Absence displayed as absence is itself a signal: a source side that resolves
mostly `mechanical` tells the merging agent plainly "you hold no intent
evidence here — read the code." Nothing synthesizes a plausible purpose
from a diff, ever.

**The projection is page-invariant and bounded.** Adoption states derive
from the global classification plus reachable decisions (§2.9), so the same
comparison shows the same intents on every page. The embedded array is
bounded (same 200/500 scale as everything else), ordered by review
priority — theirs-side `split` first, then `contested`, `pending`, `full`,
then ours-side context — with `intentsTruncated` set when history is denser
than the bound. Truncation removes strictly lowest-priority entries first,
and the global `intentCounts` are always present and exact — so even in
the pathological case where `split` entries alone exceed the bound (a
comparison already beyond any single review sitting), nothing is hidden
*statistically*: the agent sees `split: 700`, knows the listing is a
prioritized sample, and narrows by coordinate. No absolute
"never-truncate" promise is made that a bounded response cannot keep.
There is no dedicated intents view or second pagination mode: the
truncated tail is reachable the ordinary way — attribution names its work
units and `inspect` reads them — and a whole view mode for that rare tail
would be surface without a customer.

### 3.2 `vcs.merge` — the one mutation

Replaces `vcs.integrate` (renamed: the old name described the replay model).

```ts
{
  contextId, commandId, expectedWorkingHead,
  source: { eventId } | { deltaId },
  coordinates?: CoordinateRef[],           // default: first MERGEABLE page —
                                           // conflicted coordinates are never
                                           // implicitly selected (§2.9)
  resolutions?: Array<{ coordinate, resolution, rationale? }>,
  intentSummary?,
}
```

When the mergeable set is empty — a conflict-only source, or an
all-convergent/net-zero one — the call is still valid and still does its
job: it persists the merge decision (possibly with zero adoption entries),
which is what concludes the merge (§2.8) and carries ancestry. A
conflict-only source thus yields a decision-only application, `concluded:
true`, `complete: false`, and the full conflict review surface — the exact
`needs-decision` shape the supervisor expects. `ConflictPresent` fires only
when a caller **explicitly** selects a conflicted coordinate without its
resolution.

Returns the new working head, the decision ID, per-coordinate outcomes, the
same `resolution` object compare would now report — so one call both acts
and re-measures — and the **review surface**: the `intents` projection over
what this call actually did, plus a distinct `composed` list (every
coordinate whose content or aspects were mechanically combined, with both
intents inline). Adoption of a whole file the other side never touched needs
no review; composition of two intents into one file is an assertion the
machine cannot finish — the result hands the agent exactly that residue,
smallest first. Typed refusals:

- `ConflictPresent`: the caller explicitly selected a conflicted coordinate
  without supplying its resolution; carries the aspect detail and the closed
  resolution set;
- `CoupledGroupIncomplete`: a subset split a coupled group; names the group;
- `RevisionChanged`, `IntegrityFailure`: unchanged semantics.

`DependencyBlocked` is deleted; nothing can be dependency-blocked.

### 3.3 External deltas and publication

- `registerExternalDelta` sources feed the same net-delta/attribution
  derivation (their ordered changes are one side's story against the
  declared basis) and the same compare/merge surface. Coordinator flow is
  unchanged in shape and much simpler in content.
- `push`'s `assertIntegrationHistoryValid` revalidates per coordinate: every
  source-touched coordinate of every integration parent must be accounted by
  a reachable merge decision. Same guarantee, same walk bounds, simpler
  predicate.
- `commit` and `importSnapshot` are untouched.

### 3.4 What is deleted from the public surface

The change-granular disposition taxonomy (`shared` / `already-satisfied` /
`actionable` applicable-blocked-conflicting / `accounted` / `historical`),
reconcile-with-evidence decisions, per-change adopt decisions, prerequisite
change IDs, and the seven-way counts object. Pre-release: replaced
atomically, no dual-write, no aliases (§8).

### 3.5 Intent capture at authoring time

The merge surface is the first consumer that makes writing intent rational,
so authoring is where intent gets funded — symmetrically with the read
side. Reads already answer *"why is this here?"* (workspace memory
attachments, `provenance({ target })` continuations); writes now accept
*"why am I doing this?"* at the moment it is cheapest and most accurate to
state. The same graph, traversed in opposite directions: today's write-side
intent is tomorrow's read-side memory and the merge projection's `stated`
tier.

- Every agent-facing authoring tool — `edit`, `write`, `move_file`,
  `copy_file`, the compact `vcs` mutations (`revert`, `merge`, `commit`) —
  accepts an optional bounded `intent` argument. It maps onto the existing
  mutation `intentSummary` and lands on the work unit; no new storage, no
  new provenance kind. The plumbing exists; this makes it a first-class,
  ergonomic argument instead of a service-level field agents never see.
- **Never required.** A mandatory intent field produces boilerplate, and
  boilerplate is worse than honest absence because it launders `mechanical`
  up to `stated`. The ladder (§3.1) makes absence visible and survivable.
- **Synthesized defaults are deleted, not flagged.** The harness currently
  *generates* filler when the caller supplies none — `file-transfer.ts`
  fabricates `"Move X to Y"` into the same `intentSummary` field as stated
  intent — which makes the `stated` tier underivable from stored data: the
  projection cannot tell prose an agent meant from prose a tool template
  produced. The cutover removes every such default across the harness
  tools; an absent intent is *stored absent*, and the `mechanical` tier is
  rendered from canonical effects at read time, where it belongs. No
  provenance flag distinguishing "real" from "generated" summaries is
  added — the generator is the bug, and pre-cutover rows don't survive the
  rollout anyway (§8). After the cutover, `intentSummary` contains only
  what someone actually said.
- The tool descriptions teach when intent earns its keep: when the purpose
  of this change is not derivable from the trigger text — mid-plan pivots,
  changes serving a goal several steps away, mechanical-looking edits with
  non-obvious purpose ("delete this cache: it masks the race, not fixes
  it"). When the trigger already says it, the `trigger` tier carries it and
  restating is noise.
- Intent text is claimed, not verified. The projection presents it as the
  author's statement alongside mechanical effects; divergence between
  stated intent and actual effect is exactly the kind of thing a reviewing
  agent should notice, and the display never conflates the two.

**The write side ships with this cutover, not after it.** The `stated` tier
is load-bearing for the review surface, so the capture path is a completion
condition of the plan, not a follow-up: the `intent` argument on every
authoring tool, the system-prompt and skill guidance that teach it, and the
projection that displays it land in the same change. A merge surface
released ahead of its capture path would resolve everything
`trigger`/`mechanical`, teach agents in the first week that the intents
projection carries nothing, and squander the one moment a new surface gets
to establish that reading it pays. Cold start is a real cost paid once;
a discredited signal is paid forever.

---

## 4. `merge_subagent` — no frontier, no ordering

The helper is renamed with the model: `merge_subagent` (the verb agents see
must be the verb the system performs). There is no `integrate_subagent`
alias.

```text
status parent and child
child not clean            -> status "source-uncommitted"
merge one coordinate page at the exact returned head, repeat while pages
  remain (mechanical pagination — any page next, no ordering, §2.9);
  ALWAYS at least one merge call, even for an all-convergent or net-zero
  source — compare never concludes a merge, only a decision does (§2.8)
complete && concluded      -> stamp merged;          status "working" | "unchanged"
conflicts remain           -> stamp needs-decision;  status "needs-decision"
```

The common case is literally one merge call. When a source exceeds the page
bound the helper issues successive page calls; that is chunking, not a
frontier — there is nothing to compute between pages and no order to get
wrong.

Protocol `vibestudio.subagent-merge.v1` — a new contract, not v3 of the old
one; nothing in its shape or naming acknowledges the replay-era protocol.
Complete status union:
`working | unchanged | needs-decision | source-uncommitted | closed`. The
response reports the procedure honestly as a sequence, never as one atomic
outcome: a bounded `merges` array — one entry per executed page call, each
with its own decision ID, application, and per-coordinate outcomes — plus
one review surface aggregated over the whole procedure: the `intents`
projection with `split` intents flagged, the union `composed` checklist
with both sides' intents, each remaining conflict with its aspects, both
attributions, and resolution set, and the final `resolution`. The
single-page common case is simply a one-entry sequence; a partial or failed
multi-page run reports the pages that durably landed alongside the typed
failure. **The child's task brief headlines the source side**:
the parent authored it at spawn time, so it is the one intent statement
with a named author who is the reader's past self, and it frames every
per-work-unit intent beneath it. A parent reading one helper response knows,
without any follow-up traversal: what was taken, what combined two intents
mechanically and deserves a read, which adopted work belongs to a
partially-resolved intent, and what still needs a decision.

The parent resolves conflicts with ordinary tools: inspect the coordinate,
author the truthful result, then `merge` again passing
`{ coordinate, resolution: "current" }` (or `"theirs"` / `"ours"`), either
directly or through a re-invocation of the helper with resolutions. Every
step is an ordinary idempotent VCS command with the existing deterministic
command identity; a retry of a response-uncertain identical request reuses
its ID.

Durable run states: `merged | needs-decision | discarded` — one vocabulary
across the tool, the protocol, and the ledger; no old value survives
(exact-enum reads throw on unknown values, so rollout resets pre-release
rows, §8). The stored value is a listing/prompting projection only.

**Close verifies live state, always.** Every non-discard close requires a
clean committed child and a fresh compare reporting
`resolution.complete && resolution.concluded` — for runs stamped `merged` as
much as unmarked ones, and `concluded` guards the all-convergent child whose
work would otherwise be droppable without ever entering ancestry. This replaces the
current null-state-only check, which the false-completion incident exploited.
`discard: true` remains the explicit decision to drop the run.

Failure after partial progress keeps the causal-frontier plan's saga honesty:
completed coordinates are ordinary durable history, the typed failure is
primary, progress context is attached, nothing rolls back, nothing
auto-retries `IntegrityFailure` or `ConflictPresent`; the next invocation
re-observes and continues from the live head.

---

## 5. What is kept, strengthened, and deleted

**Kept unchanged** — authoring (edit/move/copy/revert), counteraction, stable
identities, canonical effects, work units, applications, commit and
multi-parent derivation, import, push gating, blame/history/inspect/
neighbors/readMemory, expected-head optimistic concurrency, deterministic
command IDs, atomic zero-residue mutations, strict fact validation, bounded
reads, typed error discipline.

**Strengthened** — the operation layer gains the coverage invariant: every
merge audits that provenance fully explains state (law 1.3). Hunk-composed
content gains real `incorporates` edges with computed range mappings into
both parents; hand-merged content gets honest decision-level linkage instead
of a fabricated mapping. Compare becomes something an agent can read in one
glance.

**Deleted** — transition replay; the change-disposition taxonomy; reconcile
evidence predicates; the dependency graph, frontier, antichain planner, and
demotion pass (never built — the superseded plan is retired before
implementation); the supervisor loop; `DependencyBlocked`; the
`already-satisfied` concept and every workflow step that taught agents to
loop `compare`/`integrate` until complete; the names `vcs.integrate` and
`integrate_subagent`; the old decision row shapes and any code able to read
them; the replay-era reference docs (`compare-and-integrate.md` is replaced,
not annotated). Deletion means deletion: no readers, no aliases, no
tombstoned schema branches, no "legacy" comments pointing at removed
behavior.

---

## 6. Implementation work packages

### WP1 — Merge base, net delta, attribution

`workspace/packages/vcs-engine` (pure) + `semanticWorkspace.ts` wiring.

1. bounded maximal-common-ancestor **set** derivation over the event DAG,
   the §2.1 deterministic primary-base tie-break, and per-aspect
   base-disagreement detection, with tests asserting the honest property:
   base-agreeing coordinates merge identically under any base choice, and
   base-disagreeing aspects never resolve silently — they conflict,
   carrying the disagreeing base values;
2. per-side net delta as fact diff over coordinates and aspects;
3. the spine attribution walk (§2.3): first-parent application chain with
   `undone` marks, expansion through merge decisions into accounted source
   chains only, and a test that work an earlier merge declined or
   superseded never appears in attribution;
4. the coverage invariant with typed coordinate-level failure;
5. unit tests: undo chains, move-away-and-back, delete/restore, copies,
   counteractions, criss-cross bases, attribution across a prior merge.

Exit: every differing aspect in every fixture is fully attributed; the
incident chain yields one content delta attributed to all four changes; a
history with a merge event in it attributes without error.

### WP2 — Merge planner

`semanticWorkspace.ts` + `vcs-engine` (pure; shared by compare and merge).

1. per-coordinate, per-aspect classification (§2.4) including presence
   dominance and orthogonal composition;
2. the deterministic three-way text merge as a pure function, and hunk
   composition as part of classification (§2.5) — core, not optional;
3. structural set validation producing structural conflicts with both
   coordinates named;
4. coupled-group derivation;
5. plan output: at most one normalized fact result per coordinate, each with
   its `changeRef` attribution; typed refusals per §3.2.

Exit: feeding any planner-approved coordinate set to the fact validator never
trips the duplicate/unchanged checks, across all fixtures.

### WP3 — Public contracts

`packages/service-schemas/src/vcs.ts` + schema tests.

1. coordinate-view `vcsCompareResultSchema` (§3.1) with strict aspect and
   attribution schemas;
2. `vcsMergeInputSchema` / result (§3.2), resolution union, typed conflict
   payloads;
3. the intent object with its tier enum (§3.1) and the `intent` argument on
   authoring inputs (§3.5), mapped to the existing `intentSummary`;
4. merge-decision schema with per-coordinate accounting entries;
5. delete the superseded disposition and reconcile schemas;
6. strict-schema tests including malformed combinations and the
   page-invariance of `resolution`/`counts`.

### WP4 — Merge command, decisions, publication

`semanticWorkspace.ts`, `workspaceFactChangeSet.ts` (tests only).

1. `vcs.merge` as one ordinary mutation through `persistWorkingMutation`;
2. decision persistence and coordinate accounting;
3. mapped `incorporates` content edges for hunk-composed results,
   decision-node provenance for hand merges, and blame traversal through
   merge events;
4. the `intents` projection and `composed` review list on compare and merge
   results — the one attribution-to-work-unit join, `split` derivation, and
   the queryable trace: "composed entries of this decision" answers *what
   was mechanically combined and by which intents* from durable state alone.
   **Implement intent resolution as one pure ladder over supplied evidence
   plus one workspace-source loader, with resolved `{ text, tier }` carried
   in every intent-bearing schema** — the planned follow-up
   ([intent-provenance-follow-up.md](intent-provenance-follow-up.md))
   renders the same ladder in read-injected workspace memory, blame, and
   history, and a second acquisition path will drift;
5. **capture evidence at work-unit creation, in this cutover, not later**:
   persist `authorContextId` and — when no intent is stated — a bounded
   `triggerExcerpt` with sender onto the work unit. `dropContext`
   deliberately deletes the context-scoped command journal, so the
   trajectory linkage these derive from has a shorter lifetime than the
   history it explains; capture is unretrofittable after teardown, and
   landing it with this cutover (whose instances are recreated anyway)
   means no instance ever holds uncaptured work. These fields form **one
   evidence class with `intentSummary`**: identical treatment in work-unit
   identity/normalization/integrity, cloning, visibility, publication, and
   lifetime — semantic history, exactly like a stated summary or a commit
   message, with no separate retention regime and no auto-sanitization
   beyond the capture bound (a future redaction need is a general
   semantic-history problem, not an intent-field one);
6. the always-persisted merge decision, including decision-only applications
   for convergent/net-zero merges, and commit's source-parent derivation
   from them;
7. rewrite `assertIntegrationHistoryValid` to state-anchored per-coordinate
   accounting;
8. route external deltas through the same derivation and planner. An
   external delta already owns a real work unit (its changes load through
   `delta.workUnitId` today), so the intents projection needs no special
   case: the delta's declared description is that work unit's summary and
   resolves as `stated` — it is a statement by the registering coordinator,
   which is precisely what the tier means. Nothing is invented and nothing
   is exempted.

### WP5 — Supervisor and protocol

`agent-vessel.ts`, `subagent-runs.ts`, `chat-op.test.ts`,
`references/subagents.md`.

`merge_subagent` per §4 — page loop with the always-at-least-one-merge rule,
a `resolutions` passthrough so a parent can resolve conflicts through the
helper it already holds, fresh `subagent-merge.v1` protocol, status union,
`merged | needs-decision | discarded` run enum, close on
`complete && concluded`, structured partial-failure context, doc rewrite.
Old protocol fixtures are deleted, not kept as regression pins.

### WP6 — Consumer cutover

The atomic cutover is repo-wide, not workspace-source-local. Known consumers
of `integrate`, its dispositions, and its errors (from a working-tree
inventory; the WP re-runs it):

- host service surface: `GadWorkspaceDO.ts`, `packages/service-schemas`
  (`vcs.ts`, `workspaceSource.ts`, `gitInterop.ts`) and every generated
  artifact — public contracts, `hostAuthorityCatalog.generated.ts`;
- agent harness: `workspace/packages/harness` (`workspace-vcs` tool,
  `system-prompt.ts`, and the `edit`/`write`/`move_file`/`copy_file` tool
  schemas, which gain the §3.5 `intent` argument **and lose every
  synthesized `intentSummary` default** — `file-transfer.ts`'s fabricated
  `"Move X to Y"` and any sibling), `agentic-do` (`agent-vessel.ts`,
  `agent-worker-base.ts`);
- userland clients: `workspace/panels/spectrolite/app/semanticVcs.ts`, whose
  `integrateMain` is a full replay-model loop (applicable / satisfied /
  conflicting / blocked buckets) that collapses to paged `merge` calls;
  `workspace/workers/explorer-agent`;
  `workspace/extensions/template-composer/staging.ts`;
- test infrastructure:
  `workspace/skills/system-testing/workspace-repo-fixture.ts` (decodes
  `DependencyBlocked`) and every fixture speaking the old contract.

The write-side intent capture (§3.5) is part of this same atomic change:
the merge surface and its `stated`-tier capture path are one deliverable,
verified together — an authoring call through a harness tool with an
`intent` argument must resolve as a `stated`-tier intent in a subsequent
compare, as a unit test here and end-to-end in WP8.

Every consumer moves to the merge contract in the same change. The gate is
mechanical: repo-wide typecheck plus a grep gate — zero occurrences of
`vcs.integrate`, `integrate_subagent`, `DependencyBlocked`,
`already-satisfied`, `prerequisiteChangeIds`, or the old protocol string
`subagent-integration` anywhere outside this plan's docs. (The retired run
enum value `conflicted` is an ordinary English word and is gated by the
exact-enum schema tests, not by grep; the new intents vocabulary uses
`contested` so the old value stays greppable-dead in code identifiers.) A consumer that cannot
express its need through `merge` is design feedback on `merge`, handled by
widening this plan — not by keeping a private shim.

### WP7 — Agent guidance: the skill docs are part of the product

The skill and reference docs are the agentic experience as much as the tool
schemas are; this WP treats them as a first-class deliverable with the same
no-legacy standard. Two doctrines anchor the rewrite:

- **the merge doctrine**: `compare` (read the intents projection first, then
  the coordinate table) → `merge` → **review the composed checklist —
  conflicts you must decide, composed you must read**: mechanical
  composition asserts textual compatibility only, the agent owns semantic
  compatibility, and `split` intents are reviewed most skeptically →
  resolve conflicts with ordinary edits + resolutions → run the local
  build/typecheck loop → `commit` with an intent summary reflecting what
  was reviewed;
- **the write doctrine**: the one-line `intent` on an edit is not paperwork
  — it is the string a future merger, possibly you, will use to decide
  whether this work can combine mechanically with someone else's; state it
  when the trigger text alone would not explain the change, omit it when it
  would only restate the trigger.

Doc-by-doc scope in `workspace/skills/vibestudio-vcs/`:

1. `SKILL.md` — rewrite the state-model bullets (compare results are
   coordinates and intents, not change dispositions), workflow step 4 (the
   merge doctrine replaces the compare/integrate-loop-until-complete
   doctrine), the public surface list (`merge`, no `integrate`), and the
   finish-deliberately checklist (verify composed coordinates were reviewed,
   not "every requested integration change has a truthful decision");
2. `references/compare-and-integrate.md` — **replaced** by a merge
   reference: coordinates, aspects, the intents projection and tier ladder,
   the composed checklist, conflict resolutions with worked `current` flow,
   coupled groups, pagination as mechanical chunking;
3. `references/authoring-basics.md` — the write doctrine: the `intent`
   argument on `edit`/`write`, when it earns its keep, tier consequences
   ("what you don't state resolves as trigger or mechanical, and a future
   merger sees that");
4. `references/file-move-copy.md` — intent on identity operations; how
   moves surface as placement aspects in merges and compose against content
   edits;
5. `references/revert-counteractions.md` — how counteracted work appears in
   merge attribution (`undone`) and why net-zero work still merges into
   ancestry;
6. `references/semantic-commit.md` — commit's source derivation now includes
   decision-only applications (convergent/net-zero merges); multi-parent
   examples updated;
7. `references/provenance-and-blame.md` — merge decisions as traversable
   provenance nodes, mapped `incorporates` edges from hunk composition,
   decision-level linkage for hand merges, the intent tiers and where each
   comes from;
8. `references/external-snapshot-import.md` — delta review through the
   merge surface; declared-description intent degradation;
9. `references/checks-and-publication.md` — push revalidation in
   state-anchored per-coordinate terms;
10. `references/typed-recovery.md` — recovery for `ConflictPresent`,
    `CoupledGroupIncomplete`, `ScopeTooLarge`, and merge-time
    `RevisionChanged`/`IntegrityFailure`; `DependencyBlocked` recovery
    deleted;
11. `references/scenarios.md` — worked end-to-end scenarios re-authored on
    the new model: a subagent merge with review, a genuine conflict
    resolved via `current` with stated intents, a net-zero child, an
    external delta;
12. `references/public-contract.md` and the `help()` index — regenerated,
    which WP6's generated-artifact sweep already gates.

Adjacent doc surfaces in the same change:
`workspace/packages/agentic-do/references/subagents.md` (WP5), the harness
system-prompt's VCS and authoring sections (WP6 code, this WP's words), and
the authoring tools' own descriptions — the `intent` argument's inline
description is the highest-frequency teaching surface in the system and is
written here, once, to be quoted by the schemas.

**Workspace-wide intent normalization pass.** Agents learn by imitation:
every example in every skill doc is a template a future agent will copy, and
an example that writes without intent teaches omission as the norm. So this
WP sweeps **all of `workspace/skills/`** — all twenty-plus skills, not just
`vibestudio-vcs` — plus the `agentic-do` references, and normalizes every
demonstrated write operation (`edit`, `write`, `move_file`, `copy_file`,
compact `vcs` mutations, and scripted `fs`/runtime authoring in eval
examples) to carry a well-chosen `intent` argument. Known dense surfaces
from the working-tree inventory (the WP re-runs it, grep-driven, over every
`.md` under `workspace/skills/`): `appdev` (SKILL, DEV_LOOP, TARGETS,
CAPABILITIES, MOBILE), `workspace-dev` (WORKFLOW, TOOLS, RPC,
PANEL_DEBUG_LOOP, WORKERS), `extensiondev` (AUTHORING, DEV_LOOP), `sandbox`
(EVAL, RUNTIME_API, INTERACTION_PATTERNS, ACTION_BAR), `templates`
(SKILL, template-authoring, errors-and-remedies), `system-testing`
(scenario-authoring, scenario-catalog), `gad-context`, `onboarding`,
`provenance-orientation` / `provenance-tuning` (which additionally teach
*reading* the tiers), `github`, `memory`, `architecture`.

Normalization rules, applied per example rather than mechanically:

- example intents must be **exemplary** — they demonstrate the write
  doctrine (a purpose the trigger would not reveal), never filler like
  `intent: "edit file"`, which would teach the boilerplate the ladder
  exists to expose;
- normalize where intent adds signal; where the surrounding trigger
  obviously carries the purpose, examples simply omit it — the write
  doctrine already teaches when not to restate, and docs need no
  meta-commentary about their omissions;
- docs that generate or scaffold code which itself authors writes
  (`templates`, `workspace-dev`, `appdev` scaffolds) propagate the norm
  into what they generate — a scaffold that emits intent-less write calls
  re-seeds the old culture in every new app.

Exit criteria: every file above rewritten or consciously verified; the
normalization pass has visited every `.md` under `workspace/skills/` with a
grep-driven inventory of write-operation examples and each is either
intent-bearing or a deliberate, acknowledged omission; the WP6 grep gate
extended over `workspace/skills/` and reference docs (zero occurrences of
deleted names, dispositions, or the loop doctrine); no reference file
describes removed behavior, even as history; and a fresh agent following
only SKILL.md and its references performs the WP8 scenarios without
touching a removed concept — the system test doubles as the docs'
acceptance test, since its agents act on these very docs.

### WP8 — System regression

Headless agentic system test (`pnpm system-test --instance net-effect-merge
...`, fresh managed workspace — `workspace/` changes are source-template
changes and an existing bootstrapped instance will not reread them):

1. the incident scenario: child undo/re-edit chain plus independent file;
   **one** helper call completes it; parent bytes equal child result;
   provenance reaches all four chain changes; close succeeds; rerun reports
   `unchanged`; zero `IntegrityFailure` in the trajectory;
2. a genuine conflict scenario: parent and child edit the same file
   differently, **each side authoring with an `intent` argument through the
   ordinary tools**; the helper returns `needs-decision` whose conflict
   shows both `stated`-tier intents and the source side headlined by the
   spawn task brief; the parent authors a merged result, resolves with
   `current`, closes cleanly.

Scenario 2 is the end-to-end proof that the capture path shipped with the
surface: real agents, real tools, a `stated` tier populated by the
trajectory itself — not by a fixture reaching into the store. If that
assertion cannot pass, the write side did not actually ship, whatever the
schemas say.

---

## 7. Test matrix

### 7.1 Deterministic examples

1. incident chain — one adopt coordinate, full-chain attribution;
2. convergence — both sides make the identical edit; auto-accounted, no
   decision required from the caller;
3. delete-vs-edit, delete-vs-move, both-delete;
4. orthogonal composition — ours edits content, theirs moves the file;
5. structural conflict — different identities created at one path;
6. coupled group — file placed in a source-created repository; subset that
   splits the group refuses with `CoupledGroupIncomplete`;
7. move chains through vacated paths (swap case) — grouped, not ordered;
8. external delta source;
9. criss-cross bases — deterministic primary selection; a coordinate whose
   maximal bases disagree conflicts with the base values surfaced, and
   never silently adopts, keeps, converges, or hunk-composes;
10. `ours` / `current` / `theirs` resolutions and their accounting entries —
    `current` persists a decision entry only, and the head is unchanged;
11. hunk composition — non-overlapping edits to one file compose
    automatically into an authored merge change with mapped `incorporates`
    edges; overlapping hunks and non-text content conflict; the composition
    is byte-deterministic across repeated compares;
12. pagination — coordinate pages with invariant `resolution`/`counts`;
13. net-zero source — a child whose chain nets to nothing merges via a
    decision-only application; commit produces the multi-parent event; the
    child's full story is ancestry-reachable; close verifies cleanly;
14. mixed-aspect coordinate — adoptable placement plus conflicting content
    stays pending as one coordinate until the content aspect resolves;
15. coupled-group poisoning — a group with one conflicted member adopts
    nothing until that member resolves; a group exceeding the page bound
    refuses `ScopeTooLarge`;
16. attribution across a prior merge event — no linearity assumption, no
    `IntegrityFailure`;
17. intents projection — summaries joined from work units on both sides;
    the five `state` values each derived from a fixture (`merged`,
    `settled` via all-`ours`/`current`, `split` on heterogeneous
    dispositions, `contested`, `pending`), page-invariant in every case; an
    external delta resolves through its own work unit with the declared
    description as `stated`;
18. intent ladder — a history authored with `intent` arguments resolves
    `stated`; without them, the same history resolves `trigger` with a
    sender-attributed excerpt, then labeled `mechanical`; no tier is ever
    silently substituted for another; the subagent surface headlines the
    spawn task brief;
19. review surface — the merge result's `composed` list names every
    mechanically combined coordinate with both intents, and the same set is
    recoverable later from the decision's composed entries alone;
20. concluded vs complete — an all-convergent source compares as `complete`
    but not `concluded`; one merge call records the absorb decision and
    concludes it; the supervisor and close accept nothing less;
21. explicit decline — `ours` on a cleanly-adoptable coordinate resolves it
    as declined with full accounting; the remaining source work merges;
    completion holds without adopting the declined coordinate;
22. no synthesized intent — a move/copy authored without `intent` stores no
    summary and resolves `mechanical` (rendered from effects at read time),
    never `stated`; the fabricated-default path is gone from every harness
    tool;
23. intents bounding — a history denser than the intents bound sets
    `intentsTruncated`, truncates strictly lowest-priority-first, and
    reports exact global `intentCounts` regardless of truncation; the
    truncated work units remain reachable through attribution and
    `inspect`;
24. multi-page helper response — a source over the page bound yields a
    `merges` array with one decision per page and a single aggregated
    review surface; a mid-procedure failure reports landed pages plus the
    typed failure;
25. conflict-only source — the helper's mandated first call selects the
    empty mergeable page, persists a decision-only application, returns
    `concluded: true, complete: false` with the full conflict surface, and
    never trips `ConflictPresent`; base-ambiguous conflicts (fixture 9)
    carry their `baseValues` evidence in the public row.

### 7.2 Invariants

For every fixture: coverage — every differing aspect fully attributed to
reachable changes; at most one fact result per coordinate in every plan;
state-anchored accounting — after completion, every differing coordinate is
resolved by an entry naming the coordinate's full attribution;
ancestry totality — after completion the source event is a parent of the
resulting integration event even when the merge materialized nothing; the
low-level duplicate/unchanged validator unreachable from any
planner-approved set.

### 7.3 Merge algebra properties

Property-generate bounded histories (edits, undo chains, moves away-and-back,
delete/restore, copies, interleavings across files and repositories), fork a
target, then assert:

- **partition independence:** merging any partition of coordinates in any
  order equals one full merge (state, decisions' union of accounting, and
  provenance-reachability all agree);
- **idempotence:** re-merging after completion is `unchanged`;
- **completion soundness:** `resolution.complete` ⟺ every source-touched
  coordinate's facts equal the source values or carry a resolving entry;
  `resolution.concluded` ⟺ a reachable decision names the source (or it is
  an ancestor) — and compare alone never flips `concluded`;
- **base honesty:** on generated criss-cross histories, any coordinate
  aspect whose maximal bases disagree ends as a conflict or an explicit
  resolution — never a silent adopt/keep/convergence — and all other
  coordinates merge identically under every base choice;
- **review invariance:** the intents projection and `split`/`contested`
  states for one comparison are identical regardless of which pages have
  materialized, in any order;
- **termination:** compare → merge → resolve reaches completion or a real
  conflict in ≤ coordinates + conflicts steps — no loops.

Generators produce semantic operations only; malformed stored history is
covered by separate corruption tests targeting the coverage invariant.

### 7.4 Supervisor

One-call completion; conflict → needs-decision → resolve → close; close
refusal when a stamped-`merged` run's fresh compare is incomplete;
`source-uncommitted` and `closed` statuses; idempotent replay of a
response-uncertain command; every old-protocol fixture deleted, none kept as
a compatibility pin.

---

## 8. Rollout

Pre-release internal change; no compatibility surface anywhere, and no code
that can read the old model.

- Replace the compare schema, the merge command, the decision shape, and the
  supervisor protocol atomically across workspace-source consumers; no
  dual-write, no aliases (`conflicted`, `integrate`, `integrated`, old
  dispositions all gone in one change).
- **No legacy readers, and no half-preserved instances.** Old-model
  integration decisions are durable semantic facts woven into work units,
  applications, integration events, and publication revalidation; keeping
  the surrounding history while deleting the only code that can interpret
  those decisions would leave ancestry unverifiable — the worst of both
  worlds. So the rule is whole or nothing: **every instance bootstrapped
  before the cutover is recreated from scratch**, through the ordinary
  workspace lifecycle (which handles context, subscription, and provider
  teardown — no surgical row deletion that bypasses it). This includes the
  incident developer instance. Pre-release instances are disposable by
  definition; a single reader kept alive for one of them would be the only
  legacy code in the system, so it does not exist.
- The claim "authoring history needs no migration" is therefore a statement
  about **schemas, not instances**: change/application/event shapes are
  untouched and no migration code exists — because nothing new-model ever
  reads a pre-cutover instance at all.
- Fresh managed system-test workspaces are mandatory anyway: `workspace/`
  changes are source-template changes and a bootstrapped instance will not
  reread them.
- Retire `docs/subagent-integration-causal-frontier-plan.md` with a
  superseded pointer to this plan.

Instrumentation (counters only, no semantic state): merges by source kind and
outcome, conflict counts by aspect kind, resolution kinds chosen, coverage
violations (must be zero), coupled-group refusals, and low-level
duplicate-identity refusals reached from `vcs.merge` — the last must be zero;
nonzero means the planner contract is false or a mutation path bypasses it.

---

## 9. Explicit non-goals

- no time-linear replay of source transitions, ever, for any caller;
- no mutable merge session, pending tree, or checkpoint ledger;
- no dependency graph, frontier, or joint-composability planning;
- no automatic semantic resolution beyond aspect orthogonality and
  deterministic hunk composition;
- no inferred declines — every `ours`/`current` is an explicit decision;
- no weakening of fact integrity checks;
- no rebase or history rewriting — merges add ancestry, never edit it;
- no path strings as substitutes for stable identities;
- no helper-specific merge logic in the supervisor;
- no compatibility aliases, dual protocol versions, legacy readers,
  migration shims, or deprecated-but-present names;
- no behavior flags that duplicate one good default (`onConflict` and
  `contentMerge` were cut from this plan's own first draft for this reason).

---

## 10. Acceptance criteria

1. One merge engine serves cross-context integration, subagent integration,
   external deltas, and publication revalidation, with one public contract.
2. A merge produces at most one result per stable coordinate by
   construction; the low-level duplicate-state validator is unreachable from
   any planner-approved set in unit, property, and system tests.
3. The coverage invariant holds on every merge — every differing aspect is
   fully attributed via recorded provenance edges, across any ancestry shape
   including prior merges; violations surface as typed `IntegrityFailure`
   naming coordinates.
4. Full provenance is retained: state-anchored accounting resolves every
   differing coordinate with its full attribution, undone
   intermediates included; every merge — convergent-only and net-zero merges
   too — persists a decision and enters ancestry as a source parent at
   commit; adopted values realize their exact source changes; hunk-composed
   content carries mapped `incorporates` edges into both chains; hand-merged
   content is decision-linked without a fabricated mapping; blame traverses
   merge events into source history.
5. Convergent work completes with no caller ceremony; completion is
   per-coordinate and state-anchored, conclusion requires a recorded merge
   decision, and `complete && concluded` is the only success signal the
   supervisor and close consume — compare alone can never conclude a merge.
6. Conflicts are reported with coordinates, aspects, base/ours/theirs values,
   both attributions, and a closed resolution set; no refusal requires graph
   forensics; no message directs an agent toward a rejected action.
7. Any coordinate partition respecting coupled groups merges to the same
   result as one full merge, and the review surface (intents, `split`,
   counts, resolution) is identical for one comparison regardless of page
   order — pagination is free at both the fact and the review layer.
   Where maximal common ancestors disagree on an aspect, the merge never
   resolves silently: base ambiguity is always an explicit conflict.
8. `merge_subagent` is a bounded idempotent procedure — one merge call in
   the common case, mechanical page calls beyond the bound, always at least
   one — with the complete status union of its fresh v1 protocol; no close
   ever trusts the stored run projection over a fresh comparison.
9. The incident scenario completes in one helper call with full provenance
   and clean closure; the same-file conflict scenario resolves through an
   ordinary authored merge plus one resolution.
10. Agent guidance teaches exactly one workflow — compare → merge → review
    composed → resolve → verify → commit — and the review step is fed by the
    system, not left to diligence: every compare/merge result carries the
    intent-shaped overview (intents projection, `split` flags, composed
    checklist with both sides' intents), so surveying what merged
    mechanically costs one read and digging deeper starts from named work
    units, not raw bytes. Intent resolves through the explicit ladder with
    its tier always visible — `stated` intent captured by the write-side
    `intent` argument, degrading honestly through trigger evidence
    to labeled `mechanical`, never fabricated. All of it is signal; none of
    it gates. The full skill-doc surface (WP7's twelve-file scope plus the
    subagent guide, system-prompt sections, and tool descriptions) teaches
    the new model and nothing else; a fresh agent acting from the docs
    alone completes the WP8 scenarios without touching a removed concept.
11. The cutover is repo-wide and total: every consumer — host service,
    harness, panels, extensions, agents, test infrastructure, generated
    contracts and catalogs — speaks the merge contract, and the grep gate
    finds zero occurrences of the deleted names outside plan documents.
12. The write-side intent capture ships in the same change as the surface
    that consumes it: every authoring tool accepts `intent`, guidance
    teaches it, and the headless system run proves the loop — an intent
    stated through an ordinary tool by a real agent trajectory resolves as
    `stated` in the merge review another agent reads. The plan is not done
    while the ladder's top tier is unpopulatable.
13. Intent is the documented norm workspace-wide: every write-operation
    example across all skills in `workspace/skills/` carries an exemplary
    `intent` or an acknowledged deliberate omission, and scaffolding docs
    propagate the norm into generated code — no doc teaches intent-less
    writing by imitation.
