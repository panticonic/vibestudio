# Host SQLite current-schema lifecycle

Status: current implementation contract; migration policy clarified 2026-10-01

Host-owned SQLite databases currently use one lifecycle from `@vibestudio/sqlite`:

- a truly empty database initializes at one exact current schema and
  `PRAGMA user_version`;
- a current database opens only after exact version and canonical object-shape
  validation; and
- other databases are rejected unchanged unless their owner declares a supported
  migration path.

The shared helper accepts explicit source-to-target migrations in the same
transaction as final canonical validation. A failed migration rolls back; a
read-only owner never migrates. There are no fallback readers or compatibility
ranges. The authority grant store declares no migrations for this final
pre-release cut and rejects previous versions unchanged.

This is an implementation description, not a ban on migrations. The former
pre-release preference avoided bespoke conversion machinery for disposable
formats; sound dependency-provided migrations and necessary supported-data
upgrades are welcome. See
[upgrade and migration policy](agentic-upgrade-migrations-plan.md) and the
[Durable Object policy](durable-object-schema-migrations.md#migration-policy-and-release-transition).
An owner adds support by declaring and testing its migration path through the
shared lifecycle, without bypassing exact validation.

## Failure contract

The lifecycle fails closed for:

- any schema version without a declared path to the current version;
- missing, extra, or differently defined schema objects;
- a nonempty unversioned database, including one whose old tables were dropped
  but whose pages remain; and
- malformed SQLite state.

Failure never overwrites the source. During the pre-release coordinated cut,
the exact scoped store may be explicitly deleted and recreated after any
valuable product-level facts have been exported. There is no implicit
database-format upgrade. A future supported upgrade must name
its source and target versions, preserve promised user facts, define atomicity
or recoverable progress, and test interruption/retry and failure handling.
Unknown or corrupt formats still fail closed. Before launch, define the supported
data baseline and upgrade contract; do not make destructive recreation the
normal update path for supported users.

Schema versions belong to individual databases and advance when their current
canonical schema changes. An ABI-visible change also participates in the
coordinated `systemEpoch` release, but the epoch is not a database-version
range.

The canonical implementation and tests live in `@vibestudio/sqlite`.
Dependency-owned schemas need their own explicit integration.
