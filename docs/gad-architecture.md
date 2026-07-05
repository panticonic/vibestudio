# GAD Architecture

> ⚠️ **Schema naming is stale in this doc.** The store (`workspace/workers/gad-store/index.ts`, the schema of record) has no `pi_*` tables: the branch/entry ledger lives in `log_heads` / `log_events` / `refs` / `ref_log` with `trajectory_*` projection tables, alongside the `gad_*` provenance and worktree tables. The two-ledger model described below still holds; read `pi_branches`/`pi_entries` as `log_heads`/`log_events`.

GAD is the workspace provenance system. It is split into two ledgers with different visibility rules:

- Pi entries are the model-visible conversation branch. They store messages, model changes, compactions, labels, summaries, and other entries that can be materialized back into prompt context.
- GAD events are sidecar provenance. They store tool dispatches, file observations and mutations, approvals, branch events, system events, claims, theories, contradictions, and indexing work. They are never implicitly materialized into Pi context.

There is no legacy trajectory compatibility layer. The store starts from the clean `pi_*` and `gad_*` schema and drops old persistence tables when initialized.

## Stored Values

SQLite rows are indexes, not blob containers. Any protocol field that can grow without a strict product bound is encoded as a `vibestudio.blob-ref.v1` stored value before it reaches GAD. Producers call the shared `encodeAgenticEventStoredValues` / `encodeChannelPayloadStoredValues` helpers with a blobstore writer; GAD rejects raw unbounded fields such as invocation `request`, invocation `result`, approval `details`, system `details`, custom `update`, UI `props`, and message type `source`.

Trajectory and channel tables therefore use `*_ref_json` columns. These columns contain bounded payloads, previews, and content-addressed blob references. GAD also maintains `trajectory_blob_refs` and `channel_blob_refs` indexes so diagnostics, hydration tools, and blob lifetime management can find every referenced digest. Full bytes are read through blobstore APIs; default trajectory/channel reads stay ref-only unless a caller explicitly hydrates a stored value.

## Pi Branches

`pi_branches` points at a head Pi entry and a head worktree state. `appendPiEntryBatch` appends entries with optimistic checks for `expectedHeadEntryHash` and `expectedStateHash`.

Each Pi entry records:

- `parent_entry_id` and `parent_entry_hash`
- `entry_hash`, computed from canonical Pi entry content
- `pre_state_hash` and `post_state_hash`
- raw entry JSON plus projected columns for message blocks, tool calls, model changes, and compaction boundaries

`materializePiMessages` walks the selected branch and applies compaction rules before returning model-visible messages.

## GAD Events

`gad_events` is an append-only Merkle chain. Every event hash covers:

- previous event hash
- event id and kind
- anchor kind and id
- canonical payload
- canonical metadata

Projection tables are derived from this log. `replayGadEvents` clears projections and rebuilds them from ordered events. Event rows themselves are not rewritten during replay.

## Worktree States

Worktree states are content-addressed:

- file versions point to blob hashes and modes
- manifest nodes form a recursive tree
- manifest hashes cover sorted child directories and files
- state hashes cover the manifest root hash

Authority model (post blob-addressed migration, see `docs/blob-addressed-cleanly.md`):

- The server's **content store** (`src/server/services/blobstoreService.ts`) owns trees. Every state hash resolves to a mirrored immutable tree there (eager on scan/snapshot, lazy via `ensureStateMirrored`), and all tree reads — path resolution, listing, diffs, build sources, materialization — go through it. The DO's `gad_manifest_*` tables are a **private index** for its own SQL-side state composition (ingest, subtree re-rooting, working-edit projection), not a system read surface; the dedicated subtree-hash RPCs were removed. Manifest/state hashing is the shared canonical implementation (`buildWorktreeManifest`), byte-identical across server and DO (golden-vector pinned).
- The server's **RefService** (`src/server/services/refService.ts`) owns protected refs: `repo → main` is a durable server ref, advanced only by compare-and-swap through the approval gate. The DO's worktree heads for `main` are downstream provenance, never the authority.
- The **gad DO** owns provenance and history: logs/commits, edit-ops, working-edit state, merge bookkeeping, and state transitions. Since P5b it also owns merge semantics (`computeMerge`, backed by the userland `@workspace/vcs-engine`), reading blob bytes and mirrored trees through host `blobstore.*` RPC while the host only orchestrates the returned file set. Since P5c it also owns edit/commit/revert composition (`applyEditOps`/`commitWorking`/`revertWorking`/`resolveWorkingState`), including compose-base resolution, op application with provenance hunks, conflict-marker refusal, commit re-keying, and content-store mirroring of every state it composes. Since P5d it also owns status, ctx-target merge orchestration, and context semantics behind the `vcs` manifest service. The host projects returned states through `DiskProjector`, emits build/reactive events, keeps sparse materialization tracking, and exposes only the slim host read/orchestration surface.

  The host `refs` RPC service (readMain/listMains/readMainLog + single write `updateMains`, approval-gated) is the surface a userland VCS uses to read protected `main` refs and request advancement. `updateMains` is an atomic group compare-and-swap over `main` refs restricted to the single VCS writer; public `refs.advanceRef` and the generic `(repo, ref)` namespace are deleted. Push/merge orchestration, FF/clean-source/divergence policy, and provenance recording moved into the DO: the DO composes + build-validates a candidate, CASes via `updateMains`, and records provenance through write-ahead publish intents. A `main`-target merge flows through that same DO path with `operation:"merge"`.

  The former `ProvenanceFollower` class has been deleted. Scan/freshness recording survives inside `WorkspaceVcs`: before a host scan advances a protected ref it writes a durable host scan record with the full file list, parent, actor, and summary; after the CAS it records the transition by direct per-repo DO ingest and deletes the record on success. Attach and lineage synchronization replay durable host scan records before calling the DO's `vcsHealPublishDrift`, so normal host-scan crash gaps recover with full scan provenance. Remaining drift is handled by DO publish intents or fails closed when no durable source covers the missing transition.

File mutation events produce state transitions. A successful observed mutation records the input state, output state, mutation row, and one or more file change hunks. Payload-supplied hunks preserve line ranges and text hashes; otherwise the projection records a coarse whole-file hunk.

## Lifecycle Projections

Dispatches and approvals are state machines:

- dispatches must start with `dispatch_pending`
- pending dispatches may become resolved or abandoned once
- approvals must start with `approval_requested`
- approvals may be resolved once

Out-of-order or duplicate terminal events are rejected at projection time.

## Integrity

`checkGadIntegrity` verifies:

- Pi parent links and entry hashes
- Pi branch heads and head states
- GAD event chain hashes
- worktree state hashes
- manifest hashes
- state transition input/output state existence
- file mutation transition links

`validateGadHashes` is a string-oriented wrapper around the same integrity checks. `clearDirtyAfterValidation` currently delegates to validation because this clean store does not keep a separate dirty-bit migration path.

## Index Jobs

`gad_index_jobs` tracks asynchronous indexing work with explicit lifecycle methods:

- `enqueueGadIndexJob`
- `claimGadIndexJobs`
- `completeGadIndexJob`
- `failGadIndexJob`
- `listGadIndexJobs`
- `processGadIndexJobs`

Jobs can be queued, running, retry, failed, or complete. Failed jobs are requeued by enqueueing the same source/job pair again. Status metrics expose queued/retry, running, and failed counts.

## Operational Surface

The GAD browser panel exposes branch, entry, event, file, tool-call, integrity, and status views. It can refresh data, run integrity checks, validate hashes, and replay GAD event projections.

Raw SQL is read-only through the service and store. Production writes must go through typed GAD methods so they preserve event hashes, projections, and lifecycle rules.
