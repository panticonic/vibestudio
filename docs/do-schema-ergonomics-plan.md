# Durable Object schema ergonomics plan

Status: proposed. Successor synthesis of two analyses of a disposable
Durable Object schema-evolution experiment (2026-08-07). Verified against the
code on `workspace-templates`.

## The incident, precisely

An agent evolving a disposable DO-backed app hit `DO RPC relay failed (500):
Internal Server Error` from an RPC mutation with no cause, no DO
identity, and `failureCode: guest_execution_failed`. It had no way to learn
that the real refusal (if that is what happened) was the exact-schema check.
It then *worked around the schema instead of changing it*: encoded archive
state into titles and labels, and hard-coded board metadata behind a row-count
heuristic, because touching `schemaVersion` had previously bricked the object
with the same opaque 500.

That last part is the important reading of the incident: **an opaque
fail-closed schema policy does not prevent schema changes — it redirects them
into the data**, which is strictly worse than either migrations or resets.

## Verified findings

Each was checked against the current tree; line numbers are from
`workspace-templates`.

1. **Schema refusal escapes the error boundary in both DO bases.**
   `installExactDurableObjectSchema` throws on any mismatch
   (`packages/durable/src/schema.ts:65`). Both bases call `ensureReady()`
   *before* their try/catch that produces structured error envelopes:
   `packages/durable/src/index.ts:517` and
   `workspace/packages/runtime/src/worker/durable-base.ts:860` (inside
   `dispatchFetch`, before the `__rpc` branch). workerd converts the uncaught
   throw into a bare HTTP 500; the host relay then destroys what little is
   left: `postEnvelopeToDO` wraps a non-OK status as
   `DO RPC relay failed (500)` with no cause and no DO identity
   (`src/server/workerdRpcRelay.ts:262`). Eval finally labels it
   `guest_execution_failed` / `failureKind: "user-code"`, which is false — the
   guest code never ran.

2. **The advertised remedy does not exist.** The schema helper's errors say
   "recreate it explicitly", but there is no agent-reachable primitive that
   deletes one DO's storage. `retireDOEntity` deliberately preserves durable
   storage (`src/server/workerdManager.ts`, retire hook), and `destroyDO`
   (file-level deletion of one object's SQLite files) is internal-only, used
   for failed-clone cleanup and whole-context destruction. `workers.destroy`
   is the lifecycle verb for regular worker *instances*; it is not a DO
   storage reset. So the error message tells developers to do something the
   platform provides no verb for.

3. **Three conflicting documented contracts, none implemented.**
   - `workspace/skills/workspace-dev/WORKERS.md:502` tells agents an older
     epoch "discards all of its non-framework SQLite objects … then creates
     and validates the current schema from empty storage" — auto-erase. False:
     the helper rejects.
   - `docs/architecture/storage.md:15` documents a
     `migrate(fromVersion, toVersion)` hook. It does not exist.
   - `docs/durable-object-schema-migrations.md` specifies a complete
     forward-only migration engine (`schemaMigrations()`,
     `schemaProductionBaseline()`, `_vibestudio_schema_migrations` ledger) in
     the present tense. None of it is implemented.
   The agent that hit this incident could have been following any of the
   three stories; all would have failed.

4. **The schema fingerprint has a hole.** `schemaShape` claims to cover
   "tables and indexes" (`packages/durable/src/schema.ts:19`) but queries only
   `type IN ('table','view','trigger')` (`schema.ts:34`). Index drift is
   invisible to the exact-epoch check, so an application index can drift
   without becoming part of its recorded shape.

5. **The disposable experiment showed the induced damage.** Rather than risk
   another opaque schema refusal, application metadata was encoded into
   unrelated rows and inferred with heuristics. Replacement mutations also
   lacked one enclosing transaction, allowing a partial import to commit.
   The experiment itself is intentionally not retained; the durable lesson is
   that opaque fail-closed schema policy pushes schema into application data.

## Critique of the prior analyses

The second (investigating) agent's diagnosis is essentially correct and its
core recommendation — implement the migration contract rather than bolt on a
reset API — is right. Adjustments:

- **`docs/durable-object-schema-migrations.md` is the design; don't redesign
  it.** The investigation's proposed class contract is a slightly renamed
  subset of that doc (`schemaBaseline` vs `schemaProductionBaseline`). The
  plan below implements the existing doc verbatim; the doc is edited only to
  stop speaking in the present tense until the engine lands, plus any deltas
  discovered during implementation.
- **"Remove/rename `workers.destroy`" solves the wrong problem.** `destroy`
  is a worker-instance verb and is not ambiguous in its own domain. The gap is
  a *missing* verb (DO storage reset), not a misleading existing one. Adding
  `workers.resetStorage` and leaving `destroy` alone avoids churning every
  doc and caller.
- **The proposed `resetStorage` ceremony is oversized for this environment.**
  Fencing tokens, version-fingerprint preconditions, and severe approvals per
  reset are production-multi-tenant machinery. Vibestudio is a trusted
  single-household deployment (see `docs/` multi-user framing); the
  proportionate design is: explicit exact target, an automatic file-level
  backup (cheap — copy the SQLite files before unlink), retire-then-delete
  ordering, and the normal capability/approval path that any
  storage-destructive RPC already goes through. No new approval tier.
- **Rejecting "atomic export → recreate → import" is correct** — deletion
  can't join a SQLite transaction and the platform can't validate arbitrary
  application export formats. In-place transactional migration is the atomic
  path; reset is the explicitly lossy path. Keep those the only two.
- **First-agent items dropped**: "first-class app metadata/state tables"
  (the generic `state` KV table already exists and the real fix is app schema
  design), and "optional migration primitives … while retaining fail-closed"
  (that is just the migration engine, already specified).
- **One reframe both analyses underweight: the consumer is an agent.** Every
  error surface in this plan must be machine-actionable: stable `errorCode`,
  structured `errorData` including the safe next actions, and prose that
  names the exact API to call. An agent that receives
  `DO_SCHEMA_INCOMPATIBLE` with `safeActions: ["add-migration",
  "reset-storage"]` writes a migration; an agent that receives an opaque 500
  mutates the schema into the data. The WORKERS.md skill text is part of the
  product surface here and ships with each phase.

## Plan

Ordered by leverage-per-effort. Phase 1 is independent of everything else and
should land first; it converts every future schema incident from a debugging
session into a self-describing error.

### Phase 1 — Structured schema errors end to end (small, immediate)

1. **One shared dispatch guard.** Both DO bases currently duplicate
   fetch/error handling, which is exactly why the two escape paths could
   drift. Extract a shared wrapper (natural home: the neutral
   `@vibestudio/durable` package, next to the schema helper) that runs
   `ensureReady()` *inside* the boundary and converts initialization failures
   into the same structured envelope shape `handleEnvelope` produces. For
   `__rpc`, a schema failure returns a correlated RPC **error envelope**
   (200-level transport, `message.type: "response"` with `error`), never a
   transport 500.
2. **Typed schema errors, layered.** The neutral engine has no runtime
   identity — it knows `className`, versions, and the refusal reason, not
   `source`/`objectKey`. So the split is: `installExactDurableObjectSchema`
   (and later the migration engine) throws a `DurableObjectSchemaError`
   carrying `errorKind: "service"`, a code, `className`,
   `persistedVersion`/`targetVersion`, and `reason`; the shared dispatch
   guard in the base enriches it with `source`/`objectKey` (both bases
   already compute exactly this triple in `lifecycleKey()`).
   Two codes, because the failure classes demand different responses:
   - `DO_SCHEMA_INCOMPATIBLE` — the deployment/data mismatch class
     (`version-mismatch`, `shape-drift`, `unversioned-database`,
     `future-version`, and post-Phase 2 `migration-missing`,
     `ledger-drift`). Remedy: change the code or reset the data.
   - `DO_SCHEMA_MIGRATION_FAILED` — a declared migration threw
     (post-Phase 2). The transaction rolled back, data is intact, and the
     remedy is to fix the migration; retrying without a code change is
     pointless but harmless.
   `safeActions` is an **advisory enumeration of mechanisms**, not an
   authorization claim — whether the caller may actually invoke one depends
   on its authority, which the DO cannot know. It must also only name APIs
   that exist in the running build: until Phase 3 ships, the honest actions
   for `version-mismatch` are "add a migration" (post-Phase 2) or "revert
   `schemaVersion` to the persisted version"; the error text must not
   advertise `resetStorage` before it exists.
3. **Relay preserves structure.** `unwrapResponseEnvelope` already rebuilds
   `RemoteRpcError` with kind/code/data — once schema failures arrive as
   error envelopes, the relay path needs no change. The remaining fix is the
   non-OK branch in `postEnvelopeToDO` (`src/server/workerdRpcRelay.ts:262`):
   attempt to parse the body as a structured error before falling back to the
   opaque string, and always append the resolved DO identity
   (`source:className/objectKey`) to whatever is thrown.
4. **Eval classification.** A `RemoteRpcError` with `errorKind: "service"`
   and a `DO_SCHEMA_*` code is a platform/compatibility refusal, not
   `guest_execution_failed`. The rendered text should read like:
   `ExampleStore (workers/example/main) cannot open persisted schema v1 with
   build schema v2: migration 1→2 is missing. Safe actions: add a
   schemaMigrations() entry for v2, or workers.resetStorage(...) to discard
   this object's data.`

5. **Strip the two documented falsehoods now, not in Phase 6.** The
   auto-erase claim in `workspace/skills/workspace-dev/WORKERS.md:502` and
   the `migrate(from,to)` hook in `docs/architecture/storage.md:15` actively
   mislead every agent that reads them today. Phase 1 replaces both passages
   with the current truth ("mismatches fail closed; migrations and reset are
   landing — see the migration contract doc"); the full rewrite still
   happens in Phase 6.

Exit criterion: a deliberate `schemaVersion` bump on a live DO produces that
message in eval, in one round trip, with zero host-log spelunking. Phase 1
is diagnosis, not remedy — until Phase 2 lands, the only fixes are reverting
`schemaVersion` or destroying the containing context. That is an accepted,
explicitly temporary state.

### Phase 2 — Implement the migration engine as specified

Implement `docs/durable-object-schema-migrations.md` in
`@vibestudio/durable/schema`, replacing `installExactDurableObjectSchema`'s
reject-only behavior for the versioned path:

- `schemaMigrations()` / `schemaProductionBaseline()` on both bases (thin
  delegation; the engine lives once in the neutral package).
- Fresh databases create the final schema only; existing databases run the
  contiguous migration chain in one `transactionSync`, each step preceded by
  its `validateSource`; ledger rows in `_vibestudio_schema_migrations`;
  mirrored `state.schema_version` downgrade guard; all the fail-closed cases
  in the doc's "Required review and tests" section become the engine's test
  suite.
- **Close the fingerprint hole here**: the recorded shape must include
  indexes (and stay a complete normalized fingerprint — tables, indexes,
  views, triggers, virtual-table declarations), because post-migration
  validation compares against it. This changes the stored `shape_json` for
  existing databases; handle it as the engine's own v-next of the
  `_vibestudio_schema` metadata (recompute and restamp inside the same
  adoption transaction), not as a per-class migration.
- `requiredTables()` stops being the ownership/validation source of truth;
  ownership derives from the fingerprint. Keep it only if some caller still
  needs a cheap existence probe.

### Phase 3 — The missing verb: `workers.resetStorage`

A recovery/dev primitive, not the migration path:

- Signature: exact canonical target (`source`, `className`, `objectKey`) plus
  a required human-readable `intent` string. No wildcards, and reject a bare
  `resolveService()` handle — the caller must name the object it is erasing.
- Semantics: retire the live facet (existing `retireDOEntity`), copy the
  object's SQLite files aside as a timestamped backup under the DO storage
  dir, then delete via the existing `destroyDO` file path. Next activation
  creates fresh schema; if that activation fails validation, the backup is
  still on disk for manual restore. No automatic restore machinery.
- Authority: route through the normal capability/approval flow as a
  storage-destructive method (`sensitivity: "write"` is not enough; this
  should surface as its own reviewable capability so the install review names
  it). No new approval severity tier.
- Update the schema error's `safeActions` and WORKERS.md to point at it.

### Phase 4 — Publication-time schema diagnostics

Move discovery of schema mistakes from first-RPC to build/publish, through the
existing structured build-diagnostic system:

- Build emits a schema descriptor per DO class: `{ className, version,
  freshSchemaFingerprint, baseline, migrations: [{version, name,
  definitionDigest}] }`. Fingerprint by executing `createTables()` against a
  scratch in-memory database at build time.
- Publication compares against the prior descriptor and rejects: shape changed
  without a version bump; version bumped without a contiguous migration
  chain; a retained migration renamed/edited (digest change); version
  decreased; post-migration fixture shape ≠ fresh-install shape.
- The last check implies a **fixture harness**: each DO class may declare
  fixture databases captured at prior versions; the build runs the chain
  against them. Make the harness available from Phase 2 (the engine's own
  tests need it); wiring it into publication gating is this phase.

### Phase 5 — A repository-owned reference fixture

Exercise the complete stack with a purpose-built fixture under the durable
package's tests, not with a retained runtime experiment:

- A v1 database fixture with representative rows and an index.
- A v2 schema that adds explicit metadata and archive-state columns plus a
  foreign key.
- A 1→2 migration that normalizes data previously represented indirectly.
- One transactional replacement mutation that validates the complete payload
  before changing storage and proves rollback on invalid input.

### Phase 6 — Documentation reconciliation (runs alongside, gated at the end)

- `docs/durable-object-schema-migrations.md` is the single contract; mark it
  "specified, engine landing in `@vibestudio/durable/schema`" until Phase 2
  merges, then present tense again.
- Fix `docs/architecture/storage.md:15` (no `migrate(from,to)` hook) and
  `workspace/skills/workspace-dev/WORKERS.md:502` (no auto-erase) to describe:
  fresh install / forward migrations / `resetStorage`, and the
  `DO_SCHEMA_INCOMPATIBLE` error surface. The WORKERS.md skill is what agents
  actually read before writing DOs — its schema section should include one
  worked migration example and the failure-message vocabulary.
- Add the required-review checklist from the migration doc to whatever review
  path gates workspace worker changes, so a version bump without fixtures is
  caught in review even before Phase 4 automates it.

## Sequencing and cut lines

Phase 1 alone would have turned this incident into a five-minute fix and is
worth landing this week. Phases 2+5 are one coherent chunk (engine plus
repository-owned fixtures). Phase 3 is small and independent after Phase 1's error
plumbing exists. Phase 4 is the only genuinely deferrable piece — valuable,
but everything before it already fails closed with good errors; it upgrades
"fails at first activation with a clear message" to "fails at publish".
