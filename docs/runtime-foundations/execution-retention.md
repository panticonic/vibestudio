# Execution retention lifecycle

Vibestudio retains executable artifacts from authoritative owner records, never
from caller-nominated build lists or reference counts.

Every executable producer uses one verified `ExecutionArtifactRefV1`. Its
semantic `state` explains the history coordinate; its ordered `contentRoots`
are the traversable CAS roots used by content GC. One producer-neutral digest
commits the complete source identity, independent recipe digest, immutable
build locator, and artifact digest whenever a provider or publication loads a
ref. Workspace artifacts require an exact semantic state. Only the structurally
distinct `product-seed` source identity may use `state: null`, and it still
requires an exact repository-free content closure.

Owner publication uses one portable `ExecutionPublicationPort`:

1. reserve the exact build and execution digest durably;
2. atomically write the owner record;
3. finalize the reservation.

The host implementation is a SQLite/WAL journal. Exact artifact resolution and
reservation insertion share one `BEGIN IMMEDIATE` transaction. Artifact
deletion performs its final protection check and atomic rename under the same
database lock, so a publication cannot fit between verification and either
commit point. Ambiguous reservations survive restart indefinitely until their
exact owner root reappears; epochs or wall-clock age never infer their absence.

`GcEpochCoordinator` owns one epoch across execution and content collection.
All mandatory providers snapshot first. A missing provider, invalid ref, or
missing authoritative artifact makes both collectors report-only. The build
collector then marks, quarantines, and (after a later full epoch plus grace)
sweeps. Quarantine is metadata-only so rollback and launch remain instant.
Quarantined source roots continue into `WorkspaceVcs.runGc`; a deletion
tombstone keeps them through the artifact deletion epoch, and only a later
epoch withdraws them. An owned trash record repairs a crash between atomic
rename and tombstone persistence.

The generated provider census is
[`execution-root-provider-census.json`](./execution-root-provider-census.json).
`pnpm check:execution-root-providers` scans durable execution-identity writers
and fails when one has neither a provider nor a reviewed exemption.

Workspace library build responses carry their exact execution ref. Eval and
development stores bind mandatory late-start provider slots and must reserve
that ref before persisting accepted imports or successful run outputs.
Product-seed code is explicitly outside workspace BuildStore because it comes
from the verified application bundle.
