# Merge Driver & Subagent DX Plan

**Status:** planned · 2026-08-08 · **v3** (two adversarial review rounds;
all findings verified against code and incorporated)
**Goal:** one merge procedure with multiple thin ergonomic entry points; a
self-sufficient merge result; guardrails that make the wrong path fail early
and coherently; direct subagent file inspection; comprehensive skill-doc
updates. Ships as **one atomic cutover** — no parallel paths, no deferred
scope.

Every current-state claim below was verified against the code on
`workspace-templates`; line references are anchors, not gospel — re-locate by
symbol if they drift.

---

## 0. Verified current state

### 0.1 The engine already computes what the wrappers re-derive

`SemanticWorkspace.merge` (`workspace/workers/workspace-source/semanticWorkspace.ts`)
performs **two full comparison builds per call**:

- a planning comparison to select up to 500 coordinates (`:2422`), and
- a post-merge comparison (`:2902`) whose projection already feeds the public
  result: `resolution`, `intents`, `composed`, `outcomes` are all returned
  today (`vcsMergeResultSchema`, `packages/service-schemas/src/vcs.ts:1279`).

What the public merge result does **not** carry: `counts`, `intentsTruncated`,
a bounded page of unresolved conflict coordinates, and a review cursor. That
is the entire gap — exposing them is projection work on a comparison the
engine already paid for.

### 0.2 `merge_subagent` wraps every merge in redundant compares

`mergeSubagent` (`workspace/packages/agentic-do/src/agent-vessel.ts:6318`):

1. `compare` before the loop (source headline + already-concluded check).
2. Per iteration: `merge`, then `compare` again to decide whether to continue.
3. After the loop: **exhaustively pages every remaining conflict page**
   (`while (conflictCursor)` at `:6416`), unbounded.

A one-page clean merge costs **at least** 4 full comparison builds
(2 engine-internal + 2 wrapper) — host content reads can force continuation
passes that repeat the planning comparison, so the real count is often higher.
Multi-page or conflicted sources cost more still, plus the exhaustive conflict
drain. F1's separate engine-internal vs. wrapper counters make the true
number observable.

### 0.3 Merge termination semantics (corrected in v2)

Two distinct engine behaviors at the empty-selection boundary, and only one of
them is a problem:

- `selected.length === 0 && comparison.concluded` → **throws**
  `SemanticVcsError("NoEffect")` (`:2592`). This is the genuine no-effect
  case, and the throw is the DX problem: any "merge first, don't compare"
  design hits it on the common already-merged re-entry.
- `selected.length === 0 && !comparison.concluded` (conflict-only source) →
  falls through and persists a **decision-only merge application** with empty
  entries. This is **intentional and load-bearing**, documented in
  `workspace/skills/vibestudio-vcs/SKILL.md:45`: a source with only conflicts
  still needs a reachable merge decision to become concluded, name the source
  in commit ancestry, and distinguish "review began" from "never considered".
  It must be preserved exactly as-is. (v1 of this plan wrongly flagged it as
  a possible bug.)

### 0.4 Resolution selection semantics (corrected in v2)

Caller-supplied `resolutions` are **force-selected into the first merge page**
(`:2473-2492`), regardless of where paging would otherwise place those
coordinates. Re-passing a resolution for an already-resolved coordinate throws
`InvalidReference` ("not pending"). Therefore the wrapper's current
first-attempt-only behavior is **correct** for explicit per-coordinate
resolutions, and the driver must preserve it. (v1 wrongly called this a
latent later-page bug.)

The real gap is different: there is no way to express a **whole-remaining-
source** decision without enumerating every coordinate. That needs first-class
engine semantics (G2), not replayed resolution lists.

### 0.5 Three integration paths, three hand-rolled loops, two renderers

| Path | Site | Paging | Renderer |
|---|---|---|---|
| Ordinary agent VCS tool | `workspace/packages/harness/src/tools/workspace-vcs.ts:322` | **none** — single `vcs.merge`, model must loop by hand | `mergeText` (`:208`) |
| Subagent integration | `agent-vessel.ts:6318` | compare-sandwiched drain + exhaustive conflict scan | `subagentMergeReviewText` (`:266`) |
| Main integration (explorer agent; surfaced by the Spectrolite panel) | `workspace/workers/explorer-agent/index.ts:474-510` | compare-first, **refuses before any mutation if any conflict exists**, then drains clean pages and commits | ad-hoc error text |

The explorer's all-or-nothing preflight is a deliberate safety rule for
protected-main publication: it must never mutate the publication context when
conflicts exist. The shared driver must reproduce this policy exactly (§3),
not approximate it with a post-drain abort.

### 0.6 `inspect_subagent` path reads scan the workspace

The path branch (`agent-vessel.ts:6236-6290`) pages `neighbors` (500/page) over
the entire working state to enumerate repositories, `inspect`s each, then pages
`listFiles` (500/page) per repository to find one file. Meanwhile the direct
resolver already exists: `resolveToolFile`
(`workspace/packages/harness/src/tools/tool-vcs.ts:109`) does
`splitRepoPath → resolveRepository → readFile({kind:"path"})` and takes a
structural `Pick<ToolVcs, "resolveRepository" | "readFile">`. `splitRepoPath`
itself already lives in the shared runtime package
(`@vibestudio/shared/runtime/entitySpec`) — only the resolver helpers need
extraction, and both surfaces already build the identical typed client over
`vcsMethods` (`agent-vessel.ts:304`).

Also: in the `diff` branch the child status is fetched before the branch
dispatch and the parent status inside it — serial for no reason
(`agent-vessel.ts:6193`, `:6200`).

### 0.7 Field evidence: the 2026-08-08 Trello-app trace

A live run (external GPT-5.6 Sol agent, "Build Trello-Style Task App") showed
that the dominant DX failure is not the cost of the right path but the **shape
of the wrong path**. Reconstructed sequence:

1. The model hand-retyped three completed child reviews into the parent
   ("manually composed"), then called `merge_subagent` ×3 as a bookkeeping
   stamp. Hand-retyped content has different change coordinates than the
   children's committed changes → conflicts, not convergent.
2. Those partial merges landed durable merge decisions in the parent working
   chain, silently creating an integration obligation. `VcsStatusResult`
   carries no integration-debt field; nothing surfaced it.
3. The model "resolved" the conflicts with `close_subagent({discard: true})`
   ×3. The discard path **skips the integration-completeness precondition
   entirely** (`agent-vessel.ts:6577` — the whole check lives inside
   `if (!shouldDiscard)`) and records a ledger label without any engine-side
   accounting.
4. Commit refused: `IntegrationIncomplete` (`semanticWorkspace.ts:3345`)
   derives integration sources from the working chain and requires every
   coordinate resolved/convergent. Discarding the child does not retract the
   debt. Two authorities disagreed: ledger said "discarded, done"; engine said
   "incomplete, refused".
5. With the children closed, `merge_subagent` was unavailable; recovery took
   ~25 calls of event-ID archaeology (`inspect_subagent` log ×3), raw
   `vcs compare`/`vcs merge` with hand-built per-coordinate resolution lists,
   and several failed attempts — everything one prescriptive error message
   could have routed in two calls.
6. End state: engine concluded and committed; durable ledger still showed
   `integration=pending` (raw VCS merges never update the run projection).
7. Throughout: `read_subagent` polled ×6 despite each result saying "Stop
   polling now" in red.

Diagnosis: **not a docs problem.** `references/subagents.md` explicitly
forbids manual replay (":74") and prescribes the direct call (":10"); the
model's own narration used the doc's vocabulary while violating it, and
in-result advisory prose was ignored six consecutive times. The fixes must be
structural — early signals, coherent gates, prescriptive refusals — and are
WP-G (§8).

---

## 1. Design principles (binding)

- Keep `merge_subagent({ runId })` as a thin adapter. No verbose generic
  source selector for the common case.
- Never require inspect/compare before merge (the explorer's conflict-free
  preflight is an internal publication-safety policy, not a model-facing
  requirement).
- Never auto-close the child, auto-commit, or auto-publish from the driver.
- No `auto` / `deep` / `inspectFirst` behavioral flags.
- Keep fresh merge-source verification (exactly one fresh child status per
  merge call); close performs its own separate fresh verification.
- Keep the 500-coordinate durable decision pages and partial-progress honesty;
  page orchestration lives **above** the engine, never inside one transaction.
- A conflict is never resolved implicitly. Resolutions — including
  whole-remaining-source ones — are explicit decisions with explicit kinds.
- `ours` and `current` are **not aliases**: `ours` explicitly declines the
  source coordinate; `current` asserts the parent's presently authored state
  truthfully combines or supersedes the source. Both are recorded distinctly
  in decision entries (the engine already does this, `:2630`); every surface
  preserves the distinction.
- Semantic integration state and lifecycle disposition are **separate axes**
  (G5). Neither is ever inferred from the other.
- Completed pages survive a later page's failure and are visible in the result.
- No caching without exact source+target state keys (deferred anyway, §7.3).
- One procedure means one procedure: the cutover deletes the old loops and
  renderers in the same change that lands the driver. No parallel paths.

---

## 2. WP-A — Engine: self-sufficient merge result + structured no-op

**Files:** `workspace/workers/workspace-source/semanticWorkspace.ts`,
`packages/service-schemas/src/vcs.ts`.

### A1. `VcsMergeResult` becomes a discriminated union

`vcsWorkingMutationResultSchema` requires mutation identities
(`workUnitId`, `applicationId`, `changeIds`, …) that an unchanged result does
not have; nulling `decisionId` alone would leave it structurally pretending to
be a mutation. Model it honestly:

```ts
export type VcsMergeResult =
  | ({
      status: "working";
      decisionId: string;
      outcomes: VcsMergeCoordinate[];        // existing
      resolution: VcsMergeResolutionState;   // existing
      intents: VcsIntentProjection[];        // existing — final global projection
      intentsTruncated: boolean;             // NEW (compare already exposes it)
      composed: VcsComposedReview[];         // existing
      counts: VcsMergeCounts;                // NEW — global post-merge counts
      conflicts: VcsMergeCoordinate[];       // NEW — bounded, conflict-only
      nextConflictCursor: string | null;     // NEW — see cursor contract below
    } & VcsWorkingMutationResult)
  | {
      status: "unchanged";
      contextId: string;
      workingHead: VcsStateNodeRef;
      resolution: VcsMergeResolutionState;
      counts: VcsMergeCounts;
      intents: VcsIntentProjection[];
      intentsTruncated: boolean;
      conflicts: VcsMergeCoordinate[];
      nextConflictCursor: string | null;
    };
```

All new fields are projected from the post-merge comparison the engine already
builds at `:2902` (for `working`) or the planning comparison (for
`unchanged`). `intents` is the **final** global projection — never aggregated
across pages, which would retain stale pending/split states.

**Cursor contract (one exact sequence).** Filtered and unfiltered pagination
walk different sequences; a cursor valid in both would invite skipped or
duplicated coordinates. Therefore:

- `vcs.compare` gains an optional `statusFilter: "conflict"` input. The
  filter is applied **before** pagination — pages are bounded counts of
  *matching* coordinates in canonical coordinate order. `counts` remain
  global regardless of filter (they are computed on the full comparison
  before output paging, as today).
- Every cursor's basis includes `(target, source, statusFilter)`. A cursor is
  valid **only** for a continuation call with the identical basis; the engine
  rejects a basis mismatch as `InvalidReference` rather than silently
  re-anchoring.
- The merge result's conflict page and `nextConflictCursor` belong to the
  filtered sequence: the cursor is valid only for
  `vcs.compare({ target: result.workingHead, source, statusFilter:
  "conflict", cursor })`. One coherent sequence from merge result through
  every continuation page.

### A2. The concluded no-effect case returns `unchanged` instead of throwing

Replace the `NoEffect` throw at `:2592` (the
`selected.length === 0 && comparison.concluded` case **only**) with the
structured `unchanged` result above. No decision persisted, no
materialization queued. The engine has the comparison in hand; the review is
free.

**Preserved exactly:** the decision-only merge for
`selected.length === 0 && !comparison.concluded` (conflict-only sources).
That application establishes conclusion and commit ancestry and is
intentional (§0.3). It returns a normal `working` result whose `counts` show
zero mergeable and whose `conflicts` page is populated.

Note `unchanged` does **not** imply success: a previously established
decision can be concluded while conflicts remain unresolved. Consumers branch
on `resolution.complete`, not on `status` (§3 B2 step 2).

Compatibility: grep for RPC-level catchers of merge-path `NoEffect` and
migrate them in the same cutover; `NoEffect` remains for other operations.

### A3. Resolution semantics unchanged; whole-remaining form added at engine level

Per-coordinate resolutions keep today's semantics: force-selected into the
first page, error if not pending. The new whole-remaining-source form (G2) is
implemented **in the engine's selection step**, not by replaying lists:

```ts
resolutions: {
  allRemaining: {
    resolution: "ours" | "current";
    rationale?: string;   // REQUIRED for "current", optional for "ours"
  }
}
```

**`allRemaining` means all remaining — literally.** The stated resolution
applies to **every unresolved coordinate**, whatever its status: conflict,
adopt, composed, and convergent alike. This is directly implementable — the
engine already exposes `ours` and `current` as available resolutions for
every unresolved status (`:7503-7506`); only `resolved` coordinates are
excluded. Anything weaker (resolving conflicts while clean coordinates merge
normally) would silently adopt the clean remainder under an "ours" blanket —
the opposite of "decline the remainder" — and would break the G1 abandonment
semantics after, e.g., a partial failure that leaves both clean and
conflicting coordinates outstanding.

**Selection algorithm (specified now, not an open item):**

1. Canonical coordinate ordering — the same order the comparison already
   uses.
2. Select the first bounded prefix of unresolved **whole groups** (the
   existing group-integrity rule at `:2494-2552` applies; a group that would
   cross the bound defers whole to the next page).
3. Maximum 500 selected coordinates total, as with any merge page.
4. The blanket resolution applies to **every selected coordinate**; nothing
   in the selection merges "normally" under a blanket.
5. The driver drains pages until concluded, like any multi-page merge.

**Rationale.** Whole-source `current` is a strong semantic claim ("the
parent's present state truthfully combines or supersedes the source") — a
`rationale` is required and recorded on each decision entry (the engine
already stores per-resolution rationales, `:2887`). `ours` accepts an
optional rationale; `merge_subagent`'s abandonment path supplies a standard
one. Decision entries record the explicit kind per coordinate; provenance
distinguishes "declined the source" from "current state supersedes it" (§1).

### A4. Tests

- One-page clean merge: `working`, correct global counts, empty conflicts.
- Already-merged source: `unchanged`, no new decision row, no materialization,
  head untouched; a repeat call is idempotent.
- Conflict-only source, first call: `working` **with** a persisted
  decision-only application (regression for §0.3 — this must not become
  `unchanged`), concluded resolution, populated conflict page.
- Conflict-only source, second call: `unchanged` with
  `resolution.complete === false` — the consumer-facing needs-decision case.
- Multi-page source: `counts` are global-remaining, not page-local.
- `allRemaining` with `"ours"` and `"current"` records distinct decision
  kinds; multi-page blanket concludes across pages; per-coordinate
  resolutions still error when re-passed after resolution.
- `allRemaining: {resolution: "ours"}` on a source with clean **and**
  conflicting coordinates outstanding declines every one of them — no clean
  coordinate is adopted (the literal-semantics regression).
- `allRemaining` with `"current"` and no rationale is rejected.
- Group integrity: a group crossing the 500 bound defers whole; the blanket
  concludes it on the following page.
- `statusFilter: "conflict"` compare paging returns only conflicts, with
  global `counts`, in canonical order; a cursor presented with a mismatched
  `(target, source, statusFilter)` basis is rejected as `InvalidReference`.

---

## 3. WP-B — Shared driver: `driveMerge`

**New module** in a neutral package reachable by harness, agentic-do, and the
explorer worker (decide the home at implementation time; no vessel or DO
imports; must not know what a subagent is).

### B1. Signature

```ts
interface DriveMergeInput {
  vcs: Pick<ToolVcs, "merge" | "compare">;
  contextId: string;
  expectedWorkingHead: VcsStateNodeRef;
  source: VcsMergeSource;
  coordinates?: VcsMergeCoordinateRef[];     // explicit single-page selection
  resolutions?: VcsMergeInput["resolutions"]; // per-coordinate or allRemaining
  intentSummary?: string;
  commandIdForPage: (page: { expectedWorkingHead: VcsStateNodeRef }) => string;
  policy?: "merge-clean" | "require-conflict-free";
}

interface DriveMergeResult {
  status: "working" | "unchanged" | "needs-decision";
  initialWorkingHead: VcsStateNodeRef;
  workingHead: VcsStateNodeRef;
  merges: VcsMergeResult[];   // every completed page, preserved on failure
  review: MergeReview;        // aggregated projection (§4)
}
```

Two internal policies, neither model-facing:

- **`merge-clean`** (default; ordinary tool + subagent integration): merge
  immediately, drain clean pages, return `needs-decision` when conflicts
  remain.
- **`require-conflict-free`** (protected-main publication): one read-only
  preflight `vcs.compare({ statusFilter: "conflict" })`; if the global
  conflict count is nonzero, throw **before any mutation**, with the
  returned page as the error's conflict evidence. The filtered preflight
  keeps the one-compare budget while guaranteeing the error packet actually
  contains conflicts even when they fall late in canonical coordinate order.
  This reproduces the explorer's all-or-nothing safety rule exactly (§0.5) —
  a post-drain abort would leave the publication context mutated, which is a
  materially different recovery story.

### B2. Algorithm (`merge-clean`)

0. **Explicit `coordinates` short-circuit:** when the caller supplies an
   explicit coordinate selection, the driver issues exactly **one**
   `vcs.merge` and returns its classification. It never continues into
   unrequested coordinates — global mergeable counts are ignored. This is
   what makes D2's single-page passthrough true rather than aspirational.
1. Otherwise issue `vcs.merge` immediately. Per-coordinate `resolutions` go
   on the **first page only** — the engine force-selects them there (§0.4).
   An `allRemaining` blanket goes on **every** page (its engine semantics are
   per-page, §2 A3). `intentSummary` goes on **every** page: the intent
   describes the whole procedure, and each page's work unit records it —
   later pages must not degrade to mechanical-trigger evidence.
2. Classify the result:
   - `working` and global counts show mergeable remaining → next page.
   - `resolution.complete` (any status) → done: `working` if the head moved,
     else `unchanged`.
   - `!resolution.complete` and no mergeable remaining → `needs-decision` —
     **including when `status === "unchanged"`**: a concluded-but-conflicted
     source is unresolved work, not success.
3. Aggregate `composed` across pages (keyed by coordinate). `intents`,
   `counts`, `conflicts`, `nextConflictCursor` come from the **final** result
   only.
4. Progress invariant: if a page returns `working` with an unmoved head and
   undecreased global mergeable counts, throw an integrity error. No clocks,
   no attempt caps — progress-based termination only.
5. On a mid-loop failure, throw a typed `MergeDriverError` carrying the
   completed `merges` and the last review; verify the tool-error
   serialization path actually surfaces those fields to the model (arbitrary
   properties on `Error` do not reliably survive; add an explicit
   `errorData` projection like the existing typed VCS errors).
6. The driver never calls commit, push, discard, or close. Ever.

### B3. Command identity

`commandIdForPage` must digest the **complete semantic request**: contextId,
expected working head, source, explicit coordinates, resolutions (including
blanket form), and intent. No attempt counter — retrying after partial
progress renumbers attempts and would fork identities; the expected working
head already uniquely identifies a page's position in the chain. (This is the
existing `subagentVcsCommandId` scheme, extended with coordinates + intent.)

### B4. Tests

- One-page clean: exactly 1 `vcs.merge`, 0 `vcs.compare` (spy on the `vcs`
  argument).
- N clean pages: exactly N merges, 0 compares.
- Already merged: 1 merge, `unchanged`.
- Concluded-but-conflicted: returns `needs-decision`, not `unchanged`.
- Conflicts under `merge-clean`: clean pages drained, bounded conflict review,
  no exhaustive paging.
- Explicit `coordinates` with more mergeable work outstanding globally:
  exactly 1 merge, driver returns without continuing.
- `require-conflict-free` with a conflict: exactly 1 filtered `vcs.compare`,
  0 `vcs.merge`, context unmutated, conflict page present in the error.
- `require-conflict-free` clean: 1 preflight compare + N merges.
- Blanket `allRemaining` concludes a multi-page conflicted source.
- Mid-loop failure: `MergeDriverError` carries completed pages **through the
  tool serialization boundary** (assert on the serialized form).
- Same request → same per-page command ids across a retry after partial
  progress.

---

## 4. WP-C — One review projection and renderer

**Files:** new `MergeReview` type next to the driver;
`workspace-vcs.ts:208` (`mergeText`), `agent-vessel.ts:266`
(`subagentMergeReviewText`), explorer error text — all deleted in the cutover.

### C1. Projection

```ts
interface MergeReview {
  headline: string;                    // supplied by the adapter
  sourceHeadline?: string;             // e.g. subagent delegated-task trigger intent
  resolution: VcsMergeResolutionState; // global completion/conclusion
  counts: VcsMergeCounts;
  intents: VcsIntentProjection[];      // final projection, both sides, split warnings
  intentsTruncated: boolean;
  composed: VcsComposedReview[];       // aggregated across pages
  conflicts: VcsMergeCoordinate[];     // bounded, filtered sequence
  nextConflictCursor: string | null;   // basis-bound, see §2 A1
}
```

`sourceHeadline` comes from the final merge result's `intents` (the `theirs`
trigger tier) — no extra compare.

### C2. Renderer

One `renderMergeReview(review): string` used by all three surfaces. Always
shows: global completion + conclusion, source/target intents (with an explicit
truncation note when `intentsTruncated`), split-intent warnings, composed
coordinates, bounded conflicts, and — when `nextConflictCursor` is non-null —
the exact continuation call
(`vcs compare --source <…> --status conflict --after <cursor>`). Adapters
decorate (runId, delegated-task headline) without changing semantics. The UI
keeps its "Merge Subagent" label; the expanded result renders the shared
review.

---

## 5. WP-D — Rewire the three call sites (atomic)

All three consumers cut over in the same change that lands the driver;
`mergeText`, `subagentMergeReviewText`, and the hand-rolled loops are deleted
in that change. No transition period, no parallel paths.

### D1. `merge_subagent` (`agent-vessel.ts:6318`) becomes a thin adapter

1. Resolve + authorize `runId` (unchanged).
2. Fresh child + parent status via `Promise.all` (unchanged — this remains
   the single merge-source verification; it also refreshes the run row's
   retained `sourceEventId` per G5).
3. Reject uncommitted child work (unchanged).
4. `driveMerge` (`merge-clean`) with the extended command-id digest and caller
   resolutions (per-coordinate or `allRemaining`).
5. Update lifecycle disposition + persist the integration snapshot on the run
   row (G5), touch the run.
6. Render via the shared renderer with runId + delegated-task decoration.

### D2. Ordinary `vcs merge` operation (`workspace-vcs.ts:322`)

Route through `driveMerge` (`merge-clean`) so a multi-page clean merge
completes in one tool call. Per-page command ids derive from
`toolCommandId(context)` + the full B3 digest. Explicit `coordinates` remain a
single-page passthrough. The tool schema gains the `allRemaining` resolutions
form and the compare `statusFilter`.

### D3. Explorer main integration (`explorer-agent/index.ts:474-510`)

Replace the hand-rolled loop with `driveMerge({ policy:
"require-conflict-free" })`. Identical safety semantics: refuses before any
mutation when conflicts exist; the abort error carries the bounded conflict
page instead of today's exhaustively-paged list. The commit that follows stays
in the explorer.

---

## 6. WP-E — Subagent inspection fixes

**Files:** `agent-vessel.ts:6180-6310`, `tool-vcs.ts`, shared module.

### E1. Extract the direct path resolver

Move `resolveToolRepository` / `resolveToolFile` into the shared module
(`splitRepoPath` already lives in `@vibestudio/shared` — it does not move).
Cut all consumers over directly; no compatibility re-exports.

### E2. Replace the path-branch scan

`inspect_subagent` with a path query becomes: child status →
`resolveToolFile(vcs, status.workingHead, path)` → file (or the resolver's
prescriptive `InvalidReference`). **Accepted behavior change:** bare,
repo-unprefixed paths no longer resolve; paths must be repo-prefixed like
every other VCS surface. No scan fallback. Tool description updated.

### E3. Parallelize the diff branch

Parent and child status via `Promise.all` (`agent-vessel.ts:6193/:6200`).

### E4. Tighten the tool description

> Inspects a supervised child's runtime or semantic workspace state; it never
> exposes the model's private context window.

Query semantics: `status` = supervision + child cleanliness; `diff` = shared
VCS compare vs. parent; `log` = shared history from the child event; path =
shared state-relative file read (repo-prefixed); `runtime` = external-agent
diagnostics only.

---

## 7. WP-F — Instrumentation and acceptance

### F1. Structured timings

Spans (counts and durations only — no paths, content, prompts, event IDs, or
trajectory data): run resolution; authorization; semantic dispatch; merge
**planning** comparison; **post-merge** comparison (engine-internal
comparisons reported separately from wrapper-issued ones — otherwise WP-A/B
look "done" while p95 stays comparison-bound); host content reads;
continuation planning; materialization; effect ack; wrapper total; per-call
counts of `vcs.merge` and `vcs.compare`.

### F2. Structural acceptance targets

| Scenario | Target |
|---|---|
| One-page clean subagent merge | 1 `vcs.merge`, 0 wrapper `vcs.compare` |
| Each additional clean page | +1 `vcs.merge`, still 0 compares |
| Already-merged re-entry | 1 `vcs.merge` (`unchanged`), 0 compares |
| Conflict review | bounded page + filtered compare continuation; no exhaustive scan |
| Protected-main publication, conflicted | 1 filtered compare, 0 merges, context unmutated |
| Child file inspection | 0 `neighbors`, 0 `listFiles` |
| Merge source verification | exactly one fresh child status per merge call (closure performs its own separate fresh verification at close time) |

### F3. Only then: engine comparison surgery

Two engine-internal comparison builds per merge survive this plan. If p95
remains comparison-dominated after the cutover, the next levers are caching
immutable source-side analysis keyed by source event id and avoiding repeated
source-lineage reconstruction — exact state keys only. Out of scope here.

---

## 8. WP-G — Guardrails and reconciliation (from the §0.7 trace)

The §0.7 failure was shape-of-the-wrong-path. These items make the wrong path
fail early, coherently, and with a road back. Prose demonstrably did not steer
the model; every fix is structural.

### G1. Close/discard coherence with the commit gate (priority — correctness)

**Defect:** `close_subagent({discard: true})` skips the integration
precondition (`agent-vessel.ts:6577`) and stamps a ledger label with no
engine-side accounting; the commit gate then still refuses. "Discarded" and
"IntegrationIncomplete" can be simultaneously true.

**Fix — no hidden mutations in lifecycle teardown; refuse with the exact way
out instead:**

- `discard: true` stays legal **only while the child's source event has never
  entered the parent working chain** (no merge decision references it).
  Nothing to account; the label is truthful.
- Once integration has begun, discard-close **refuses** with a prescriptive
  error naming the two explicit finishes:
  `merge_subagent({runId, resolutions: {allRemaining: {resolution: "ours"}}})`
  to decline the remainder (the adapter supplies a standard abandonment
  rationale), or `{allRemaining: {resolution: "current", rationale: …}}` when
  the caller asserts the parent's current state is the reviewed combined
  result. Because `allRemaining` is literal (§2 A3), "decline the remainder"
  declines clean coordinates too — abandonment never silently adopts. After
  either, close proceeds normally as semantically concluded.
- A workspace mutation never hides inside `close_subagent`. The extra call on
  this path is a feature: it makes the abandonment decision explicit,
  first-class, and provenance-recorded with the correct kind — and it only
  ever occurs on an already-misused path.

Invariant: **close never strands debt, and close never mutates the
workspace.**

### G2. Whole-remaining-source resolution (engine-level)

The `allRemaining: {resolution: "ours" | "current", rationale?}` form
specified in §2 A3 — literal all-remaining semantics across every unresolved
status, required rationale for `current`, exposed through `vcs merge` and
`merge_subagent`. Distinct provenance kinds, whole-group bounded selection,
driver-drained to conclusion. No blanket `"theirs"`: adopting unseen content
wholesale stays per-coordinate.

### G3. Integration debt is visible the moment it exists — one read model

Full `mergeComparison` per source on every `vcs.status` call is
disqualified: status is the working-head resolver for reads, edits, merge
pages, and prompts — pervasive comparisons would invert the latency goal.
Instead the engine **maintains the integration projection incrementally**,
since it already computes exactly this at every decision-persist. This
projection is the **single read model** for integration state everywhere —
status, runtime prompt, run details (G5 reads it too; nothing rebuilds
comparisons at read time):

- On each merge decision persist, store/update a per-context row from the
  post-merge comparison already built at `:2902` — O(1) on top of it:

  ```ts
  {
    source,
    remainingCoordinateCount,
    mergeableCoordinateCount,   // adopt + composed + convergent remaining
    conflictCoordinateCount,
    concluded,
    asOfWorkingHead,
  }
  ```

- The row classifies the source without any further comparison:
  - **unattempted** — no row exists (no decision ever referenced the source);
  - **integrating** — mergeable coordinates remain;
  - **needs-decision** — conflicts remain and no mergeable coordinates do;
  - **complete** — zero remaining and concluded.

  Four states, not three: a source can be concluded while still conflicted,
  or have clean pages left after an interrupted procedure — the counts
  distinguish these where a bare label cannot.
- `vcs.status` returns the rows verbatim as `integrating: Array<Row>` — an
  O(1) read, no comparison builds. When `asOfWorkingHead` differs from the
  current working head, the row is reported **stale** ("as of your last merge
  decision") — never presented as live debt, never auto-recomputed inside
  ordinary status. The commit gate remains the exact authority. Commit clears
  the rows it integrates.
- The ordinary status text renders it ("integrating workspace-event:… — 12
  coordinates unaccounted as of your last merge decision; commit will refuse
  until concluded"), and the supervised-subagent runtime prompt
  (`agent-vessel.ts:1118`) shows the same rows per run — the model sees the
  obligation every turn, not at commit.

### G4. Prescriptive refusals, everywhere on this surface

Every refusal names the exact next call:

- Engine `IntegrationIncomplete` at commit always carries the raw recovery
  recipe (`vcs merge {sourceEventId, resolutions: {allRemaining: …}}`) — the
  error already knows the source and coordinates. The run-level decoration
  needs an **explicit routing design, not an assumed interception**: ordinary
  `vcs commit` executes in the harness tool, which has no knowledge of
  subagent runs. The tool execution context gains an optional
  `integrationSourceResolver: (sourceEventId) => runHandle | null`; the
  vessel injects one when constructing tools for a supervising agent, and the
  harness upgrades the recipe to `merge_subagent({runId, resolutions})` when
  the resolver returns a live run. Absent a resolver, the raw recipe stands
  on its own — never promise vessel decoration where no vessel is present.
- `merge_subagent` on a closed run: return the raw-VCS recovery recipe with
  the retained `sourceEventId` (G5 persistence) instead of only "receipt
  retained".
- `close_subagent` refusals (G1): name both `allRemaining` finishes and their
  distinct meanings.

### G5. Two-axis run state, with the semantic axis derived

`SubagentRunRow` currently conflates lifecycle and integration in one
hand-updated `integration` label and retains **no** `sourceEventId`
(`subagent-runs.ts:29` region) — so after teardown nothing can be derived and
the ledger can silently lie (§0.7 step 6). Rebuild as two axes:

- **Lifecycle disposition** (row-owned, event-driven): `starting … closed`,
  plus `discardedBeforeIntegration: boolean` set only by the legal G1 discard.
  Never inferred from semantics — a raw VCS user choosing `current` is not
  declaring lifecycle discard.
- **Semantic integration state** (read from the G3 projection — the single
  read model): `unattempted | integrating | needs-decision | complete`,
  classified from the engine-owned row for the run's retained source event.
  No comparison is rebuilt at read time — G3's rows are the only source, with
  their staleness flag passed through honestly. Raw VCS merges update the
  projection at decision-persist like any other merge, so the ledger cannot
  disagree with the engine at rest.
- **Persist the frozen facts the classification needs.** Terminal delivery
  alone is unsafe: a child can be terminal with uncommitted work, making its
  committed event merely an earlier baseline. Store/update the child's
  committed `sourceEventId` on the run row **whenever a fresh clean child
  status is observed** — at terminal delivery, at every `merge_subagent`
  verification, and at close — and freeze the exact value plus the final G3
  classification during teardown as the receipt snapshot. This is what makes
  G4's receipt-based recovery and post-teardown truthful reporting possible
  at all.

### G6. Polling becomes an affordance, not advice

`read_subagent` empty results currently return "Stop polling now" prose; the
§0.7 model ignored it six times. Gate it on lifecycle events (no clocks):
after an empty read, the vessel refuses further `read_subagent` calls for
that run — structured error, zero engine work — until a new child
task-channel event has arrived since the refused read. The gate must be
**durable**: persist the empty-read high-water mark (last-seen channel
sequence) on the run row, or derive it from durable channel state on demand —
an in-memory gate silently resets across vessel hibernation and the trap
returns. The push subscription already exists; the refusal names it.

### G7. Tests for the trace itself

An integration test replaying §0.7 end-to-end: manual parent edits over child
work → partial merges → discard-close attempt → commit. After WP-G the trace
must be impossible: discard-close refuses prescriptively; the named
`allRemaining` call concludes the source; status and the runtime prompt show
the debt at every intermediate step; the ledger never disagrees with the
engine at rest; the whole recovery is two calls.

---

## 9. WP-H — Comprehensive skill & reference doc updates

Nearly every WP above changes surfaces that `workspace/skills` documents.
Docs ship **in the same change** as the behavior they describe — the skill
tree is part of the tool contract. Inventory:

### H1. `workspace/skills/vibestudio-vcs/` (primary)

- `SKILL.md` — the merge walkthrough (steps 4–9) changes materially:
  self-sufficient discriminated-union merge result, no post-merge compare
  loop, structured `unchanged`, `allRemaining` resolutions, `statusFilter`
  compare, `integrating` debt in status. The documented decision-only merge
  behavior (line 45) is **unchanged** and stays.
- `references/compare-and-merge.md` — full rewrite: new result shape,
  driver-backed auto-paging, cursor contract (`nextConflictCursor` basis
  rules + `statusFilter`), when compare is still warranted (read-only
  preview, conflict paging, publication preflight).
- `references/semantic-commit.md`, `references/checks-and-publication.md` —
  prescriptive `IntegrationIncomplete` recipes, the `integrating` status
  rows and their as-of-snapshot semantics, `ours`-vs-`current` meaning.
- `references/typed-recovery.md` — structured `unchanged`, `MergeDriverError`
  serialization, close-refusal codes, retirement of merge-path `NoEffect`.
- `references/scenarios.md` — the §0.7 scenario as a worked example:
  hand-composed parent → `allRemaining` with `"current"` + rationale;
  declining a reviewed child → `allRemaining` with `"ours"`; recovering
  after close via the retained
  `sourceEventId`.
- `references/public-contract.json` + `public-contract.md` — regenerate for
  every schema change (union result, `allRemaining`, `statusFilter`,
  `integrating`). Machine-read; stale copies are worse than none.
- `evaluations/schema-fixtures.json` — regenerate alongside.
- `agents/openai.yaml` — re-tune; the §0.7 trace is from an OpenAI-family
  model, so this profile encodes the G1–G6 guardrails as behavior, not prose
  pleas.

### H2. `workspace/skills/agents/SKILL.md` and `workspace/packages/agentic-do/references/subagents.md`

- Rewrite integration around the post-cutover flow: one
  `merge_subagent({runId})`, self-sufficient result, `allRemaining` for the
  hand-composed and decline cases, two-axis run state, discard's narrowed
  legality, event-gated `read_subagent`.
- Delete guidance that only routed around removed traps — enforced behavior
  is stated as fact, not pleaded.
- WP-E path-query change (repo-prefixed paths) with the exact
  error-and-recover loop.

### H3. Adjacent skills sweep

`grep -rl 'merge\|subagent\|vcs' workspace/skills` at implementation time and
sweep every hit — known candidates: `workspace-dev/WORKFLOW.md`,
`workspace-dev/TOOLS.md`, `appdev/DEV_LOOP.md`, `provenance-orientation/`,
`provenance-tuning/`, `templates/`, `onboarding/`. Checked against the new
contract for stale *workflow shape* (any "compare, then merge, then compare"
narration goes), not just stale names.

### H4. Doc acceptance

- No skill document instructs a compare-before-merge or post-merge compare in
  the clean path (the publication preflight is documented as the driver's
  internal policy).
- Every documented refusal names its in-result recovery recipe.
- `public-contract.json` and `schema-fixtures.json` round-trip against the
  live schemas in CI.
- A fresh-context agent given only the skill docs completes the §0.7 scenario
  without a single refused commit — the real acceptance test for the plan.

---

## 10. Sequencing — one bang

Build order is internal; **shipping is one atomic cutover**. The driver, the
engine changes, the guardrails, the rewires, the deletions, and the docs land
together; the old loops and renderers do not survive into any intermediate
state (no-parallel-path rule).

1. Land WP-F1 timings first (pure additive) to capture the "before".
2. Build in a feature branch, in dependency order: WP-A (+G2 engine form, G3
   projection, A2 structured unchanged) → WP-B/WP-C (co-designed, tested
   privately against the new engine) → WP-G vessel changes (G1 gate, G4
   errors, G5 two-axis rows + `sourceEventId` persistence, G6 gate) → WP-D
   rewires + deletions → WP-E inspection fixes → WP-H docs.
3. Gate the cutover on: all F2 structural targets, the G7 trace test, A4/B4
   suites, H4 doc acceptance (including the fresh-context run).
4. After landing: re-measure p50/p95, then decide §7.3.

## 11. Open items

- Layering home for the driver + resolver + `MergeReview` — constraint:
  importable by harness, agentic-do, and the explorer worker without cycles.
- A2 compatibility sweep: all RPC-level catchers of merge-path `NoEffect`.
- §0.7 ledger anomaly: the trace showed `integration=pending` after
  discard-closes that should have stamped `discarded`
  (`agent-vessel.ts:6619-6621`). Root-cause while building G5 — likely the
  recovery path at `:6059` or a stale-row read; G5's derived model must make
  the class of bug impossible, but the specific defect should still be
  understood.
- G3 snapshot refresh: any compare or merge that rebuilds the comparison for
  a projected source should opportunistically rewrite that source's
  projection row (near-free at that moment). Pure optimization — staleness
  reporting and the commit gate already keep it honest.
- Engine selection-window check: confirm the planning comparison used for
  resolution force-selection (`:2422`) sees the full coordinate set, not a
  bounded page — resolutions for coordinates outside a bounded window would
  spuriously error; if bounded, widen the resolution lookup, not the page.
- H1: confirm how `public-contract.json` / `schema-fixtures.json` are
  generated (hand-maintained vs. derived) before wiring the H4 CI round-trip.
