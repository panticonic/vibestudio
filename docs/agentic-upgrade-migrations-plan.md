# Pre-release upgrades: clean cuts, not migration infrastructure

Status: superseded implementation direction, revised 2026-08-12

The earlier version of this document proposed template-carried migration notes,
maintenance admission, skipped-release repair, external rescue, and a bounded
storage-owner transfer path. Vibestudio is pre-release, controls every official
component and deployed development/test instance, and has no supported legacy
format contract. Building those mechanisms now would create a permanent second
architecture for speculative compatibility.

They are not part of the pre-release system.

The active cutover plan is
`docs/external-base-cutover-and-self-development-plan.md`. This document records
the upgrade policy so later work does not accidentally reintroduce compatibility
infrastructure under the name of recovery or agentic repair.

## Current policy

For every pre-release format, host/workspace ABI, official template, and storage
ownership cut:

1. Define one target schema and one writer.
2. Delete the previous parser and writer in the same reviewed change.
3. Bump the exact `systemEpoch` when the host/workspace ABI changes.
4. Republish Base and every official optional template at that epoch.
5. Promote only that complete set in the verified registry.
6. Delete and recreate controlled workspaces from the exact promoted Base.
7. Reinstall desired templates and re-import only deliberately exported
   user-level data.
8. Test representative old state for hard rejection, never successful repair.

Historical commits and tags may remain in Git. The current host and registry do
not select them.

## Agentic intelligence still has a large role

Agents own semantic work inside the current generation:

- deciding whether a new unit belongs in Base;
- reconciling concurrent current-format edits;
- repairing a candidate until Build V2 passes;
- explaining validation failures;
- choosing and running ordinary user-data exports/imports;
- editing host and Base together through exact development pairs; and
- reviewing publication and registry diffs.

Agents do not make obsolete internal state admissible. There is no prompt,
skill, migration note, or rescue session whose purpose is to translate a prior
system generation.

## Deliberately absent infrastructure

The pre-release system has no:

- migration-note convention or `migrations/system/` release payload;
- applied-note ledger or from/to migration graph;
- structural old-schema reader;
- old-epoch maintenance startup;
- skipped-release or downgrade path;
- compatibility range or additive host API revision;
- external rescue harness for obsolete workspaces;
- generic or cutover-scoped internal-storage importer;
- Durable Object production baselines, ordered migrations, migration ledgers,
  retained migration fixtures, or Build V2 migration-chain admission;
- owner-cutover declaration or route receipt;
- dual reader, writer, route, transport, or shadow table; or
- fallback that silently substitutes old/new template releases.

Normal current-generation operation recovery remains. CAS retries, exact
snapshot reacquisition, process cleanup, and resuming an idempotent external
effect recover an interrupted operation; they do not interpret a superseded
format and therefore are not compatibility machinery.

Persistent stores use one rule: a truly empty store may initialize at the
canonical current schema; an existing store must match the current version and
shape exactly; every other shape is rejected unchanged. The canonical host
SQLite lifecycle already embodies this rule. Durable Object storage is changed
to match it instead of maintaining a separate migration framework.

## Handling pre-release data

Internal workspace state is disposable for the coordinated cut. Before
deletion, an operator may explicitly export user-level facts worth preserving
through an ordinary product export surface. The fresh workspace may then import
that product data through its current API.

Vibestudio does not provide a converter for obsolete Composer state, semantic
metadata, builtin databases, route records, approval internals, or runtime
bookkeeping. If a controlled instance has no honest product-level export, its
state is discarded.

This is intentionally visible and destructive. It must use exact instance
inventory and normal lifecycle ownership; it must never broaden a deletion
target or silently reuse another developer's instance.

## Future post-launch migrations

After Vibestudio makes a supported release and accepts durable user data, the
constraints change. A future incompatible transition must be designed from the
actual source and target owners, actual protected data, and actual availability
requirements. That design may require deterministic migration machinery.

Do not implement that machinery speculatively now. In particular, do not keep
pre-release readers “for later”; doing so would make their accidental behavior
the de facto compatibility contract the future design must preserve.

The future decision starts from these questions:

- What exact durable user facts must survive?
- Which owner can authoritatively read and write each fact?
- Can the product remain on the old complete release during conversion?
- Is offline export/import sufficient?
- What atomicity and rollback guarantees do real users require?

Until those questions have concrete answers, the clean cut is the whole policy.

## Acceptance checks

- Source search finds no obsolete schema parser or converter.
- Source search finds no Durable Object schema migration callback, ledger,
  production baseline, retained fixture, or Build V2 migration-chain gate.
- The Base release artifact contains only the current exact pin.
- The current registry exposes one epoch across all official entries.
- An old manifest/state fixture fails with a precise unsupported-generation
  error before userland starts.
- A current-format interrupted operation resumes without consulting old state.
- Fleet cutover evidence shows affected instances were recreated, not migrated.
- Documentation never instructs an agent to repair a pre-release internal
  format.
