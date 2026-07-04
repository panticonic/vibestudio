---
name: provenance-orientation
description: Orient before you act — what provenance("session") returns, what each item means, the follow-on handles, and the moments to call it.
---

# Provenance Orientation

`provenance("session")` is the **wide view** the per-file provenance blocks
cannot give you: open contradictions in what you have touched, other sessions'
uncommitted edits near your work, main movement on your repos since you
started, and the claims most active around your neighborhood. It is **pull** —
a query you call, never a briefing pushed at turn open — because a block that
renders every turn is skimmed by the third turn.

It is the same tool, item shape, and paging contract as the per-file block
(`provenance("<path>")`); it just computes over your session's whole touch-set
instead of one file.

## When to call it (the four trigger moments)

Reach for it at the moments where the story is bigger than the file in front
of you:

1. **Task start** — before you know the terrain.
2. **Before you settle on a plan** — so a contradiction or a concurrent edit
   changes the plan while it is still cheap to change.
3. **After a resume or compaction** — you have lost the working context the
   in-loop history held; this rebuilds it from the durable graph.
4. **Whenever a per-file exception line hints beyond the file at hand** — a
   `⚠ contradicts` or a `session:… has N uncommitted edits` line points at a
   wider situation; follow it up here.

It is one call, exceptions-first, and cheap (it seeds from the session
touch-set the DO already reconstructed, served warm where the cache covers it).
Skipping it saves less than it risks.

## What it returns

```ts
provenance("session")
// → { items, shown, total, nextCursor? }
```

Each `item`:

```ts
{
  line: string,       // one bounded, pre-rendered insight line ending in a handle
  handle: string,     // the follow-on you can pass back to provenance(...)
  kind: string,       // claim | commit | file | session | ...
  exception: boolean,  // true = must-act, rendered at the top regardless of score
  score: number,      // density rank (exceptions ignore this)
}
```

`shown` / `total` are the `K of M` count: the view is intentionally partial —
top items plus a count of the withheld tail. Page the tail with the `after`
cursor (`provenance("session", { after })`); `nextCursor` carries the next
page's cursor when more remains.

## What each item means

**Exception class — first, always, regardless of score.** These are the lines
that demand action, not skimming:

- **Unreconciled contradiction** among claims you have touched — reconcile it,
  or `relate_claims` them, before you build on either side.
- **Cross-session uncommitted edit** on a file you have touched — another
  session has live edits there; check before you collide.
- **Main movement** on a repo you have touched since your session base — the
  ground moved under you (host ref-log signal); re-check assumptions that rode
  on the old main.

**Density-ranked orientation — after the exceptions.** The top active claims
and files in your session's 2-hop neighborhood, scored by the §6 density
model. This is "what is alive around your work", not an exhaustive dump; there
is no structural filler — silence here is meaningful.

## Follow-on handles

Every item line ends in a handle you can hand straight back to `provenance`:

| Handle | Follows to |
| --- | --- |
| `claim#<id>` | the claim, its relations, and what asserted it |
| `commit:<eventid-prefix>` | the commit's message, actor, and touched files |
| `file:<path>` | that file's per-file provenance block |
| `session:<head>` | the other session's touch-set behind a concurrency line |

Chase a thread when a line flags something live — a contradiction, a hub, a
claim you cannot reconcile — or when the `K of M` count says the detail you
need is in the tail. Do not reflexively expand every item.

## Trust but verify

Provenance is **recalled, not generated** — a claim is a past judgement with a
handle, not ground truth. If it matters, follow the handle to the trajectory,
commit, or edit that produced it before you rely on it.

## Underlying surface

The in-loop `provenance` tool is the affordance. Under it, the DO computes
`provenanceForSession({ sessionLogId, sessionHead, after? })` on the gad-store
DO (same item/paging contract as `provenanceForFile`; `gad.provenanceForFile`
is the eval-reachable file variant). You pass none of the session identity by
hand — the tool threads it from your vessel.
