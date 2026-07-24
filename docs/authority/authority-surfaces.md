# Unified Authority Surfaces

Status: specification (companion to
[../agentic-authority-negotiation-plan.md](../agentic-authority-negotiation-plan.md))

Date: 2026-07-24

This document unifies every place a human **inspects or ratifies authority**
— unit (panel/worker/app/extension/agent) manifests, agent profiles, mission
charters, and the approval queue — behind one shared data model and one
component family. This is a pre-release clean cut: there is no compatibility
layer, no parallel presentation path, and no second review mechanism. If a
surface shows "what something may do," it renders `AuthorityRow`s; if a
surface asks the user to decide, it is an approval-queue subject.

Related: [domain-vocabulary.md](domain-vocabulary.md) (the language),
[agent-authority-profile.md](agent-authority-profile.md) (the living view),
[approval-ux-copy.md](approval-ux-copy.md) (the strings),
[mission-governance-ux.md](mission-governance-ux.md) (mission flows, which
route through the abstractions defined here).

## 1. The unifying observation

The system has exactly three kinds of authority statements, and every surface
is a projection of them:

| Statement | Source of truth | Mutability |
| --- | --- | --- |
| **Declared** — "this exact installed code performs these effects" | `vibestudio.authority.requests` in the sealed unit version | Changes only with a new version |
| **Allowed** — "the user permits this principal to do this" | `CapabilityGrantStore` (+ lock records) | Live; user-editable |
| **Snapshot** — "this mission may use these allowances unattended" | Mission charter closure (profile-row references) | Frozen per digest; revised by re-approval |

Unit inspection shows *declared* (and, for agent units, links to *allowed*).
The agent profile shows *allowed*. Mission review shows *snapshot* diffed
against *allowed*. Version review shows *declared(new)* diffed against
*declared(old)*. The JIT card shows a single prospective *allowed* row.
One row model and one diff model cover all of it.

## 2. Shared data model

### 2.1 `AuthoritySubject`

Everything that can hold authority statements:

```ts
type AuthoritySubject =
  | { kind: "unit-version"; unitId: UnitId; version: ExactVersion }   // declared
  | { kind: "agent-binding"; binding: AgentBindingId }                // allowed (profile)
  | { kind: "mission-closure"; missionId: MissionId; digest: ClosureDigest } // snapshot
  | { kind: "invocation"; snapshot: InvocationSnapshotRef };          // one prospective row (JIT/critical)
```

### 2.2 `AuthorityRow`

The single presentation unit, produced server-side by one projection module
(`authorityRows.ts`) — never assembled ad hoc in UI code:

```ts
type AuthorityRow = {
  capability: SemanticCapability;
  domain: DomainId;            // joined from capabilityDomains.ts at projection
  verb: VerbClass;             //   time — never carried in caller input
  actionCopy: ReviewedCopyRef; // resolved presentation, incl. resource phrase
  resource: ResourcePhrase;    // reviewed derivation; raw ids only in details
  tier: "gated" | "critical";
  statement: "declared" | "allowed" | "snapshot" | "prospective";
  state?: RowState;            // allowed: active | suspended | locked
  provenance: RowProvenance;   // decidedAt/surface/lineage OR manifest origin
  flags: { lineageTainted?: boolean; irreversible?: boolean;
           newInDiff?: boolean; removedInDiff?: boolean };
};
```

Rules (restating the two invariants where they bite):

- `domain`/`verb` are joined from the static mapping during projection.
  `AuthorityRow` inputs (manifests, grants, charters) do not contain domain
  fields; a domain arriving in caller data is a validation error.
- Rows are per capability + resource. Cell/domain groupings happen only in
  the rendering layer; the one domain-granular *record* is the deny-only
  cell lock ([domain-vocabulary.md](domain-vocabulary.md) §1 rule 2), and
  it projects to rows for display like everything else.

### 2.2a `OperationSubstance` (invocation subjects only)

A row names the action; consequential decisions also need the **substance**
— what exactly will be sent, changed, or deleted. The `invocation` subject
therefore carries an additional host-verified block the row model
deliberately does not:

```ts
type OperationSubstance = {
  kind: "change-set" | "send" | "deletion" | "custom";
  summary: ReviewedCopyRef;      // "3 files changed · adds briefing-jul-24.md"
  detail?: SubstanceDetailRef;   // expandable diff / recipient list / item set
  digest: PreparedStateDigest;   // decision binds to THIS substance
};
```

It is derived by the receiver from prepared state and exact arguments (the
machinery the publication flow already has for computed change sets) —
never from agent-supplied text. Receivers for `sharing`-domain and
destructive operations must declare a substance presentation (ledger-
audited); the card renders it in the `What exactly` section
([approval-ux-copy.md](approval-ux-copy.md) §3). List/diff surfaces (unit
review, profiles, mission review) do not carry substance — they describe
standing shape, not a concrete pending act; that asymmetry is the point of
keeping `OperationSubstance` off `AuthorityRow`.

### 2.3 `AuthorityRowDiff`

One diff algorithm for every review: `diff(base: AuthorityRow[], next:
AuthorityRow[]) → { added, removed, unchanged, retiered }`, keyed on
(capability, resource). Consumers:

- unit version review: declared(old) vs declared(new);
- mission approval: allowed(profile) vs snapshot(proposed) — `added` rows
  are the "new" badges, rows already in the profile render "already
  allowed";
- mission revision: snapshot(current) vs snapshot(proposed);
- (degenerate) JIT card: empty base vs one prospective row.

`retiered` (a capability whose tier hardened or softened between versions)
is always shown, never folded into "unchanged."

## 3. One ratification mechanism: the approval queue

Every decision a human makes about authority is an approval-queue entry.
The queue already hosts capability, credential, userland, and unit-batch
kinds; missions join it rather than getting a parallel sheet mechanism.

Scope of the unification, stated precisely: what is unified is the
**mechanism** — one queue (rendezvous, dedup, fan-out, cancellation), one
row/diff projection, one card shell, one decision-record shape. What is
deliberately **not** unified is decision semantics: subjects are typed
exactly so that urgency, evidence, layout weight, and decision vocabulary
differ per kind. A critical confirmation is visually and behaviorally
unlike a version review; a mission review is a sitting-down decision with
no execution waiter behind it, while an `invocation` entry has a caller
blocked on the answer. Per-subject presentation weight is a requirement of
this design, not a deviation from it.

### 3.1 Review-subject entries

Two queue kinds are (re)defined around the shared model:

- `unit-version-review` — subject `unit-version` + `AuthorityRowDiff`
  against the previously active version (or empty base for first install).
  Replaces the current unit-batch capability-section presentation;
  batch-of-units remains a grouping of these entries, not a separate format.
- `mission-review` — subject `mission-closure` + diff per §2.3, plus the
  non-authority charter sections (task, trigger, technical details) as
  typed side-sections. Used for both first approval and revision; the
  revision proposal of
  [mission-governance-ux.md](mission-governance-ux.md) §3 is exactly this
  entry with a one-row diff.

Existing `capability` entries carry the `invocation` subject (one
prospective row). No decision surface renders authority any other way.

What this buys, concretely:

- **One rendezvous/dedup/provenance path.** Mission approvals get the
  queue's dedup, abort, desktop/mobile fan-out, resolve-elsewhere
  cancellation, and provenance recording for free — no second
  notification bridge, no second decision store.
- **One decision-record shape.** "You approved version 1.4 of News",
  "You approved the mission revision", and "You allowed News to publish
  once" are the same provenance record with different subjects, so the
  Permissions "Recent decisions" feed is a single query.
- **One waiting model.** A mission run waiting on an in-charter grant and a
  panel waiting on a JIT card are the same acquisition; a pending
  `mission-review` is the same pending entry, just with a review subject.

Constraints preserved from the existing queue rules: standing-consequence
decisions (`agent` scope, locks, unit-version activation, mission approval)
are in-app only — notification actions never resolve them
(`Open` only); `once`-style decisions remain available from notifications.

### 3.2 Decision vocabulary per subject

| Subject | Decisions |
| --- | --- |
| `invocation` (gated) | once / task / agent (when eligible) / deny / lock |
| `invocation` (critical) | confirm / cancel |
| `unit-version-review` | activate / not now (a denial is simply not activating) |
| `mission-review` | approve / not now — plus per-row opt-out: unchecking a `new` row approves a narrower closure (re-digested before approval) |

## 4. The catalog: one inspection surface family

A single **Workspace catalog** replaces scattered per-kind lists: everything
installed or scheduled, in one place, each item opening an item page built
from the same sections.

### 4.1 Catalog list

Sections: **Agents** · **Panels & apps** · **Workers** · **Extensions** ·
**Missions**. Each entry: icon/name, one-line status (`Active · v1.4` /
`Running` / `Needs your review`), and a one-line authority summary generated
from its rows (grammar of
[approval-ux-copy.md](approval-ux-copy.md) §7): *"Can see your files ·
asks before publishing."* Entries with pending queue items show the review
chip inline.

### 4.2 Item page anatomy (shared component, per-kind sections)

Every item page is composed from the same blocks, in this order:

1. **Identity**: name, kind, owner/source, exact active version, verified
   badge; version history with rollback where the unit supports it.
2. **Authority section** — the heart of the unification:
   - *Fixed units (panels/workers/apps/extensions)*: declared rows grouped
     by domain ("What this panel can do"), rendered read-only with a
     `declared by its developer` provenance line. Gated declared rows show
     their current grant state inline (`you've allowed this` /
     `asks each time`), with the same revoke affordances as the profile —
     this is the *same* row component the agent profile uses, filtered to a
     different subject.
   - *Agent units*: the [authority profile](agent-authority-profile.md)
     grid (allowed statements), plus a collapsed "What its installed code
     does directly" declared-rows section — the two statements visibly
     distinct, never merged into one list.
   - *Missions*: the snapshot rows with mission badges, diffed live against
     the current profile (a row whose backing profile row was revoked shows
     the paused state).
3. **Pending reviews**: any queue entries for this subject, opening the
   same cards the approval bar shows.
4. **Activity**: recent decisions, grant uses, runs (missions), version
   activations — all from the unified provenance store.
5. **Controls** (per kind): restart/rollback/remove for units;
   pause/resume/edit/retire for missions; profile reset controls for
   agents.

### 4.3 Permissions and the catalog are two doors to one room

Permissions (per-agent, per-domain, recent decisions) and the catalog
(per-thing) are pivots over the same rows and the same item pages — the
per-domain pivot lists catalog items, and a catalog item's authority section
deep-links back. No data or component is exclusive to either.

## 4a. Userland app questions are not authority

Panels and workers can raise provider-defined prompts (custom copy, up to
six custom options, flat persisted choices — the existing `userland`
approval kind). These are **app questions** — in-app choices owned by the
provider ("Which folder should exports go to?") — and they are delimited,
not absorbed:

- They can never grant, deny, or represent authority over host
  capabilities; that is already enforcement-true (their decisions live
  outside the capability grant model) and stays true.
- They keep a distinct visual identity: the `App question` header, framed
  provider copy, and none of the authority furniture (no domain chip, no
  scope ladder, no lock). The existing masquerade validation (no
  shell/system-styled subjects) extends to forbid permission-language
  mimicry: option labels may not be `Always allow`-shaped strings that
  imitate the authority scope ladder.
- Their persisted choices are listed on the owning unit's item page under
  `Choices you've made in this app` — with the unit's revoke affordances —
  and are **excluded from the Permissions authority surfaces**, so the
  profile never mixes provider policy with authority policy.

One product, two kinds of questions, visibly different — rather than one
vocabulary stretched over decisions it doesn't govern.

## 5. Manifest authoring stays developer-side

The unification is presentation-and-ratification only. Manifests remain
authored in `package.json` by developers, validated by build/audit; the
catalog never offers manifest editing, and (per the main plan §7.6) declared
rows never render consent affordances for defects. The only user-writable
authority is grants/locks/mission approvals — the *allowed* and *snapshot*
statements.

## 6. Clean-cut consolidation list (pre-release, no compatibility)

Do these as replacements, not additions:

1. **Delete bespoke unit-review capability presentation** (the
   "Code run by this agent" sections and any ceiling diff rendering) in
   favor of `AuthorityRowDiff` rendering. (Ceiling data itself dies in
   WP1.)
2. **`unit-batch` becomes a grouping of `unit-version-review` entries**
   sharing the row/diff model; no separate per-kind payload format for
   capability sections.
3. **Mission review/revision ship as queue entries from day one** — the
   mission registry's approve/edit RPCs are called only by the queue
   resolver, so there is never a UI-less approval path nor a second sheet
   mechanism to retire later.
4. **One projection module** (`authorityRows.ts` + `authorityRowDiff.ts`)
   in shared packages; shell, mobile, and any generated review artifacts
   consume it. The ledger audit gains a check that no UI package imports
   manifest/grant/charter types directly for presentation.
5. **One provenance/decision record shape** across capability, version, and
   mission decisions, so Recent Decisions, item-page activity, and audit
   are one store queried three ways.
6. **`ConsentDialog`/`ApprovalCard`/`ApprovalSheet` render subjects**, not
   per-kind bespoke layouts: one card shell (identity header, domain-grouped
   rows or single row, side-sections, decision row) parameterized by
   subject kind on desktop and mobile alike.

## 7. Verification additions

- Row-model conformance: for each subject kind, the projection produces
  rows whose domain/verb always equal the static mapping (property test
  over the census).
- Diff correctness: version-to-version and profile-to-snapshot diffs mark
  added/removed/retiered rows correctly, including resource-narrowing
  changes.
- Queue-subject round-trip: approving a `mission-review` entry with a row
  unchecked re-digests and approves the narrowed closure; the decision
  record references the final digest.
- Coherence: the same capability renders identical domain chip and action
  copy on the JIT card, the unit item page, the profile, and a mission
  review (extends system test 16 of the main plan).
- No-bespoke-rendering: audit/lint that shell and mobile approval surfaces
  contain no direct manifest/charter capability rendering outside the
  shared components.
