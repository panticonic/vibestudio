# Durable Object schema ergonomics: current-only simplification plan

Status: revised 2026-08-12; supersedes the migration-engine plan

The original plan correctly diagnosed opaque schema failures and an unsafe
reset/clone path, then proposed a production-baseline, ordered-migration,
ledger, fixture, and publication-retention system. The system is pre-release
and controlled end to end. That machinery is unnecessary and is now itself the
largest schema-ergonomics problem.

The target contract is
`docs/durable-object-schema-migrations.md`: initialize truly empty storage,
validate one exact current schema, reject every other shape unchanged.

## Retained findings

- Schema initialization failures must cross both Durable Object RPC boundaries
  as the same structured `DO_SCHEMA_INCOMPATIBLE` service error.
- The relay must preserve `kind`, `code`, structured data, and exact
  `source/className/objectKey` identity.
- Eval must classify schema refusal as a platform/service failure, not guest
  execution failure.
- Exact owned shape validation must include indexes, constraints, views,
  triggers, and declared virtual tables.
- Framework lazy objects and SQLite shadow objects need explicit ownership
  exclusions.
- Reset and clone require a real quiesce/snapshot primitive; copying live
  WAL-mode files independently is not a consistent snapshot.
- Destructive reset needs an exact target, approval, fencing, verified backup,
  idempotent journal, and owned cleanup.

## Removed design

Delete:

- `schemaProductionBaseline()`;
- `schemaMigrations()` and migration callbacks;
- `_vibestudio_schema_migrations` and installed-version history;
- migration-specific error reasons and `DO_SCHEMA_MIGRATION_FAILED`;
- retained migration source digests;
- representative migration fixture declarations/capture;
- prior-descriptor compatibility comparison in Build V2;
- checks for contiguous chains, retained definitions, and migrated-to-fresh
  convergence; and
- documentation/skills that tell agents to write a migration.

These are compatibility infrastructure, not current-schema safety.

## Phase 1: one structured refusal path

1. Extract one shared dispatch guard used by both Durable Object bases.
2. Run readiness/schema validation inside that boundary.
3. Return a correlated RPC error envelope with:
   - `code: DO_SCHEMA_INCOMPATIBLE`;
   - class, exact object identity, persisted/current version where readable;
   - reason such as version mismatch, shape drift, or unversioned nonempty
     storage; and
   - honest actions: use compatible current code or explicitly reset/recreate
     disposable pre-release storage.
4. Make the relay preserve the structured envelope on every branch.
5. Render it in eval without host-log spelunking.

Exit: a deliberate mismatch is self-describing in one round trip through both
bases.

## Phase 2: collapse the schema engine

1. Replace the baseline/migration definition with `{ className, version,
storage, createSchema, validateSchema, owned objects }`.
2. Keep one metadata identity for exact current validation; remove the ledger.
3. Initialize only storage proven truly empty.
4. Validate current version plus full owned shape on every activation.
5. Reject all other shapes without mutation.
6. Update every Durable Object subclass to delete migration hooks and declare
   only its current schema.
7. Delete migration tests and add old/malformed/current-shape rejection tests.

Exit: source search finds no migration hook, callback, ledger, baseline, or
fixture API.

## Phase 3: exact reset and snapshot recovery

Keep `workers.resetStorage()` as an explicit destructive operation, not a
schema path.

1. Fence one exact object identity.
2. Retire/quiesce its facet and prove file release.
3. Copy a consistent backup outside workerd's directory under an operation ID.
4. Verify backup integrity.
5. Delete the exact store.
6. Close the journal/fence; retry resumes the same operation.
7. Make clone use the same quiesced snapshot primitive.

Restoring a backup is allowed only into code whose exact current schema accepts
it. Restore never translates or restamps an incompatible backup.

Exit: reset/clone crash tests prove no torn copy, broad target, or unfenced
reactivation.

## Phase 4: current-schema Build V2 proof

1. Run `createTables()` in a contained scratch object in the serving workerd.
2. Record the normalized exact fresh schema fingerprint.
3. Validate that the candidate's declared current schema and runtime validator
   agree.
4. Destroy scratch storage unconditionally.

Do not load a prior descriptor, capture deployed fixtures, or predict
cross-version compatibility.

Exit: schema mistakes fail before publication while the gate remains purely
about the current candidate.

## Phase 5: documentation and skill reconciliation

Update storage docs and worker/sandbox skills to say:

- create the final current schema;
- bump the class version when it changes;
- old storage is unsupported pre-release;
- reset only exact disposable storage after approval/backup; and
- never add a migration, conversion shim, or fallback reader.

Add doc probes for the error code, current worker API, and absence of obsolete
migration hooks.

## Sequencing

Phase 1 can land independently. Phase 2 removes the compatibility engine.
Phases 3 and 4 preserve useful current-generation safety and diagnostics.
Phase 5 closes the agent-facing surface. Complete all phases before the
coordinated external-Base clean cut recreates controlled workspaces.
