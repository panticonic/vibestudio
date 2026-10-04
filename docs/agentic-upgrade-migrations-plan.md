# Upgrade and migration policy

Status: policy clarified 2026-10-01; supersedes the blanket pre-release prohibition

The current pre-release cut is the final exception: previous EvalDO and authority
grant-store schemas are unsupported, and no conversion of those databases ships
with this cut. Current-schema reopen and crash recovery still preserve state.
Going forward, supported persistent state requires an explicit, tested upgrade
contract; this exception is not the release policy for subsequent changes.

Earlier plans removed bespoke migration infrastructure while internal formats
were changing rapidly and development state was disposable. That was a practical
pre-release preference, not a permanent architectural ban on migrations.

Sound migrations supplied by an adopted dependency are welcome. Necessary
upgrades for valuable or supported user data are welcome too. Do not strip an
upstream migration runner or build a replacement merely to enforce the old
preference. Judge a migration by ownership, correctness and maintenance cost.

The current implementations may still reject every non-current schema. This
policy does not claim they already support upgrades: introducing a supported
path requires a coherent implementation and tests. Historical cutover plans
describe particular development cuts; their absolute “no migrations” language
does not override this policy.

## Choosing the transition

Choose the simplest correct transition for the actual data and owners:

- For explicitly disposable development state, a coordinated clean cut remains
  an option. Inventory the exact state and preserve valuable facts before any
  authorized reset. Pre-release status alone does not make a workspace disposable.
- For a dependency-owned schema, prefer its tested migration mechanism when it
  meets our storage, lifecycle and transaction requirements. Integrate it with
  native initialization and validation instead of letting two schema owners
  independently mutate the same tables.
- For supported or valuable persistent data, define and test the necessary
  source-to-target upgrade. Do not require users to lose that data on update.
- Keep one active execution implementation and authoritative writer. A one-time
  data migration does not require a permanent legacy engine, dual-write path or
  compatibility transport.

The existing coordinated release procedure still applies: define the target
owner, coordinate host/workspace ABI changes through the exact `systemEpoch`,
publish the complete official template set, and promote verified exact pins.
Data migration is a separate contract from the running release composition.
Historical commits and tags in Git do not imply that the current host supports
running mixed old/new template releases.

## Current implementation and historical scope

The current native SQLite and Durable Object helpers initialize empty storage,
validate the exact current schema, and reject other shapes unchanged. Their
implementation contracts are documented in
[host SQLite](host-sqlite-migrations.md) and
[Durable Object storage](durable-object-schema-migrations.md).

Earlier clean-cut work deliberately removed or declined migration-note
conventions, agentic rescue sessions, old-epoch maintenance startup, generic
storage importers, production-baseline/ledger/fixture machinery, skipped-release
and downgrade paths, dual readers/writers and fallback template routing. Do not
revive that speculative architecture just because migration is permitted.
Neither its historical removal nor today's helper API prohibits a focused,
tested owner-provided upgrade that a real dependency or supported release needs.

Normal operation recovery remains required. CAS retries, snapshot reacquisition,
process cleanup and resuming an idempotent external operation recover interrupted
work. They are distinct from converting a persisted format. Removing historical
format compatibility does not permit losing compatible active work on restart.

## Disposable development cuts

When a clean cut is selected for explicitly disposable state:

1. Inventory exact affected instances/stores and preserve valuable user facts.
2. Define and validate one target schema and writer.
3. Coordinate the complete release set and any ABI epoch change.
4. Remove displaced execution routes and obsolete format code.
5. Reset only the authorized disposable state through its lifecycle owner.
6. Recreate fresh workspaces and import deliberately preserved user facts.
7. Test unsupported-format rejection and current-format operation recovery.

A reset is visible and destructive. It must never broaden a deletion target,
silently reuse another developer's instance, or discard valuable state merely
because it predates launch. If no usable export exists, settle preservation before
cutover rather than treating the absence of an export as permission to delete.

## Release readiness and supported migrations

Vibestudio is approaching release. Before the first supported release, establish
which durable user facts and versions are supported and how the next update will
preserve them. Avoid accidental support promises and speculative frameworks, but
do not defer necessary upgrade design until users already depend on it.

For each supported migration, record:

- exact source and target formats and their authoritative owner;
- protected user facts, derived/rebuildable state and disposable runtime residue;
- ordering relative to code publication, schema validation and work admission;
- transaction atomicity or durable progress if conversion spans transactions;
- interruption/restart and duplicate invocation behavior;
- failure reporting, unchanged-source or recoverable-progress guarantees;
- representative stored-data and forced-loss test evidence; and
- downgrade and code-rollback limits, including required backup/restore behavior.

A dependency's migration runner is assessed by these same requirements. Reuse it
where sound; adapt its native transaction boundary where needed. Do not assume
that successful schema conversion also makes old task checkpoints, provider
handles, template compositions or host/workspace ABIs compatible.

Unknown, corrupt or unsupported storage still fails closed without guessed
conversion or silent restamping. Validate the resulting current schema before
ordinary execution is admitted. Code rollback does not automatically reverse a
data migration.

## Agentic work and acceptance

Agents may design, review and run explicitly supported upgrades and ordinary
exports/imports. They must not improvise a repair that makes unsupported state
look current. Ownership, upgrade logic and failure handling belong in code and
documented operations, not a recovery prompt.

Acceptance requires one authoritative owner and running execution path, a
reproducible release composition, tested supported-data preservation, honest
unsupported-state rejection, recoverable interrupted operations, and cutover
evidence matching the chosen migration or disposable-reset contract.
