# Vibestudio memory and storage audit

The largest storage opportunity is completing collection of the shared build
artifact pool. The clearest memory defects are retained historical HTTP build
buffers and a transcript projection that grows beyond its visible window.
Default template source is small; accumulated derived data and runtime ownership
are the main targets. The implementation pass reclaimed **7.23 GiB**, bounds HTTP
body retention, separates source inventories from hot metadata, joins transport
prewarming at shutdown, and pages System development history in SQL. The findings
below describe the original baseline; the final section distinguishes completed
changes from remaining work.

## Scope and measurement conditions

The audit covers host storage, build and serving code, Electron view ownership,
the mobile and terminal apps, and the configured Base, Personal and System
templates. Native System performance helpers measured a separate managed instance,
startup and five exact-context build profiles. Source review covers paths that
were not exercised. No deployed relay, attached phone, or desktop renderer heap
was measured; their actual resource budgets remain unverified.

Host source was `0d343b44a469dbc608ecd69684a02f82fe7e6ad7`, Base
`8d8e0377a0661ac1640554a18fc035ca1e91df90`, Personal
`9bfe064906af32a11af9493511703076a43c6eb4`, and System
`0cb3f836d1c82db4c1d444a83a31d48bc18e24b3`. All four checkouts were initially
clean. The initial audit left templates unchanged; the implementation pass changes
System development history storage. Profiling used the current
shared derived caches, not a fresh install or an empty-cache experiment.

The Linux machine had 14.9 GiB RAM, about 8.2 GiB available before provisioning,
and 4.6 GiB in swap. The backing disk was 94% full, with about 47 GiB free.
Both the repository and `/tmp` are disk-backed ext4 on this machine. Unrelated
processes remained running. These are observations, not controlled peak-memory
benchmarks or proof that Vibestudio caused existing host swap usage.

## Storage baseline

The shared derived tree occupied **12.20 GiB of unique allocated storage** after
profiling. Each row below measures its directory independently. Hardlinks cross
these roots, so **the rows must not be added**; apparent directory ownership is
different from unique physical allocation. This distinction also explains why a
single combined `du` walk attributed only about 7.3 GiB to the artifact pool.

| Storage owner                                       | Independently measured allocation | Assessment                                                        |
| --------------------------------------------------- | --------------------------------: | ----------------------------------------------------------------- |
| Shared build artifacts                              |                          8.26 GiB | Largest missing collection boundary                               |
| Shared external dependency installations            |                          2.05 GiB | Existing 2 GiB quota; sharing already implemented                 |
| Shared build results                                |                          1.35 GiB | Existing 1 GiB quota; pruning does not sweep the artifact pool    |
| Shared dependency file content                      |                          0.93 GiB | Many files share inodes with installations; not another full copy |
| Shared authority analysis                           |                           480 MiB | Bounded by record counts, not payload bytes                       |
| Shared npm registry downloads                       |                           370 MiB | Previously omitted from storage status                            |
| Shared root template cache                          |                           319 MiB | Existing 512 MiB quota                                            |
| Shared extension installations                      |                           178 MiB | Existing 1 GiB quota                                              |
| Captured system test runs                           |                           618 MiB | Retained diagnostic evidence, distinct from disposable caches     |
| Base, Personal and System source checkouts combined |                          57.8 MiB | Not a significant storage target                                  |

The repository also holds approximately 3.7 GiB of release outputs, 3.2 GiB of
installed dependencies, 1.3 GiB of host outputs, and 1.5 GiB of Android app build
outputs. These are development/release products, not ordinary workspace state.
They need operation ownership and explicit retirement; arbitrary deletion during
an active build is not an optimization policy.

## Prioritized findings

### 1 Shared artifact collection is incomplete

The artifact pool contained 18,634 files with 8,799,399,936 allocated payload
bytes. **15,990 files, accounting for 7,762,268,160 bytes or 7.23 GiB, had only
one hardlink.** Those have no surviving hardlinked materialization. This is a
strong indication of accumulated abandoned payloads, but not an authorization
to delete them: copied materializations, manifests and concurrent publishers
must be considered.

[buildStore](../../src/server/buildV2/buildStore.ts) hardlinks immutable bytes into
the shared pool, while its retention collector operates on workspace build
directories. [storage commands](../../src/cli/storageCommands.ts) deliberately
classify the pool as offline-only. Result-cache eviction removes links without
collecting the pool inode. There is no corresponding shared artifact sweep.

Implement collection at the shared pool owner, coordinated with insertion and
materialization across processes. Complete the reference census and publication
interlock before reclaiming an inode. Preserve workspace execution roots and
rollback retention. Do not add a timed sweep that guesses ownership from age.
The 7.23 GiB is a candidate upper bound from link topology, not verified savings.

### 2 HTTP build serving retains historical builds and byte representations

[PanelHttpServer](../../src/server/panelHttpServer.ts) keeps `servingCache`,
`activatedBuildCache`, shared styles, raw artifact promises, and compressed
artifact promises. `invalidateBuild()` removes the source/ref mapping, but does
not remove its activated build. Successful artifact reads remain in the raw-byte
map. Successful compression remains in another map. The activated-build and
shared-style maps have no deletion path; `stop()` only closes the WebSocket server.

Each distinct activated build can therefore retain metadata, decoded executable
source, and requested raw/compressed assets for the server lifetime. A long
editing session can grow even after its old panels are retired. This retention
path is proven by source ownership; its real long-session heap size has not yet
been measured.

Use live runtime execution ownership for build records and a byte-bounded shared
cache for regenerable representations. Keep concurrent reads single-flight;
release completed byte promises from the flight map. An old build URL can still
resolve its retained immutable build from disk without keeping every byte in RAM.
Do not simply clear all old keys at rebuild: an older live runtime may still own
that build.

### 3 Chat has a visible window but an unbounded projection

Base's `packages/agentic-chat/hooks/useChannelMessages.ts` trims the rendered
`order` and `byId` to 2,000 messages. Its `channelStateRef` still owns the full
channel reducer state, including messages, invocations, turns, timeline and
envelope deduplication keys. The attachment map is not trimmed by that visible
window either. Rebuilding projects all retained messages, then trims again.

A native eval using the installed reducer and valid completed messages of 1 KiB
each confirmed:

| Events consumed | Retained messages | Timeline entries | Dedup keys | Serialized state bytes |
| --------------: | ----------------: | ---------------: | ---------: | ---------------------: |
|             500 |               500 |              500 |        500 |                778,459 |
|           2,000 |             2,000 |            2,000 |      2,000 |              3,124,469 |
|           2,500 |             2,500 |            2,500 |      2,500 |              3,907,969 |

No envelopes were ignored in these samples. Serialized state is not a heap-size
measurement. The hook review establishes why its rendering cap does not retire
these objects. Pubsub's replay buffer already has its own bound; changing that
bound does not fix the second retained projection.

Design a transcript projection whose loaded history window is authoritative for
presentation, with explicit roots for active turns, pending approvals, live
invocations and cards. Rehydrate older completed history through existing
pagination. Preserve out-of-order updates and deduplication semantics. Arbitrarily
truncating the reducer's maps would break those contracts.

### 4 Build metadata duplicates and eagerly inflates executable source

[readBuildMetadata](../../src/server/buildV2/buildStore.ts) synchronously gunzips
and parses `executable-modules.json.gz` during ordinary metadata reads. That
restores source contents into otherwise compact metadata. Verified build objects
and HTTP build records can retain those strings.

The result cache contained **312 source inventory files totaling 356 MiB of
allocated compressed bytes**. The profiled chat inventory alone seals 17.7 MB
of source; shell seals 19.2 MB. Many related builds contain overlapping closures.
These source bytes are required execution evidence, so dropping them is not safe.

Keep ordinary metadata reads compact. Load verified source inventories only at
the consumer that needs them, and reference immutable source payloads through
their content identities rather than embedding overlapping source text in every
build record. Source retention must remain attached to execution roots. Measure
worker and main-thread retained heaps before choosing the exact representation.

### 5 Compilation workers retain expensive runtimes between operations

The typecheck, authority analysis, library lowering, RPC catalog and immutable
tree clients start persistent worker threads on demand and close them at build
system shutdown. `unref()` changes process-exit behavior; it does not free memory.
The measured workspace server had nine JavaScript worker threads after profiling.

Main-thread heap counters cannot attribute these isolates. The native server RSS
was 1.81 GiB before the chat profile, 1.84 GiB afterward, and 0.99 GiB after the
subsequent app profiles. Main-thread used heap was 268, 288 and 335 MiB
respectively. A later `/proc` observation showed 1.07 GiB PSS and 433 MiB swapped
for this exact server. GC, swapping, worker heaps and native allocations make
these different-time observations unsuitable for a retained-leak claim.

Extend the native performance snapshot with per-worker heap attribution. Then
compare ownership through a build batch versus server-lifetime residency. Retire
and join operation-owned workers when their batch completes if warm build latency
justifies that tradeoff. Do not introduce idle expiries as a substitute for a
defined owner.

### 6 Transport derivatives have neither a disk quota nor collection ownership

[TransportDerivativeCache](../../src/server/buildV2/transportDerivativeCache.ts)
persists Brotli and gzip variants in instance storage. It has no prune/close
surface, byte budget, or source-reference collection path. Scheduling limits
active compression to two jobs but not the pending queue. Buffer-based scheduling
retains its input while queued; file-based scheduling defers the read.

The disposable instance produced only 888 KiB here, so this is a demonstrated
unbounded design, not a current dominant disk consumer. Give derivatives one
regenerable storage owner with coordinated publication and byte accounting. Use
disk references for queued source bytes and own/join queued work at shutdown.

### 7 Client cache budgets and cache maintenance need consistent accounting

Desktop's [AssetDiskCache](../../src/node/panelAssets/assetDiskCache.ts) allows
**64 GiB per cache by default**. Its in-memory URL index has no independent entry
bound. Every publication rewrites the full index and scans the entire blob
directory. Reads already update blob mtime for access-based LRU; the original
audit incorrectly described that timestamp as creation-only.
Metadata, index files and partial-write scratch are outside the blob byte sum.

System's mobile asset store already streams immutable assets into native disk
storage and has a **256 MiB** byte cap. The older description of a 256 MiB Hermes
body LRU is no longer accurate. WebView HTTP caching is a separate layer.

Establish a profile/client budget covering payloads, metadata and owned scratch,
with an incremental index and lifecycle-safe reader/publication ownership. Measure
real desktop/mobile closures and switching behavior before setting a smaller
default. Do not replace 64 GiB with an arbitrary guessed number.

### 8 Browser imports still materialize whole databases and row sets

[Browser readers](../../packages/browser-import/src/readers/chromiumReader.ts)
copy the input database, read it into a buffer, open a sql.js database in WASM,
and materialize selected tables with `.all()`. Large history imports can hold the
database image and several JS representations simultaneously. Database/temporary
file cleanup is generally present; the main issue is peak amplification.

Use bounded row iteration and import batches through the same read-only database
boundary. Measure a representative large browser profile before changing the
database engine. The repaired `.get()` path below is one confirmed unnecessary
allocation; it does not solve whole-database import amplification.

### 9 System development pagination loads and reconciles all rows first

System's `workers/development/DevelopmentDO.ts` calls `store.listSessions()` and
then applies its cursor and limit in JavaScript. `listRuns()` reads matching
history and reconciles it with `Promise.all()` before slicing the requested page.
The store query has no SQL page bound. A request for 50 rows can therefore parse
and perform host work for the entire run history.

Move cursor/order/limit selection into the store, then reconcile the selected
rows. Lifecycle reconciliation of still-running operations needs its own exact
active-state query; it should not be an accidental side effect of browsing every
historical page. This is a source-confirmed amplification path, not a measured
large-history benchmark.

### 10 Release and diagnostic retention remain separate ownership decisions

One existing unpacked Linux desktop release contains about 994 MiB of
`node_modules`. Its workerd directories include both x64 (122 MiB) and arm64
(126 MiB). That is worth validating against the target package closure; this
existing release was not rebuilt in the audit, so it is not proof that the
current packaging step unnecessarily ships both. Required runtime compilers,
declarations and intentionally cross-platform provisioning payloads must remain.

Host generations, release trees, Android outputs and system-test evidence need
distinct owners. Retain bounded receipts/logs and exact binaries required by live
processes, rather than every completed operation's installed trees. The existing
server log has a 20,000-record ring and size-rotated JSONL; it is already bounded
by count/disk size. Large individual structured records still duplicate formatted
JSON and parsed fields, so record counts alone are not a memory-byte guarantee.

## Native application build evidence

All five profiles returned successful reports and repeats with identical build
keys. Emitted artifact bytes, sealed source bytes and initial browser payloads
are different measures and must not be added together. Browser payloads below
are decoded bytes, not wire transfer or retained heap.

| Target           | First profile receipt           | Emitted artifact bytes | Sealed source bytes | Initial browser bytes | Verified repeat |
| ---------------- | ------------------------------- | ---------------------: | ------------------: | --------------------: | --------------: |
| Chat             | Built during profile, 11,118 ms |              8,057,651 |          17,713,003 |             2,055,728 |           87 ms |
| New              | Preexisting, 3,778 ms           |              1,843,323 |           2,836,364 |             1,664,094 |           16 ms |
| Shell            | Preexisting, 8,792 ms           |              9,367,039 |          19,217,074 |             2,908,813 |           25 ms |
| Mobile           | Built during profile, 74,217 ms |             11,080,833 |          0 reported |          Not reported |          115 ms |
| Terminal browser | Built during profile, 6,039 ms  |              3,243,484 |          0 reported |          Not reported |           19 ms |

The shell profile interval increased server RSS by about 460 MiB while
main-thread heap increased only about 20 MiB. This deserves worker/native
attribution; it is not proof the shell renderer retains 460 MiB. Workerd fell
from 627 MiB before chat to 200 MiB by the final snapshot, with 11 DO services and
no regular workers. Already implemented isolate compaction should be measured
before changing its policy. Terminal scrollback is already bounded to 1,000
lines, and panel-tree caches already bound groups/nodes/paths.

## Changes implemented and verified

[SQLite single-row reads](../../packages/browser-import/src/readers/sqlJsReader.ts)
previously delegated to `.all()[0]`. They now step once and free the statement
in `finally`. The same isolated subprocess probe used a recursive query returning
10,000 rows, each with a 4 KiB payload, and requested only its first row:

| Probe measure               |           Before |            After |
| --------------------------- | ---------------: | ---------------: |
| Temporary JS heap growth    | 50,613,952 bytes |    216,688 bytes |
| RSS growth during operation | 69,214,208 bytes | 13,258,752 bytes |
| Operation duration          |          94.9 ms |           8.5 ms |

Both returned row 1 with a 4,096-character payload. These are single local samples,
not total import speedup claims. The regression test proves that a valid first
row is returned without evaluating an overflowing second row; it also covers
bindings, empty results and statement reuse.

[Storage status](../../src/cli/storageCommands.ts) now includes the existing
`npm-registry-downloads` and selected-instance `transport-cache` roots. They stay
offline-only for pruning because neither has a live-safe collection contract.
The older npm-cache root remains reported when present. This fixes visibility,
not disk usage.

Verification passed 18 focused tests, the host TypeScript no-emit check, focused
CLI lint, and template checkout hygiene. No template build/test tool was run in
an external source checkout. No inherited cache, user data or unrelated instance
was deleted. The audit session was retired, the exact managed instance was
stopped, its 795 MiB private root was removed, and its supervisor/server/workerd
PIDs were confirmed gone. No inspector or page was opened. Bounded native
evidence remains private under
`/home/werg/.cache/vibestudio-performance/2026-10-05-resources/evidence`.

The recommended implementation order is shared artifact collection, HTTP
representation ownership, bounded transcript projection, compact source
metadata, then worker residency. Those address measured storage concentration
and proven retention paths before smaller cache tuning. The raw template source
and already bounded tree/terminal caches are low priorities.

## Implementation pass: measured cuts

The pool writer now creates an independently owned build file before inserting
its sharing link. A cache hit takes a hardlink atomically and verifies that owned
inode. Collection unlinks only names with no other hardlink owner. A collector
racing either side of publication cannot remove a build's inode. Unsupported or
cross-filesystem links leave a complete independent file. This contract applies
only to the regenerable build sharing pool, never to workspace durable CAS.
Build-publication/hydration-triggered quota pruning, build retention deletion
and the existing `storage prune` command now collect abandoned pool links
without an age rule.

The dry run reported 15,990 pool-only payloads. No Vibestudio server was running
when the actual sweep removed them. The command removed **7,762,268,160 allocated
bytes**. A combined `du` walk of the shared derived root measured:

| Measure                |   Before sweep |   After sweep |
| ---------------------- | -------------: | ------------: |
| Unique allocated bytes | 13,085,478,912 | 5,323,210,752 |
| GiB                    |          12.19 |          4.96 |

These are the immediate sweep measurements, not free-disk differences influenced
by unrelated processes. The quota-owned roots needed no eviction during this
operation. Copied materializations and surviving hardlinked builds remain intact.
Private command receipts are retained alongside native profile summaries.

The HTTP server now uses one **32 MiB LRU byte budget** for raw and encoded bodies
across historical builds. The measured five-app emitted artifact working set is
about 32 MiB; this is a cache working-set choice, not a cap on total process RAM.
Oversized bodies are served without retention. The flight map releases completed
and failed work; concurrent requests share a read or compression. Disk remains
the authority after eviction, and old activated build URLs still resolve.
Rewritten HTML compression uses the actual rewritten bytes as its identity.

Ordinary build metadata reads no longer inflate executable inventories. Explicit
source/diagnostic consumers load them on demand. Verified build artifact getters
also stop retaining decoded strings after access. Compact metadata updates preserve
sealed source evidence, including older inline records. New compressed inventory
sidecars join the same hardlink pool, avoiding independent copies across new
materializations. Existing sidecars were not bulk rewritten, so their original
356 MiB footprint is not claimed as an immediate saving.

Transport prewarming owns one source read through both codec publications, cleans
its temporary files, closes admission at shutdown and joins all scheduled jobs.
The waiting owner receives the original job failure. File-backed queued jobs keep
paths rather than decoded source buffers. A transport disk quota and bounded
admission policy remain work to design; this change does not claim those limits.

Panel/app bundle responses also had backpressure waits that only listened for
`drain`. A disconnected client could strand that operation and its buffers.
Panel, app and RPC response streams now share one lifecycle-owned writer that
settles on drain, response close or the original write error and removes its
listeners. Tests cover synchronous close during write, already-destroyed
responses, delayed drain and original error propagation.

System development session/run pagination now applies its cursor, order and
`limit + 1` lookahead in SQL. Only returned run rows are reconciled. Counting active
runs uses SQL without decoding historical payloads. Owner/history indexes avoid
sorting all session rows; an explicit schema v1-to-v2 upgrade preserves existing
sessions and is verified against the exact source and target fingerprints.

Native profiles from the final host code returned successful reports for Chat,
Shell and New. All repeats preserved build keys and the original emitted/source
byte totals:

| Target | First read of preexisting build | Verified repeat | Emitted bytes | Source inventory bytes |
| ------ | ------------------------------: | --------------: | ------------: | ---------------------: |
| Chat   |                        7,325 ms |         23.9 ms |     8,057,651 |             17,713,003 |
| Shell  |                        7,784 ms |         20.5 ms |     9,367,039 |             19,217,074 |
| New    |                        3,036 ms |         13.5 ms |     1,843,323 |              2,836,364 |

The earlier warm samples were 87, 25 and 16 ms respectively. These are local
samples confirming working cache reuse after collection, not latency distributions
or a claimed whole-host RAM reduction. First-read times include materialization
and native build reporting. The SQL API boundary was checked against
[Cloudflare’s SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/);
limited cursors are consumed synchronously before reconciliation awaits. The source inventories remain available to explicit
profiling while ordinary metadata stays compact.

Validation passed focused host/import and six projected System tests,
including pool publication/collection races, cross-device publication, source
preservation, HTTP compatibility, byte eviction, shutdown/error propagation,
SQL cursor ties, ownership filters, query planning and the persisted schema
upgrade. One template test invocation reported a shutdown stall after passing;
a diagnostic rerun with the hanging-process reporter exited cleanly without an
active-handle report. No timeout policy was changed. Host and System composition typechecks, the production host build,
focused lint and template checkout hygiene passed. The owned eval sessions were
detached and both incarnations of `resources-cut-20261005` were stopped. Their
private roots and supervisor/server/workerd processes were retired; no inspector
or page connection was opened.

Remaining substantive targets are Chat's history/active-work projection ownership,
compiler-worker memory attribution, historical HTTP record/style indexes,
transport disk/admission budgets, incremental client-cache maintenance, whole
browser-database import amplification, and release/diagnostic operation retention.
Those findings remain visible above. No transcript history, execution evidence,
shared dependency installation, user database or unrelated process was sacrificed
to obtain the measured storage saving.

## Follow-up across the eight remaining targets

This follow-up changes the host, browser import package, Base Chat/protocol, and
System development store. It does not claim that every historical projection is
now bounded: the remaining Chat ownership boundary is described explicitly below.

| Target                                    | Implemented change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Remaining limitation                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat                                      | The rendered window owns one message array; removed the parallel ordering/map and unbounded projected-ID set. Only selected messages receive attachment copies. Pagination cannot move the reducer's live cursor backwards. Detaching a view cancels its event subscription and releases its transcript/attachment state; unread subscriber buffers are discarded, late subscribers observe the producer's original terminal result, and old history replies cannot mutate a detached view; returning a subscription cancels and joins pending readiness/event reads without closing the shared client. | The canonical reducer and attachment provenance still retain loaded history. Full history bounding requires an authoritative channel-owned projection, described below. |
| Compiler workers                          | Native snapshots attribute each owned worker's heap and external memory. Typechecking retains one lazy build-system-owned worker across edited states, while disposing each request's program. Lowering, RPC catalogs and immutable trees belong to overlapping build closures; their last-owner retirement is joined. Reinitialization for the same host reuses the clients.                                                                                                                                                                                                                           | Main-process and workerd residency remains measurable separately; worker disposal is not a guarantee of an immediate RSS decrease.                                      |
| HTTP metadata/styles                      | Verified descriptors, activated records and shared-style records have byte-weighted LRU residency. Retained styles are reconstructed from their owning build metadata after serving-cache eviction. Recent shared-hit diagnostics are also bounded.                                                                                                                                                                                                                                                                                                                                                     | A cold shared-style lookup scans retained manifests; this avoids another persistent ownership index, but cold lookup cost is proportional to retained build count.      |
| Transport derivatives                     | Shared disk root has the standard 2 GiB derived-cache budget. At most two opportunistic prewarm jobs are admitted; excess work is left to on-demand serving. Reads and codec publication hold leases; shutdown joins admitted jobs.                                                                                                                                                                                                                                                                                                                                                                     | Active responses and admitted source reads are legitimate work and can temporarily exceed retained-cache budgets.                                                       |
| Desktop disk cache                        | SQLite owns request mappings, access order and incremental blob-byte accounting. Writes update affected records. Startup reconciles interrupted publications once without erasing persisted recency. Default retention decreases from 64 GiB to 2 GiB. Opened response streams own and pin their files until completion/cancellation.                                                                                                                                                                                                                                                                   | The byte budget accounts for blob payloads; SQLite/sidecars add overhead. It is a retention budget, not a response limit.                                               |
| Browser import                            | Native read-only SQLite replaces the whole-database Buffer/WASM copy. Iterators map directly to normalized output, and crypto queries use first-row reads. Async decryption remains inside the database lifetime; wide timestamps preserve integer precision.                                                                                                                                                                                                                                                                                                                                           | Public import results still contain normalized arrays. This is not an end-to-end streaming import contract.                                                             |
| Shared authority/registry/dependency data | Authority facts/indexes have serialized-byte and count budgets; workspace-local authority residency has a byte-weighted bound. Registry downloads now participate in live-safe leased collection. Dependency deduplication uses process-owned maintenance claims; the server joins its maintenance children.                                                                                                                                                                                                                                                                                            | Lease ownership, not elapsed time, controls collection. Live dependency installations remain protected even across long operations.                                     |
| Release/diagnostic retention              | Packaging chooses OS, CPU and Linux glibc dependencies for each target, runs in an owned staging tree, promotes completed installers and retires scratch. Completed full trajectories are losslessly compressed; receipts remain JSON.                                                                                                                                                                                                                                                                                                                                                                  | Linux x64 file closure was packaged and checked. Installer signing/distribution and other platforms were not exercised. Completed evidence is preserved, not expired.   |

### Measured follow-up savings and verification

The live-safe storage command compressed **457 completed full trajectory exports**
from **626,029,925 bytes to 179,968,139 bytes**, saving **446,061,786 bytes
(425.4 MiB)**. Before removing each original, the operation compared its streamed
hash against decompressed output and checked that the original file had not
changed. Caller-selected export directories and unfinished runs were excluded.
This adds to the previously measured 7.23 GiB artifact-pool collection; it is not
inferred from a whole-filesystem free-space delta.

A controlled, disk-backed browser fixture contained **65,536 rows** in an
**89,706,496-byte database**. Separate processes produced the same normalized
record count and ID checksum. The prior Buffer/WASM/row-array path peaked at
**232.7 MiB RSS**, and native SQLite with direct iterator mapping peaked at
**120.8 MiB RSS**. This one synthetic fixture demonstrates database-import
amplification removal; it is not a distribution of real browser-profile results.
Both fixture processes were joined and their owned database tree was removed.

Worker attribution found library lowering retaining approximately **545 MiB** of
used heap, RPC catalogs **102 MiB**, and immutable trees **13 MiB** at a completed
startup boundary. An earlier typecheck sample retained **314 MiB**. Before the latency review below, the
build-batch ownership changes produced native host snapshots with **no retained measured
compiler workers** before or after each completed Chat/Shell/New profile.

| Target |                 First profile run | Verified warm repeat | Same build keys | Report |
| ------ | --------------------------------: | -------------------: | --------------- | ------ |
| Chat   | 10,920.6 ms, built during profile |             110.8 ms | yes             | ok     |
| Shell  |           8,972.0 ms, preexisting |              28.6 ms | yes             | ok     |
| New    |           4,176.6 ms, preexisting |              29.9 ms | yes             | ok     |

These timings include report/materialization work. Other host workloads were
running, and Chat source changed, so they are compatibility evidence, not an
isolated latency improvement claim. Server RSS across the three samples was
roughly 771–1,116 MiB; it is not interchangeable with worker heap measurements.
The owned managed instance and eval session were stopped/detached after sampling.

A real Linux x64 unpacked package passed the existing native and userland-boundary
checks, retained its **134,697,920-byte x64 workerd** and excluded ARM64 native
packages. The subsequent Linux libc selection is covered by the package selector
tests. This closure check disabled dependency rebuilding to avoid changing the
development install's native ABI; it does not substitute for installer/runtime
verification. Packaging scratch was removed on both the investigated failures
and successful verification. The corrected configuration is supplied as one file,
preventing electron-builder from merging the repository resource arrays twice.

Focused verification includes 319 host/import tests; subsequent changed ownership,
HTTP and builder suites; Base Chat/protocol/testkit and PubSub lifecycle tests; System development-store
tests; host, Base and System composition typechecks; native build profiles; a
production build; package dependency closure; lint; host boundary; and template
checkout hygiene. Receipts remain private under the evidence directory named
above. No desktop renderer heap or real long-session Chat heap was measured.

### Chat's unresolved ownership boundary

The full-history reducer is not a disposable cache: it contains terminal-turn
version guards, envelope deduplication, recipient snapshots, custom-card update
history, tool/approval relationships, and attachment provenance. Evicting a
message by its rendered ID cannot establish that those records are disposable.
An older page can otherwise resurrect closed work or produce an incomplete card.
The bounded window changes above remove redundant rendering ownership while
preserving these semantics; they do **not** solve reducer-history residency.

The clean design is to materialize normalized transcript roots at the channel's
existing durable log owner, atomically advancing a canonical sequence cursor.
Store message/tool/card roots and their turn relationships individually in SQL;
query a bounded historical window plus the active-work dependency closure.
Initial replay and pagination must return that authoritative projection at a
causal cut, and the existing channel stream must carry versioned root changes.
Ephemeral deltas update active projected messages; durable terminal records win.
Closed-history records, deduplication and terminal guards remain at the log owner,
so the client can release roots outside its loaded window without guessing.

This requires changing the channel projection/replay contract and verifying fork
inheritance, out-of-order delivery, pagination during live work, card reduction,
approvals and attachment recovery together. That migration remains open. A local
slice, age expiry, duplicate IndexedDB log or ID-parsing pruning rule would not
repair this ownership boundary and was not introduced.

## Latency review: keep typechecking warm (2026-10-05)

Terminating every compiler worker at a completed build/report boundary imposed
measurable editing overhead. The final policy retains **one lazy typecheck worker
per build system until explicit shutdown**. Each request still creates and
finally disposes its TypeCheckService, native compiler API and program; this does
not add a cache of prior source states or programs. Babel lowering, RPC catalogs
and immutable-tree workers keep their build-closure retirement policy. Other
memory/storage optimizations are unchanged.

The comparison used native `profileHost(() => profileBuild(...))` on two separate
managed source-mode instances, each provisioned through a successful doctor.
Each instance had its own initially empty, disk-backed derived/npm cache. In one
semantic context, six successive block-comment edits to each panel entry changed
its source/effective version without changing UI behavior. Sample zero was warmup;
the following five samples form the comparison. Every first report proved
`built-during-profile`, every immediate repeat reused its build keys, and all
corresponding build keys matched across the two arms. This measures the canonical
changed-state build/report boundary, not renderer rebuild or end-to-end panel
readiness. Source-mode worker startup includes its TSX bootstrap; packaged-release
startup may have a different cost.

| Target | Retire typecheck: median | Keep typecheck warm: median |              Difference |
| ------ | -----------------------: | --------------------------: | ----------------------: |
| New    |               5,015.0 ms |                  4,424.0 ms | 591.0 ms / 11.8% faster |
| Chat   |              10,560.5 ms |                  9,764.7 ms |  795.8 ms / 7.5% faster |

New's five samples ranged from 4,982.4–5,175.4 ms with retirement and
4,393.4–4,513.5 ms warm. Chat ranged from 10,490.8–10,720.9 ms retired and
9,709.1–9,886.0 ms warm. A separate training workload was active during both arms;
these small sequential samples support the lifecycle decision but are not an
isolated latency distribution or a packaged-desktop performance guarantee.

Keeping the worker warm has a real memory price. Median post-operation server RSS
increased from 1,119 to 1,231 MiB for New and 1,240 to 1,358 MiB for Chat in these
runs; those process differences also include allocator and host-state effects.
The same typecheck thread served all twelve profiles. Its post-Chat used heap
ranged roughly 122–241 MiB and external memory 64–96 MiB in the five measured
samples, with decreases between samples rather than monotonic accumulation.
Worker heap/external statistics are not RSS, peak live allocations, or a hard
memory ceiling. The larger build-only worker residency stays retired.

Focused regression checks exercise reuse across completed requests, settlement
of queued requests on explicit shutdown, and joined worker removal. Existing
build-closure retirement and canonical report/typecheck tests remain applicable.

Evidence is private under
`~/.cache/vibestudio-performance/2026-10-05-edit-loop/evidence/`:
`retired-valid.txt`, `warm.txt`, `comparison.json`, doctor/detach/stop receipts,
and focused verification logs. The initial baseline script had a newline-escaping
error; its failure evidence is retained in `retired.txt`, and no failed sample
enters the comparison. Both scripts restored their edited files in `finally`.
Both eval sessions detached, both exact managed instances stopped, their temporary
roots disappeared, and both caller-owned cache trees were removed after their
workloads joined.

Verification passed: 43 focused tests (typecheck requests/programs, build-closure
retirement and canonical build reports), host and workerd-program typechecks,
focused formatting/lint, template-checkout hygiene and `git diff --check`.
