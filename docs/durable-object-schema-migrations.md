# Durable Object schema migrations

Vibestudio Durable Objects use explicit, forward-only SQLite migrations. A
schema version is a durable data contract, not a cache epoch: increasing it
must never implicitly discard persisted state.

The neutral `@vibestudio/durable/schema` module implements the contract once.
Both the host `@vibestudio/durable` base and the workspace
`@workspace/runtime/worker` base delegate to it; runtime-specific RPC and
lifecycle behavior remains in their respective bases.

## Contract

- `static schemaVersion` is the exact schema produced by the current code.
- `createTables()` creates that exact schema for an empty database. Fresh
  installs do not replay historical migrations.
- `schemaMigrations()` returns ordered, retained migration definitions. A
  migration with `version: 21` transforms version 20 into version 21.
- `schemaProductionBaseline()` names the oldest exact production shape this
  store supports. A version older than that baseline is rejected intact.
- `schemaMigrationFixtureObjectKeys()` declares exact representative objects
  whose published SQLite files become permanent migration fixtures. It is
  optional for the first publication and mandatory before a later version
  bump can publish.
- Every migration supplies `validateSource(sql)`. It runs immediately before
  translation, in the same transaction, and proves the source shape and data
  invariants that migration understands.
- Every persisted version between the database and the target must have one
  migration. A missing step is a deployment error and fails closed.
- The version immediately before the earliest retained migration is the oldest
  supported production baseline. When no migrations exist, only the current
  version can be the baseline. Earlier versions are rejected without mutation
  rather than reset or represented by fictional no-op migrations.
- The complete upgrade, migration ledger, and final schema validation run in
  one synchronous Durable Object storage transaction.
  A thrown exception or interrupted activation leaves the previous version
  intact, so the next activation retries from the last commit.
- A schema newer than the running code is rejected. Rollbacks must deploy code
  that understands the already-deployed schema; they must not reinterpret it.
- An unversioned database containing tables, views, triggers, or state is
  rejected. The runtime cannot safely infer its provenance or shape.
- A database already stamped at the current version is validated and never
  repaired by rerunning `createTables()`. Repairing a deployed malformed shape
  requires a new version and an explicit migration.

The schema identity table records both the current `version` and the
`installed_version` at which this engine created the database. The canonical
migration ledger is `_vibestudio_schema_migrations` and contains only migration
steps that actually ran. A fresh database therefore has an empty ledger. There
is no version mirror in application state and no inference, restamping, or
admission path for databases created before this contract.

Migration and baseline definitions are part of the durable history. Keep their
versions and names stable after deployment. Ledger rows begin immediately after
`installed_version`, remain contiguous through the current version, and rows
**above the current production baseline** must match the running definitions
exactly.
Rows at or below the baseline are permanent history from an older support
window: raising `schemaProductionBaseline()` retires the migration definitions
at or below it, and their already-written ledger rows remain valid without a
matching definition. Raising the baseline therefore never bricks a database
that migrated under the previous window — but a database still _below_ the new
baseline is rejected intact as unsupported.

## Writing a migration

```ts
export class ExampleDO extends DurableObjectBase {
  static override schemaVersion = 4;

  protected override schemaProductionBaseline() {
    return { version: 3, name: "example-items-v3" } as const;
  }

  protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    return [
      {
        version: 4,
        name: "add-item-created-at",
        validateSource: (sql) => {
          const columns = sql.exec(`PRAGMA table_info(items)`).toArray();
          if (columns.map((column) => column.name).join(",") !== "id") {
            throw new Error("items does not match the exact v3 shape");
          }
        },
        migrate: (sql) => {
          sql.exec(`ALTER TABLE items ADD COLUMN created_at INTEGER`);
          sql.exec(`UPDATE items SET created_at = 0 WHERE created_at IS NULL`);
        },
      },
    ];
  }

  protected override schemaMigrationFixtureObjectKeys(): readonly string[] {
    return ["representative"];
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
  }
}
```

Migration callbacks must be synchronous and use only Durable Object storage.
Do not perform network I/O, return a Promise, run raw `BEGIN`/`COMMIT`, or hide
schema changes in request handlers. Data backfills belong in the same migration
when bounded by one object's database. A backfill too large for one activation
requires a separately designed online-migration protocol before the version is
changed.

Migration entries use literal `version` and `name` fields and remain inline as
one object definition. Publication hashes that exact pre-bundle repository
source span. Indirect or ambiguous definitions fail publication because a
module-level fallback would make unrelated edits look like migration edits.

## Publication fixtures

On a version-changing publication, the host fences every exact object key from
`schemaMigrationFixtureObjectKeys()`, retires its live facet, verifies the
released SQLite files, and copies them to the host-owned
`.databases/do-schema-fixtures` directory with restrictive permissions. The
fixture is keyed by source, class, installed effective version, and object key;
once captured it is immutable compatibility evidence.

Every retained fixture at or above the candidate production baseline is copied
into a reserved scratch facet. The candidate migration chain runs there in the
same workerd runtime that will serve the class. Publication fails if migration
throws or if the resulting normalized fingerprint differs from a fresh install
of the candidate. Scratch storage is destroyed unconditionally.

Choose bounded representative objects deliberately: fixture files contain
their real rows and persist as release assets. Do not select an object carrying
secrets or unbounded user content. A declared object that has no published
storage fails the release instead of silently producing a synthetic fixture.

Virtual tables are migrated through their declared virtual-table name. SQLite
owns their shadow tables: do not enumerate, rename, or drop shadow tables. If a
virtual-table definition must change, the explicit migration should create the
replacement, copy/rebuild its content as the module supports, swap the declared
tables, and validate the result. The runtime never sweeps unknown schema
objects, so extension-owned and future virtual tables survive unrelated
upgrades.

## Required review and tests

Every version bump must demonstrate:

1. A fresh database creates the final schema, records its `installed_version`,
   and has an empty migration ledger.
2. The oldest supported predecessor upgrades while preserving representative
   rows, generic `state` values, and unrelated schema objects.
3. Every migration step and its stable name appear in the ledger.
4. A simulated exception rolls the whole upgrade back and a later activation
   can retry successfully.
5. Current-version schema drift, unversioned persistence, malformed metadata,
   a missing migration, and a newer persisted version all fail closed.
6. `validateSchema()` checks every shape invariant the DO relies on—not merely
   table existence—including required columns, indexes, constraints, and
   virtual-table definitions where relevant.
7. At least one exact representative fixture object is declared, captured from
   the installed release, and converges to the fresh-install fingerprint in the
   publication gate.

## Small JSON stores

Host-side JSON persistence follows the same contract through
`versionedJsonStore`: one authoritative configurable version field, ordered
exact decoding at the current version, and atomic writes. Encoder output may
not contain the authoritative version field. Malformed, unversioned, or
different-version files fail without overwriting the original file; there is
no admission or conversion path.

## Production transition boundary

This contract is an intentional breaking cutover. Databases created by an
earlier schema helper—or containing only application tables, old stamps, or
partial framework metadata—are unsupported and fail closed without mutation.
They must be reset explicitly. The engine contains no old fingerprint parser,
conversion shim, compatibility row name, or state-version fallback.

Compatibility begins only with databases created by this engine. From the
first such release onward, choose and publish the support baseline for every
Durable Object class and retain the migration definitions and captured fixtures
needed for that support window.
