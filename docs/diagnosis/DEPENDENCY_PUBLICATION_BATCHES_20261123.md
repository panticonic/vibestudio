# Bounded dependency publication

Observed in the running v12 release: dependency-content-maintenance child206371
spent CPU time preparing dependencies and was later observed in
`jbd2_log_wait_commit`. That identifies filesystem commit waiting, not its caller
or a cause of earlier transport resets. V12 remains frozen and running.

## Mechanism inventory

| Producer or consumer | Code boundary | Treatment |
| --- | --- | --- |
| Base dependency metadata | Base `extensions/templates/sourceDependencies.ts:14` computes the logical source dependency closure. Base `skills/workspace-dev/DEPENDENCIES.md` describes installation through Host. | No native file publication or durable commit here; no Base change. |
| Host dependency installation | `src/server/buildV2/externalDeps.ts:1518` creates private staging, validates package identities/receipt, calls content preparation at1559, and only then atomically renames staging at1564. | Preserve receipt checks, private staging and whole-directory promotion. |
| Maintenance child authority | `dependencyContentMaintenanceProcess.ts:43` validates exact staging/cache coordinates, rejects symlink staging/receipt/node_modules, acquires the cache-key lease and joins preparation under `maintain` at76. `dependencyContentMaintenance.ts:135` inherits Host environment into the child. | Preserve all authority checks and lifecycle joins. Opt-outs propagate naturally. |
| Dependency file publication | `dependencyContentStore.ts:505` hashes files, acquires mode/digest leases, publishes only verified content and links, then releases leases. `ensurePrimaryReplica`, `linkAvailableReplica` and replica allocation retain synchronous coordinator boundaries. | Lease batches now cover64files by default; hashing and publication remain8workers. Metadata and live leases are bounded; all started workers settle before lease release. |
| Cache coordination | `packages/shared/src/derivedCache.ts:195` opens SQLite/WAL; `acquireBatch` at258 and release mutate ownership/recency; `withMutation` at327 and transaction at620 serialize mutations/pruning. No explicit synchronous mode previously overrode SQLite's FULL default. | WAL NORMAL now avoids a power-loss barrier on every reconstructable cache lease transaction. Cross-process SQLite writer serialization remains. |
| Other derived cache consumers | Root-template snapshots (`acquireRootTemplateSnapshot.ts:50`), prepared source/release caches (`preparedWorkspaceSourceCache.ts:145`, `preparedWorkspaceReleaseCache.ts:112`), build/unit-validation stores, CLI storage inspection and dev-generation leases share this coordinator. | Same cache-only durability policy applies everywhere, rather than special-casing one caller. Owner death/identity and lease/prune guards remain unchanged. |
| Native/scratch filesystem | `services/fsService.ts:1491` dispatches scoped operations to the native disk worker; `fsDisk.ts:638` resolves and checks the target and calls ordinary `fs.writeFile`. Source vs scratch dispatch occurs in `fsService.ts:1551` and2464. | No per-file fsync barrier here to remove; preserve filesystem authority and actual application writes. |
| Reconstructable template blobs | `services/blobstoreService.ts:197` bootstrap path uses `putReconstructableBlobBytes`; `storage/blobCas.ts:365` explicitly omits redundant durable barriers for exact reconstructable sources. | Existing optimized mechanism retained. |
| Durable application blobs and records | `storage/blobCas.ts:72,82,208,217` flush durable data; governance (`packages/shared/src/governance/governanceLog.ts:169`) explicitly uses FULL. CLI journals, credentials and atomic user-state files have their own durability paths. | Outside deletable cache ownership. Preserve their power-loss guarantees. |

The clear defect is redundant durability for reconstructable cache ownership,
plus ownership transaction frequency tied unnecessarily to hash-worker count.
The journal wait is consistent with this mechanism, but no historical causality
claim is made. No benchmark is required to justify removing these barriers.

## Defaults and opt-outs

`VIBESTUDIO_DERIVED_CACHE_DURABILITY=full` restores the former SQLite durability;
`normal` is the default. A power loss terminates every live owner. Losing cache
leases or access recency across it does not remove protection from a surviving
process; stale owners are still reclaimed only by the existing liveness logic.
SQLite WAL NORMAL retains transaction consistency and live-process atomicity.

`VIBESTUDIO_DEPENDENCY_CONTENT_BATCH_FILES=8` restores former lease grouping;
default64, accepted range1..256. This does not raise hash or publication worker
concurrency above8, alter published content, bypass digest/mode verification,
change executable bits, extend resource grants or rewrite published dependency
trees. Only already private preparations are mutated.

Regression coverage exercises both SQLite modes, multi-key lease authority,
17distinct payloads under default and opt-out batches, complete content readback,
lease release, concurrent publishers, failed workers, pruning and replica limits.
