# Provenance-graph handoff: constraints on the narrow-host VCS work

Date: 2026-07-03. Audience: the agent implementing `docs/narrow-host-vcs-plan.md`
in this tree. Origin: the provenance-graph workstream in the `2-vibez1` worktree
(branch `claude/gad-system-review-6r1qpf`, spec:
`docs/gad-provenance-fibers-design.md`), which will merge FROM this tree and
build directly on the substrate you are reshaping.

## Background: what the provenance workstream is

The provenance spec turns GAD's ledger into a queryable provenance graph:
line-level **blame** (file/line → edit op → invocation → turn → session, exact
by invariant, no content-diff fallback), a **claims** memory model, FTS
**recall**, and a density-ranked **read-time attachment**. It consumes, almost
entirely, structures your rework already maintains — it adds one small
behavioral table and a set of views/helpers on top. We audited this working
tree (2026-07-03, uncommitted state) against that plan. The substrate survives
the narrow-host split well; this doc lists what must stay true, plus a few
things worth changing while you are already in the relevant code.

## Contract: what the provenance graph depends on (please don't break)

All verified present in this tree; keep them through P3–P5:

1. **`gad_worktree_edit_ops` semantics** (gad-store `index.ts` ~1360):
   per-op rows with `kind, path, old_content_hash, new_content_hash,
   hunks_json, actor_id/actor_json, invocation_id, turn_id, edit_seq/ordinal,
   committed_event_id/committed_seq/output_state_hash`. Working rows have
   `committed_event_id IS NULL`; **commit re-keys the same rows, never
   re-inserts** (`commitWorking` ~4990 — the "NEVER re-insert" comment is
   load-bearing: provenance columns must survive commit).
2. **`IngestWorktreeStateInput.editOps`** — the committed-rows-at-ingest path
   (bootstrap/merge/fork). This is the vehicle blame needs for merge and push
   provenance; do not delete it when the ProvenanceFollower goes.
3. **Event-keyed ancestry**: `gad_worktree_heads.commit_event_id`,
   `gad_transition_parents(parent_event_id, ordinal)` with first parent =
   ordinal 0, `commitAncestors`.
4. **History reads**: `fileHistory` (commit-lineage order + working tail),
   `editsByActor/Turn/Invocation`, `listCommitEdits`, and their userland
   `vcs*` RPC wrappers.
5. **Mandatory commit messages**; per-repo `vcs:repo:<path>` logs; `ctx:` head
   restriction on edit/commit; `vcs_context_bases`.
6. **`gad_claims` + `gad_memory_fts`** tables (claims are still producer-less;
   the provenance workstream adds the producers).
7. **`invocationId` threading** from the agent edit/write tools
   (`workspace/packages/harness/src/tools/edit.ts` / `write.ts` →
   `vcs.edit` → edit-op rows).

## Action items in this tree

### A1 (urgent, independent of our work): GC hole over uncommitted working-edit content

The hourly content GC is live (`VcsGcScheduler`, started in
`src/server/index.ts:~2563`, 24h min-age), but `runGadGcMark`'s live-blob set
(gad-store `index.ts:~7176-7219`) is the union of `gad_file_versions`,
`log_blob_refs`, `gad_file_mutations`, `gad_file_observations` — it does
**not** include `gad_worktree_edit_ops.new_content_hash`, and working-edit
bytes go to the host CAS via the content bridge without a `gad_file_versions`
row until commit. If that trace is right, an uncommitted working edit older
than the min-age can have its content blob swept; the eventual
commit/materialize then dangles. Fix by adding
`SELECT new_content_hash FROM gad_worktree_edit_ops WHERE committed_event_id
IS NULL` (and `old_content_hash` for revert/inverse-patch paths) to both the
candidate-exclusion and the `liveBlobDigests` union — or keep the sweep off
until P4's root-set surface exists. (Also note this contradicts the plan's
"content-store GC stays disabled until P4" line.)

### A2: P3 is where blame is won or lost — build the invariants in, don't retrofit

When push/merge provenance moves into the DO and the ProvenanceFollower is
deleted:

- **Main-advance and merge ingests should carry `editOps`** with per-file
  hunks whose `old_content_hash` composes against the **first parent** —
  i.e. each op's base is the previous op's output along the first-parent
  chain. The provenance spec calls this U2 (chain continuity); validating it
  at the ingest `editOps` path (reject on mismatch) is cheap while you are
  writing that path anyway.
- **Mark degraded ingests as synthetic.** The crash-heal fallback (a main
  matching no recorded intent → synthetic catch-up ingest of the ref's tree)
  cannot carry true hunks. Stamp those rows (e.g. a `synthetic` marker on the
  op or a distinguished `kind`) so blame treats them as chain restarts — like
  `create` — instead of either mis-blaming or tripping integrity.
- **`vcsMerge` (P5d) clean-merge commits**: check whether they record per-file
  hunks today. If they commit the 3-way result without ops, every ctx merge is
  a blame hole. Ideal shape (spec U3): merge ops against the OURS side,
  origin-annotated (`theirs` with source range / `resolved`), recorded via the
  ingest `editOps` path.
- **While `vcs.commit`'s schema is open, add optional `invocationId`**
  (self-asserted toolCallId, same pattern as `vcs.edit`) so the commit event
  itself is attributable — today only its ops are. One field now saves a
  schema pass later (spec T1).

### A3: don't discard diff3's chunk alignment

`diff3Merge` (`workspace/packages/vcs-engine/src/diff3.ts`) computes the full
base/ours/theirs chunk alignment internally and returns text + conflict count
only. The provenance work needs origin-annotated merge hunks from exactly that
alignment. No change required now — just keep the internal `Chunk`/`diffChunks`
machinery intact/exportable rather than folding it away, or (better) surface
merge hunks vs OURS with `{start, end, newText, origin: "theirs"|"resolved",
theirsStart?, theirsEnd?}` while you are in the merge code.

### A4: file-index marker bug (silent permanent un-indexing)

`src/server/vcsHost/workspaceVcs.ts` `indexRepoFiles` (~2628–2670) still skips
missing/oversized/binary CAS blobs and then **advances the `memidx:` marker
unconditionally** — a transient blob miss permanently un-indexes that file
version with no trace. Since this code was just rewritten for the host/DO
split (host decodes bytes → DO `indexMemoryFiles`), fix it now: a missing blob
aborts the pass (retry on next advance) rather than advancing the marker;
deliberate skips (size cap, binary) get logged.

### A5: demote caller-supplied blob pruning

`blobstoreService.pruneUnreferencedBlobs`/`pruneUnreferencedTreeObjects`
(+ the `pruneUnreferenced` RPC) still accept a **caller-supplied**
`referenced` list over the shared CAS. With `VcsGcScheduler` +
`collectGcRoots` + `runGadGcMark` as the real, owner-derived GC, the
caller-supplied form is a loaded gun (a caller that forgets the gad-store's
live digests deletes spilled log payloads and FTS-anchored file versions). At
minimum don't add callers; preferably delete the RPC or re-route it through
the owner-derived root set.

### A6: small things

- The plan doc's status line still says "DESIGN APPROVED, not yet implemented"
  while P1/P2/P3.5/P5b-d are substantially landed — update it.
- Edit-op rows store `turn_id` directly. The provenance spec treats
  `invocation_id → trajectory_invocations.turn_id` as the source of truth; if
  the stored column stays, document it as denormalized-at-write (the spec now
  assumes exactly that). Don't let anything treat the stored column as
  authoritative over the join.
- `checkGadIntegrity` does not yet validate edit-op referential integrity
  (committed_event_id/content-hash resolution, per-path chain continuity).
  The provenance work adds that check; no action needed unless you touch
  integrity anyway.

## New signals we WILL consume (FYI, no action)

- The host **main-ref log** (`writer`, `onBehalfOf`, `reason`, `operation`,
  nullable `new`) becomes a provenance source for main movement — it is
  host-verified attribution, stronger than anything the DO records. Keep its
  schema stable-ish or ping the provenance workstream on changes.
- The `VcsInvocationTable` on-behalf-of tokens give push/merge advances
  host-verified principals; the provenance graph cross-references them with
  the self-asserted edit-time `invocationId`.

## Sequencing

The provenance "big bang" (one schema bump: blame invariants, claims
producers, touches, recall upgrades, read-time attachment) lands **after your
P3** — its blame invariants are specified against the post-P3 world (gad-owned
push/merge provenance, no follower). A1 and A4 are worth doing immediately
regardless; A2/A3 are cheapest folded into P3 itself.
