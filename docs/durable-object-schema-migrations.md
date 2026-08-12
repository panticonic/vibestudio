# Durable Object current-schema lifecycle

Status: target contract for the pre-release clean cut

Vibestudio Durable Objects support one schema: the exact schema declared by the
current code. The neutral `@vibestudio/durable/schema` module implements the
contract once for both host and workspace Durable Object bases.

Despite this file's historical name, the contract contains no migrations.

## Contract

- `static schemaVersion` names the current schema generation for the class.
- `createTables()` creates that exact schema only for a truly empty object.
- `validateSchema()` validates the complete current owned shape: tables,
  columns, indexes, constraints, views, triggers, and declared virtual tables.
- Existing storage opens only when its recorded version and complete owned
  shape exactly match the current declaration.
- A different version, malformed metadata, unversioned nonempty store, missing
  object, extra owned object, or shape drift fails closed without mutation.
- Initialization and validation run before RPC or lifecycle work is admitted.
- Framework-owned lazy objects and SQLite virtual-table shadow objects are
  excluded by explicit ownership rules, never by guessing from a fingerprint.
- The engine never calls `createTables()` to repair an existing store.

The schema metadata records only the current schema identity needed for exact
validation. There is no installed-version history, migration ledger,
production baseline, supported range, source-shape parser, restamping, or
translation callback.

## Class shape

```ts
export class ExampleDO extends DurableObjectBase {
  static override schemaVersion = 4;

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
  }

  protected validateSchema(): void {
    // Validate the exact current owned objects and invariants.
  }
}
```

The base class has no `schemaProductionBaseline()`, `schemaMigrations()`, or
`schemaMigrationFixtureObjectKeys()` hooks.

## Build and publication checks

Build V2 probes `createTables()` in a contained scratch object in the same
workerd runtime that will serve the class. It records the exact fresh current
schema fingerprint and rejects a candidate whose declared current shape is
internally inconsistent.

The probe is current-state evidence only. It does not compare against a prior
descriptor, retain old migration source, capture deployed databases, or replay
fixtures. Publication does not promise that the candidate can open any earlier
store.

Required tests:

1. A truly empty object initializes exactly once at the current schema.
2. A current object validates and preserves application rows.
3. Current-version shape drift fails unchanged.
4. Older/newer versions fail unchanged.
5. Unversioned or malformed nonempty storage fails unchanged.
6. Framework lazy objects and virtual-table shadow objects do not create false
   drift failures.
7. Both Durable Object bases return the same structured
   `DO_SCHEMA_INCOMPATIBLE` error through RPC.
8. Build V2's contained fresh-schema probe matches runtime validation.

There is no `DO_SCHEMA_MIGRATION_FAILED` error because no migration executes.

## Reset for disposable pre-release state

An exact, approval-gated `workers.resetStorage()` may back up and delete one
object through a fenced, journaled current-generation operation. Reset is an
explicit destructive recovery/development effect, not a schema upgrade path.
Fresh activation recreates the object at the current schema.

The reset journal and backup recover the reset operation itself. They do not
make an old schema readable, restore an incompatible backup into current code,
or become a compatibility ledger.

## Small JSON stores and host SQLite

Versioned JSON and host SQLite use the same rule: initialize a genuinely empty
store at the current exact version; decode/validate that exact version; reject
malformed, unversioned, or different-version files/databases unchanged. Atomic
writes and operation recovery remain.

## Generation changes

Before the first supported release, a schema change is a destructive cut:

1. change the current schema and version;
2. delete old parsing/translation code;
3. bump `systemEpoch` if the host/workspace ABI changes;
4. republish the coordinated official release set;
5. delete controlled obsolete storage; and
6. recreate fresh objects/workspaces.

Valuable user-level facts may be exported and imported through current product
APIs. Internal database files are not converted.

After the first supported release, this destructive policy no longer grants
authority to discard user data. A concrete future transition must be designed
from its real source/target data and availability contract.
