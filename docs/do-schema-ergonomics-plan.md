# Durable Object schema ergonomics plan

Status: substantially implemented 2026-08-07. Userland publication diagnostics,
including captured representative fixture replay, are implemented. Per-class
legacy adoption fixtures for every internal product DO and internal-DO
reset/restore remain rollout follow-ups rather than being represented by a
synthetic compatibility path. Successor synthesis of two analyses of a
disposable Durable Object schema-evolution experiment. Verified against the
code on `workspace-templates`.

## The incident, precisely

An agent evolving a disposable DO-backed app hit `DO RPC relay failed (500):
Internal Server Error` from an RPC mutation with no cause, no DO
identity, and `failureCode: guest_execution_failed`. It had no way to learn
that the real refusal (if that is what happened) was the exact-schema check.
It then _worked around the schema instead of changing it_: encoded archive
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
   _before_ their try/catch that produces structured error envelopes:
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
   is the lifecycle verb for regular worker _instances_; it is not a DO
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
  a _missing_ verb (DO storage reset), not a misleading existing one. Adding
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
   `ensureReady()` _inside_ the boundary and converts initialization failures
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
   `guest_execution_failed`. The Phase 1 rendering, naming only what exists
   in a Phase-1 build:
   `ExampleStore (workers/example/main) cannot open persisted schema v1 with
build schema v2: this build supports only exact schema v2. Safe actions:
revert schemaVersion to 1, or destroy the containing context.`
   After Phases 2/3 land, the same error names `schemaMigrations()` and
   `workers.resetStorage()` instead.

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
  existing databases. **Restamping must not launder drift** — and the
  expected complete shape has to come from somewhere. At Phase 2 there is no
  scratch-schema probe yet (that is Phase 4 machinery), and the class's
  declarations are just table names, so the honest Phase 2 contract is:
  restamp requires (a) the database matches its _old_-format
  (table/view/trigger) fingerprint exactly, and (b) the class's
  `validateSchema()` passes — which the migration doc already obligates to
  check required columns, **indexes**, constraints, and virtual-table
  definitions, making it the code-owned statement of expected shape. Both
  run inside the adoption transaction; failure of either leaves the old
  stamp intact and fails closed. Residual gap: a class with a lax
  `validateSchema()` can restamp unvalidated as-found objects into its
  recorded shape; Phase 4's scratch fingerprint cross-checks recorded shapes
  against fresh-install shapes and surfaces exactly those cases.
- **Ownership stays declared; the fingerprint is the record, not the
  definition.** A fingerprint cannot classify a schema object it has never
  seen — lazily created framework tables (`_vibestudio_direct_rpc_nonces`
  appears after stamping), virtual-table shadow tables, and extension-owned
  objects must be excludable by rule, and the migration doc requires unknown
  objects to be _preserved_, which itself requires knowing they are not
  owned. So the class keeps a declared ownership boundary (today
  `requiredTables()`/`schemaTables`); what changes is that _validation of
  owned objects_ comes from the complete fingerprint rather than from bare
  table-existence checks.
- **Rollout inventory — this engine ships into live data, not a greenfield.**
  `WorkspaceDO` is at `schemaVersion = 29` with real persisted product state
  (`packages/builtin/src/workspace-state/WorkspaceDO.ts:417`), and every
  other `DurableObjectBase` subclass — internal product DOs and workspace
  workers alike — crosses the adoption boundary on its first activation
  under the engine. Before Phase 2 merges: enumerate every subclass in both
  bases, declare each class's production baseline
  (`schemaProductionBaseline()` = its current version and a name), and add
  an adoption test per class against a copy of its real current on-disk
  shape (the WorkspaceDO test fixture duplication noted in the repo's test
  fixtures is the seed of exactly this). No class adopts implicitly.

### Phase 3 — The missing verb: `workers.resetStorage`

A recovery/dev primitive, not the migration path.

**Prerequisite: a real quiesce-and-snapshot primitive — which the clone path
also needs.** An earlier draft told reset to "reuse the clone path's
consistency guarantee"; review showed that guarantee does not exist.
`cloneContext` calls `cloneDurableStorage` on live source objects with no
retire or lifecycle-prepare step (`src/server/services/runtimeService.ts`,
clone loop), and `cloneDO` copies the files with concurrent
`fs.copyFile`s — its "consistent snapshot" comment is an assertion the
implementation does not establish. Copying a live WAL-mode SQLite database
file-by-file can yield a torn clone. So Phase 3 begins by building the
missing primitive once in `workerdManager`: fence the target (below), abort
its facet, confirm workerd has released the files, then copy. `cloneDO`
switches to the same primitive — fixing a latent cloneContext corruption bug
independent of reset.

- **Targeting**: any exact durable-object identity is acceptable — the
  canonical triple, or the resolved durable-object result of
  `resolveService()`/`resolveDurableObject()`, which already carries
  `className`, `objectKey`, and `targetId`
  (`workspace/packages/runtime/src/shared/workerd.ts:118`). An earlier draft
  banned service-derived handles as "not naming one object"; that was
  factually wrong. What stays banned is anything inexact: wildcards and
  class-level targets. No redundant objectKey confirmation parameter — a
  value mechanically copied from the same handle confirms nothing; the real
  guards are exactness, the approval flow, and the backup.
- **`intent` string**: required, but it is audit context and deliberateness
  friction — it appears in the approval surface and the log line. It is not,
  and is not claimed to be, a technical safety mechanism.
- **One journaled, fenced maintenance operation.** Reset is recorded before
  it acts: a journal row (host-owned state, written durably) with a stable
  operation id, the exact target, the intent, and a step cursor. The same
  row is the **admission barrier**: while a maintenance row is open for a
  target, activation of that target is refused at the host layer (service
  resolution / relay dispatch) with a structured `DO_MAINTENANCE_IN_PROGRESS`
  error — `retireDOEntity` alone only evicts the current facet and cannot
  stop the next RPC from reactivating it. Steps, each recorded on commit:
  (1) open journal + fence; (2) retire and confirm file release; (3) copy
  files to the backup location named by the _operation id_ (not a
  timestamp — a retry resumes the same backup, and a crashed half-copy is
  re-copied under the same name); (4) verify the backup opens and passes
  `PRAGMA integrity_check`; (5) delete via `destroyDO`; (6) close the
  journal, lifting the fence. Crash recovery replays from the step cursor;
  a crash after step 5 is distinguishable from vanished storage because the
  journal says so. Backup-then-delete, never delete-then-backup.
- **Backups live outside workerd's directory.** Not a subdirectory of the DO
  storage dir — workerd's tolerance of foreign entries in its own layout
  across versions is unproven. Backups go under the host's own state layout
  (a sibling `do-backups/<operationId>/` next to, not inside, the workerd
  dir), with a small manifest (target, versions, operation id, intent).
- **Backup lifecycle**: `workers.listStorageBackups(target)` and
  `workers.restoreStorageBackup(target, operationId)` — restore is the same
  fenced journaled sequence with the copy reversed, so supporting it costs
  little once reset exists, and "restore is manual file surgery on hashed
  filenames" is not a real recovery story even in a trusted deployment.
  Retention: keep last N per object, sweep on the next reset; a failed sweep
  logs and continues (never blocks the reset itself).
- **Authority**: route through the normal capability/approval flow as a
  storage-destructive method; it surfaces as its own reviewable capability so
  the install review names it. No new approval severity tier and no
  version-fingerprint preconditions — the journal fence replaces ad-hoc
  fencing tokens with one auditable mechanism.
- Update the schema error's `safeActions` and WORKERS.md to point at it.

### Phase 4 — Publication-time schema diagnostics

Move discovery of schema mistakes from first-RPC to build/publish, through the
existing structured build-diagnostic system:

- Build emits a schema descriptor per DO class: `{ className, version,
freshSchemaFingerprint, baseline, migrations: [{version, name,
definitionDigest}] }`. **Fingerprint inside workerd, not the build
  process**: executing `createTables()` is executing application code, which
  does not belong in the host build process, and an in-process in-memory
  SQLite cannot reproduce workerd's capabilities (FTS5 shadow tables — the
  repo already runs FTS tests against real workerd for exactly this reason).
  The descriptor is produced by running `createTables()` against a scratch
  object in the same workerd runtime that will serve the class, at publish
  time, and reading the resulting normalized shape. **The scratch probe is
  still executing application code with an environment**, so it runs
  contained: a reserved scratch object identity outside any real key space,
  an environment with no service bindings and RPC dispatch refused, no
  network egress, alarms ignored, a hard timeout, and unconditional storage
  destruction afterward (via the same `destroyDO` path). A `createTables()`
  that attempts side effects fails the probe rather than leaking them.
- `definitionDigest` is a **tripwire, not a proof**: it hashes the migration
  function's _pre-bundle repository source text_ (bundler output would churn
  the digest on unrelated transforms), so it catches direct edits and
  renames but not changes to referenced helpers — and a bundle-level hash
  would fire on every unrelated change, which is worse. Semantic correctness
  of retained migrations is established only by fixtures; the digest exists
  so an _accidental_ edit fails fast with a named reason. Consequence:
  retained-migration immutability is not reliably enforced until captured
  fixtures are mandatory, which is why the rollout inventory in Phase 2 and
  the capture mandate below are not optional niceties.
- Fixtures must eventually be **captured from actually-published shapes with
  representative data**, per the migration doc's production-transition
  section — hand-written fixtures prove the chain runs, captured fixtures
  prove it runs on what's really deployed. Before real user data matters,
  capturing becomes part of the release step.
- **The compatibility predecessor is defined, not implied**: for each DO
  class, the prior descriptor is the one recorded for the _currently
  installed effective version of that source in this workspace_ — the same
  `repoPath@effectiveVersion` lineage that grant identity already uses.
  Branches and clones compare against what their workspace actually has
  installed, not against a global latest; the first publication under Phase 4
  records a descriptor without comparing.
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

Beyond the engine cases already listed in the migration doc, the test matrix
must explicitly cover the following — split by layer, since they exercise
different owners: engine-shape cases live in the durable package's tests;
error-parity cases span both base packages; fence, race, crash, and backup
cases are host/server integration tests (the e2e harness), because the
behaviors under test live in `workerdManager` and the relay, not in the
engine:

- **Cross-base error parity**: the same schema refusal produces the same
  structured error through both the product base and the workspace base.
- **Lazily created non-owned objects**: a framework table appearing after
  stamping (e.g. `_vibestudio_direct_rpc_nonces`) neither trips validation
  nor gets swept.
- **Legacy fingerprint adoption**: a healthy pre-index-fingerprint database
  restamps; one with missing or unexpected indexes fails closed.
- **Multiple historical shapes sharing one version number** (pre-production
  epochs): each is rejected intact by the baseline/adoption rules, never
  guessed at.
- **Reset lifecycle**: reset racing an in-flight RPC; crash injected between
  retire/copy/delete with successful resumption; backup listing and
  retention sweep.

### Phase 6 — Documentation reconciliation (runs alongside, gated at the end)

- `docs/durable-object-schema-migrations.md` is the single contract; mark it
  "specified, engine landing in `@vibestudio/durable/schema`" until Phase 2
  merges, then present tense again.
- Fix `docs/architecture/storage.md:15` (no `migrate(from,to)` hook) and
  `workspace/skills/workspace-dev/WORKERS.md:502` (no auto-erase) to describe:
  fresh install / forward migrations / `resetStorage`, and the
  `DO_SCHEMA_INCOMPATIBLE` error surface. The WORKERS.md skill is what agents
  read before _writing_ DOs — its schema section gets one worked migration
  example and the failure-message vocabulary.
- **The sandbox skill family is the incident's own doc surface and updates
  with each phase, not at the end.** The failing agent was operating from
  the eval-side docs, not WORKERS.md. Per shipping phase:
  - Phase 1 → `workspace/skills/sandbox/EVAL.md` and `gad-context`
    diagnostics: the `DO_SCHEMA_*` codes, what each `reason` means, and that
    such errors are platform refusals, not guest failures.
  - Phase 2 → `workspace/skills/workspace-dev/WORKERS.md` (migration
    authoring) and `workspace-dev/SKILL.md:25`, whose "schema-epoch
    guidance" wording predates migrations and changes meaning.
  - Phase 3 → `workspace/skills/sandbox/RUNTIME_API.md:49` (the `workers`
    namespace table gains `resetStorage` / `listStorageBackups` /
    `restoreStorageBackup`), `sandbox/PATTERNS.md` (the
    schema-refusal-recovery pattern: read the error, write a migration,
    reset only for disposable state), `sandbox/EVAL.md`
    (`DO_MAINTENANCE_IN_PROGRESS`), and
    `workspace/skills/capabilities/SKILL.md` plus the capability-notability
    registration (`scripts/check-capability-notability.mjs`) for the new
    reviewable storage-reset capability.
- **Guard against re-drift**: the mutually-contradictory docs that set up
  this incident were fiction that nothing checked. Add doc probes for the
  load-bearing claims (the error-code vocabulary, the `workers` namespace
  method list, the migration example compiling against the real base class)
  to the existing `workspace/skills/system-testing/tests/docs-probes.ts`
  mechanism, so the rewritten docs fail a test instead of quietly rotting.
- Add the required-review checklist from the migration doc to whatever review
  path gates workspace worker changes, so a version bump without fixtures is
  caught in review even before Phase 4 automates it.

## Sequencing and cut lines

Phase 1 alone would have turned this incident's hour of blind debugging into
a one-round-trip diagnosis (the remedy still waits for Phases 2–3) and is
worth landing this week. Phases 2+5 are one coherent chunk (engine plus
repository-owned fixtures). Phase 3 is small and independent after Phase 1's error
plumbing exists. Phase 4 is the only genuinely deferrable piece — valuable,
but everything before it already fails closed with good errors; it upgrades
"fails at first activation with a clear message" to "fails at publish".
