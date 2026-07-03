# Merge-rework handoff: provenance invariants the merge system carries

Date: 2026-07-03. Audience: the agent reworking the merge system. Origin: the
provenance-graph workstream (`2-vibez1`, `docs/gad-provenance-fibers-design.md`),
which builds line-level blame directly on what merge commits record. The prior
general handoff is `docs/gad-provenance-handoff-2026-07.md`; this note is the
merge-specific contract. Blame here is **exact by invariant — there is no
query-time content-diff fallback** — so anything the merge path fails to
record is not "slightly worse blame", it is a hole the design forbids.

## The blame model in one paragraph (why merges are special)

`blameLines` materializes the file at a head and walks the **first-parent
chain** newest→oldest, mapping character offsets back through each op's
hunks. At a merge commit it routes by hunk origin: a `resolved` hunk blames
the resolving session's own edit ops; a `theirs` hunk maps the offset into
the other parent's coordinates and continues along **that** parent's
first-parent chain. Every step depends on something the merge system records.

## Invariants to preserve (or knowingly renegotiate)

1. **Every commit-producing merge path records per-file `editOps` with
   origin-annotated hunks vs OURS.** `mergeHunksVsOurs` already computes
   `{start, end, newText, origin: "theirs"|"resolved", theirsStart?,
   theirsEnd?}` inside `MergeEngine` (`mergeEngine.ts:~247`). The contract is
   that this reaches the ingest `editOps` on every path that mints a merge
   commit — `vcsMerge` clean commits, group/push-side merges, import merges.
   A merge commit with no ops is a blame hole. (This end-to-end wire-through
   is the one thing we have NOT yet verified — if your rework touches it,
   you own confirming it holds.)
2. **First parent = OURS, always.** `gad_transition_parents.ordinal = 0` is
   the side whose chain blame walks by default, and merge-op
   `old_content_hash` = the OURS content (that is what
   `validateFirstParentChain` checks, skipping `synthetic`). If you reorder
   parents, change what "ours" means mid-flow, or record ops against any
   other base, blame composes garbage while looking healthy.
3. **`theirs` hunks carry `theirsStart`/`theirsEnd` in the other parent's
   coordinates**, and both branches' ops live on the same per-repo
   `vcs:repo:<path>` log. Blame routes into the other parent's chain through
   those two facts together. Don't drop the ranges, and don't move one
   side's ops to a different log.
4. **Conflict resolution flows through `vcs.edit` working rows.** A
   `resolved` hunk carries no authorship itself — the resolving session's
   edit ops (with their `invocation_id`) are the attribution, preceding the
   merge commit on the same head. If the rework adds any path where a
   conflict is resolved without working edit rows (engine-side auto-
   resolution, panel-side direct writes into the merge result), the
   resolution becomes anonymous. Auto-resolutions the engine itself makes
   (non-conflicting 3-way regions) are fine — those are `theirs`/ours
   regions, not `resolved`.
5. **`synthetic` is not a merge convenience.** It marks intentional
   snapshot-style provenance (import publishes); a merge path that can't be
   bothered to carry hunks must not stamp `synthetic` to skip
   `validateFirstParentChain`. And no-intent crash-heal drift fails closed —
   never a fabricated catch-up merge.
6. **Binary and delete-vs-change conflicts: mark, don't fake.** Binary
   content can't carry hunks — it must be explicitly marked on the row
   (blame treats it as a semantic stop, "no line structure" ≠ "missing
   data"). Delete-vs-change resolutions should end up as ordinary
   `delete`/`write` ops with the resolver's invocation, not as hunk-less
   mystery rows.
7. **Merge commits keep event-keyed ancestry and a mandatory message.**
   Parents recorded as `parent_event_id` (states conflate, events don't).
   The message is FTS-indexed later and recalled verbatim by future
   sessions — an auto-generated merge message should at least name the
   source heads/repos, not be an empty ritual string.
8. **Pending-merge state is a GC root.** `runGadGcMark` reads `merge:%` keys
   from the state table to root `oursStateHash`/`theirsStateHash`/
   `baseStateHash`/`provisionalStateHash`. If the rework renames or
   restructures pending-merge persistence, update the GC mark in the same
   change — otherwise provisional merge content gets swept mid-merge.
9. **Hunks are provenance, never replay.** Char-offset ranges against the
   base the author saw; replay uses content hashes. Keep that separation —
   the moment hunks become load-bearing for state reconstruction, every
   provenance simplification becomes a correctness risk and vice versa.
10. **Commit stays re-key, never re-insert**, including for the commit that
    finalizes a resolved merge — the working rows' `invocation_id`/`turn_id`
    must survive into the committed rows.

## One ask (cheap while you're in there)

If you touch the ingest/commit seams anyway: U1 — reject at insert any op
that mutates an existing **text** file without `hunks_json` (create/delete/
chmod/binary/synthetic exempt, binary explicitly marked). That turns rule 1
from reviewer-discipline into a mechanism, which is the standing project
directive. It's the last unimplemented insert-time blame invariant; the
provenance workstream will otherwise add it right after your rework lands —
coordinate so we don't collide in the same functions.

## Coordination

The provenance branch (`claude/gad-system-review-6r1qpf` in `2-vibez1`) has
merged fabling and re-applied the file-mutation/observation cut (schema v23
there). If your rework lands on top of fabling without that cut, the next
merge re-creates the same conflicts — prefer building on the merged branch,
or at least don't add new references to `gad_file_mutations`/
`gad_file_observations`/`state.file_*` (they are deleted on the other side).
