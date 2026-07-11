# Theory of State

## The four-way taxonomy

Every persistent structure in the system is exactly one of:

- **Log** — append-only, hash-chained event sequence. The only source of
  truth. Trajectory logs (agent conversations), channel logs (pub/sub
  envelopes), VCS logs (commit/push history), build logs.
- **Value** — immutable content-addressed bytes in the blobstore
  (`sha256/<aa>/<bb>/<rest>`): file contents, worktree manifests, large
  payloads, build artifacts. A digest's bytes never change.
- **Ref** — a mutable named pointer to log positions or state hashes. The
  protected refs (`repo → main`) are host-owned and advance only by
  approval-gated compare-and-swap.
- **Cache** — anything derived: SQL projection tables, materialized context
  folders, build outputs. **Cache amnesia** is a design invariant: derived
  state may be deleted at any time and rebuilt by replaying logs through pure
  folds.

Two operational corollaries: **journal before dispatch** (an intention is
recorded in the log before its effect runs; "pending" ≡ intention without
outcome), and **one code path** for append/fork/replay/integrity across all
log kinds (`log_kind` is metadata, never a structural switch).

## The unified log envelope

Every log event is a `LogEnvelope`: `{ logId, head, seq, envelopeId, actor,
payloadKind, payload, causality?, appendedAt, prevHash, hash }`. The hash
covers the semantic content plus the chain position, so every log is a
verifiable hash chain; forks start from the parent fork hash. Integrity
checking verifies seq contiguity, prevHash linkage, and per-envelope hashes
identically for every log kind.

Schema of record: `workers/gad-store/index.ts`. Heads live in `log_heads`,
events in `log_events`; `trajectory_*` tables are projections of trajectory
logs, channel envelopes are rows whose head has `log_kind = 'channel'`.
(Older docs' `pi_branches`/`pi_entries`/`pi_sessions` are superseded names
for the same model.)

Unbounded payload fields never sit in SQL rows — they are spilled to the
blobstore as `vibestudio.blob-ref.v1` stored values; rows keep bounded
previews plus content-addressed refs (`*_ref_json` columns). Reads are
ref-only unless a caller explicitly hydrates.

## Two ledgers per agent

GAD (the workspace provenance system) separates:

- the **model-visible trajectory** — messages, model changes, compactions,
  summaries: entries that can be re-materialized into prompt context; and
- **sidecar provenance** — tool dispatches, file observations/mutations,
  approvals, claims, contradictions, indexing work: never implicitly
  materialized into context.

This is why provenance queries (`gad-context`, `gad-review`,
`provenance("session")` skills) exist as *pull* surfaces: rich provenance is
recorded about everything, but only deliberate reads bring it into a model's
context.

## Worktree states and the VCS authority model

Workspace source state is content-addressed: file versions point to blob
hashes; manifest nodes form a recursive tree; a **state hash** covers the
manifest root. Authority over source is split three ways:

1. The server's **content store** (blobstore) owns trees — every state hash
   resolves to an immutable mirrored tree; all tree reads (path resolution,
   diffs, build sources, materialization) go through it.
2. The server's **RefService** owns protected refs: `repo → main` advances
   only by compare-and-swap through the approval gate. Nothing in userland
   can move `main` directly.
3. The **gad DO** owns semantics: provenance and history, edit/commit/revert
   composition, merge computation, status, and push orchestration. It
   composes and build-validates a candidate state, requests the CAS, and
   records provenance via write-ahead publish intents.

Your **edit → commit → push** workflow is the userland face of this split:

- an *edit* is a tracked working change on your context head, projected to
  disk so it builds, with per-op provenance (actor, turn, invocation);
- a *commit* folds working edits into a messaged, content-addressed snapshot
  in the DO's history;
- a *push* is the only operation that touches host authority: fast-forward
  only, build-gated (esbuild + tsc; failure means no head moved),
  approval-gated (`workspace-repo-write`), atomic across grouped repos.

VCS is per-repo (each `panels/x`, `packages/y`, `meta`, … has its own log,
`main`, and `ctx:*` heads). Your context is a pinned snapshot; divergence is
surfaced (`diverged` push result) and resolved by explicit merge, never by
force-advance. File mutations record state transitions (input state → output
state + hunks), which is what makes per-edit provenance and blame queries
possible.

## Where runtime state lives

- **Durable Object SQL** is the single durable SQL primitive. Userland
  persistence = own a DO, use `this.sql`; schema ownership stays in the DO
  class (`createTables`/`schemaVersion`/`migrate`). There is no shared
  database service.
- **Framework-internal DOs** (host-registered, not workspace units): `EvalDO`
  (per-agent eval scope), `WorkspaceDO` (panel tree/entity state),
  `BrowserDataDO` (imported browser data), `WebhookStoreDO`.
- **Blobstore** — per-workspace content-addressed store with HTTP + RPC
  surface; immutable, dedup on write, no verify-on-read, GC driven by the
  reachability layer above (delete is trusted-caller only).
- **On disk** (host state directory, outside your file root): DO SQLite
  files, blob store, build store, per-context folders, device credentials.

## The build system

Builds are content-addressed and demand-driven:

- An **effective version (EV)** = hash of a unit's content + all transitive
  internal deps (+ global build keys). Same EV ⇒ same artifact, cache hit.
- Builds materialize sources from the content store (not from disk), run
  esbuild strategies per unit kind, and store artifacts content-addressed.
- **State advance is the build trigger**: a successful `vcs.push` advances
  refs, which recomputes EVs for affected units and rebuilds them. This is
  the same gate that gives push its authoritative diagnostics — the push
  report is the primary build signal, not a background poller.
- Runtime provenance: every running unit knows which EV/artifact it runs, so
  rollback and update adoption are ref moves, not rebuilds.

## Why this shape

The log/value/ref/cache discipline is what makes the rest of the system
cheap: forking a conversation, forking a workspace, replaying projections,
auditing provenance, resuming after crash (write-ahead intents + durable
scan records), and verifying integrity are all the *same* operation family —
walk a hash chain, re-run pure folds. When you design new userland state,
follow the same taxonomy: append events, content-address big values, keep
projections rebuildable, and never make a cache the source of truth.
