# Host SQLite current-schema lifecycle

Status: current contract; historical filename retained temporarily for links

Host-owned SQLite databases use one lifecycle from `@vibestudio/sqlite`:

- a truly empty database initializes at one exact current schema and
  `PRAGMA user_version`;
- a current database opens only after exact version and canonical object-shape
  validation; and
- every other database is rejected unchanged.

There are no production baselines, ordered migrations, compatibility ranges,
or old-shape readers. A writer may initialize empty storage. A read-only owner
only validates. Neither repairs, restamps, or translates an existing database.

## Failure contract

The lifecycle fails closed for:

- any different schema version;
- missing, extra, or differently defined schema objects;
- a nonempty unversioned database, including one whose old tables were dropped
  but whose pages remain; and
- malformed SQLite state.

Failure never overwrites the source. During the pre-release coordinated cut,
the exact scoped store may be explicitly deleted and recreated after any
valuable product-level facts have been exported. There is no database-format
upgrade operation.

Schema versions belong to individual databases and advance when their current
canonical schema changes. An ABI-visible change also participates in the
coordinated `systemEpoch` release, but the epoch is not a database-version
range.

The canonical implementation and tests live in `@vibestudio/sqlite`. Durable
Object storage is being simplified to the same empty-or-exact-current rule.
