# Durable Object current-schema lifecycle

Status: current implementation contract; migration policy clarified 2026-10-01

The neutral `@vibestudio/durable/schema` module implements one asynchronous
schema lifecycle for both host and workspace Durable Object bases. It supports
fresh creation, exact current validation, and explicitly declared supported
upgrades. Classes without upgrade declarations still refuse older storage.
Migration support does not infer a source format or weaken validation.

## Migration policy and release transition

The earlier preference for clean cuts avoided repeatedly building bespoke
migration machinery for disposable pre-release formats. It does not prohibit
sound migrations already supplied by a dependency, or migrations needed to
preserve valuable data as we approach release. Do not remove a dependency's
migration support merely to conform to that earlier preference.

Use one authoritative storage owner and a documented upgrade path. Where a
dependency owns its schema and migration runner, assess and reuse that contract;
integrate it explicitly with DO initialization, native transactions, schema
validation and code publication. The base now supplies the owned asynchronous
transaction and trusted source/target validation seam; each class must declare
and test its actual supported upgrade path.

For stores we own, design necessary upgrades from the actual supported source
and target formats. Define atomicity or recoverable progress, duplicate/restart
behavior, failure visibility, data preservation and rollback/downgrade limits.
Validate the resulting current schema before ordinary work is admitted. Unknown,
corrupt or unsupported storage still fails closed; a migration is not permission
to guess at damaged data or silently restamp it.

Before the first supported release, record which durable user facts and schema
versions are supported, and test the next upgrade against representative stored
data. Reset remains an option only for explicitly disposable state, not the
default release upgrade strategy. See
[upgrade and migration policy](agentic-upgrade-migrations-plan.md).

## Contract

- `static schemaVersion` declares the target generation.
- One initialization flight is awaited before fetch/RPC, alarm and lifecycle work.
  Constructors perform pure field setup. `ensureReady()` asserts completed
  readiness; it does not initialize synchronously.
- `createTables()` and `validateSchema()` can be asynchronous. Fresh platform and
  component/domain creation, supported upgrades, final validation and metadata
  run in one native transaction. Activation hooks run after schema acceptance;
  contained probes skip product activation.
- `schemaUpgrades()` declares unique source versions, trusted `fromFingerprint`
  shapes and one-version upgrade bodies. Only a contiguous path to the target
  is supported. Declaring upgrades requires trusted final build evidence.
- Current storage must match its recorded and trusted target shape. An older
  supported source must match its metadata and trusted source shape before any
  mutation. Unknown/newer versions, gaps, malformed metadata and drift refuse
  unchanged. Failure during migration rolls back; retry starts at the source.
- `requiredTables` checks structural requirements. `schemaTables()` selects owned
  shape scope; component classes default to their declared objects. A complete
  Pi composition returns undefined to attest the full application store, so an
  unexpected application table is drift.
- Framework nonce/metadata objects are excluded explicitly. The initializer
  never calls fresh creation to repair existing storage or guesses damaged data.

EvalDO declares no previous-version upgrades for this final pre-release cut.
Its current schema reopens normally; previous versions refuse unchanged. Future
supported transitions can use the shared upgrade contract above without keeping
this cut's historical schema snapshot or conversion code.

The schema metadata records the accepted current identity, not a second execution
history. Dependency migrations execute their existing transaction-scoped body
inside this owner. Pi's standalone wrapper uses that same body; composed storage
opening awaits the parent's initializer instead of starting another installer.

## Build and publication checks

Contained native probes create the fresh schema in the same runtime that will
serve it and record the target fingerprint. WorkerdManager evidence is keyed by
source, immutable execution digest and class. Effective source version alone is
insufficient because build recipes can differ. Conflicting evidence for an
existing immutable digest rejects without overwriting it. The obsolete derived
probe cache is discarded/reprobed, not treated as application data migration.

Fresh target evidence does not prove any older source upgrade. Each supported
source descriptor and upgrade fixture must be supplied and tested by its owner.
The shipping Pi composition must require exact artifact evidence on every route,
including context/unpublished builds; it must probe or refuse if absent. Generic
bare-DO activation retains its existing policy until that owner declares otherwise.

Required tests include fresh initialization, current row preservation, source and
target drift, malformed/unversioned/newer refusal, unsupported path refusal,
failed-upgrade rollback and retry, complete-shape validation, structured RPC
correlation, probe/activation separation and replacement/reopen. Native production
Base/Pi composition tests and manager artifact-identity tests now provide this
component evidence; all shipping product schemas still require their own checks.

Schema refusals retain `DO_SCHEMA_INCOMPATIBLE`; a migration body failure is
reported as its actual failure, not silently restamped as a new accepted version.

## Reset for disposable pre-release state

An exact, approval-gated `workers.resetStorage()` may back up and delete one
object through a fenced, journaled current-generation operation. Reset is an
explicit destructive recovery/development effect, not a schema upgrade path.
Fresh activation recreates the object at the current schema.

The reset journal and backup recover the reset operation itself. They do not
make an old schema readable, restore an incompatible backup into current code,
or become a compatibility ledger.

## Small JSON stores and host SQLite

Versioned JSON and host SQLite retain their current owner-specific rule: initialize a genuinely empty
store at the current exact version; decode/validate that exact version; reject
malformed, unversioned, or different-version files/databases unchanged. Atomic
writes and operation recovery remain.

## Generation changes and supported upgrades

A schema change affecting explicitly disposable development state may use a
coordinated clean cut:

1. change the current schema and version;
2. delete old parsing/translation code;
3. bump `systemEpoch` if the host/workspace ABI changes;
4. republish the coordinated official release set;
5. delete controlled obsolete storage; and
6. recreate fresh objects/workspaces.

Valuable user-level facts may be exported and imported through current product
APIs. This option does not require database conversion, and does not prohibit
a tested owner-provided migration when that is the simpler sound path.

Pre-release status alone does not grant authority to discard valuable state.
For supported user data, including data accepted before launch, design the
transition from its real source/target data and availability contract. Once a
release is supported, its upgrade policy must preserve that promised data.
