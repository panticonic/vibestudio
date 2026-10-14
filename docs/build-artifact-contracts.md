# Build Artifact Contracts

Vibestudio builds several artifacts that look similar in source but run in different module systems. Build-system changes should preserve these contracts.

| Artifact                                       | Runtime                               | Format   | Contract                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/main.cjs`                                | Electron main process                 | CommonJS | May use native `require`. Externalizes `electron`, `esbuild`, and native/runtime-heavy deps. Must not contain esbuild's ESM dynamic-require fallback.                                                                                  |
| `dist/server-electron.cjs`                     | Electron `utilityProcess.fork()`      | CommonJS | May use native `require`. Receives config through env vars and IPC. Must not contain esbuild's ESM dynamic-require fallback. Packages such as `@vscode/ripgrep` that resolve installed assets through `import.meta.url` stay external. |
| `dist/server.mjs`                              | Standalone Node server                | ESM      | Must inject `createRequire(import.meta.url)` because bundled CommonJS dependencies can still call `require("process")` or other Node modules. Packages that resolve installed assets relative to their own module URL stay external.   |
| `dist/internal-do.bundle.mjs`                  | workerd/browser Durable Object bundle | ESM      | Must not depend on Node `require`, `process`, or Electron. Browser/workerd-compatible code only.                                                                                                                                       |
| `dist/browserTransport.js`                     | Browser panel runtime                 | IIFE     | Must not depend on Node `require`, `process`, or Electron.                                                                                                                                                                             |
| `packages/extension-host/dist/index.js`        | Node ESM package loaded by the server | ESM      | Must inject `createRequire(import.meta.url)` because bundled CommonJS dependencies, currently `yaml`, call Node builtins through `require`.                                                                                            |
| `packages/extension-host/dist/childRuntime.js` | Node child process runtime            | ESM      | Runs as a forked Node process. Keep Node-only APIs explicit and avoid importing Electron.                                                                                                                                              |
| `packages/process-adapter/dist/index.js`       | Node ESM package                      | ESM      | Uses `createRequire(import.meta.url)` only for optional Electron loading. Plain Node must keep working.                                                                                                                                |

`pnpm build` runs `scripts/check-build-artifacts.mjs` after building. The same check can be run directly with:

```sh
pnpm run check:build-artifacts
```

When changing esbuild options, package `"type"`, `external`, `conditions`, or package boundaries, run a full build and this check before testing Electron startup.

Build ownership and reuse live in `build.mjs`, so direct builds and desktop launchers use the same lock and freshness check. A matching source fingerprint reuses artifacts only after their contracts pass. Compatible esbuild entrypoints share an invocation; independent compiler realms run concurrently, and all admitted compilations are joined before reporting failure. Failed builds leave no reusable success marker.

Infrastructure package builds hash their compiler inputs and verify emitted output. Source edits retain incremental compiler state; missing or changed output resets it. Files retired from the compiler program are removed from `dist` after compilation. An excluded test only invalidates production output when production code imports it.

`dist/cli/client.mjs` also exposes the canonical selected-workspace client factory.
Importing it does not execute a command. The typed release verifier runner imports
that exact installed entry, multiplexes calls on one owned connection, and joins
calls and client retirement before reporting results. Authentication and RPC
remain owned by the ordinary CLI client implementation.

Build metadata has one strict wire schema in `packages/service-schemas/src/build.ts`.
The producer's RPC catalog and per-kind details types derive from that schema,
including argument/result schemas, argument names, and immutable policy scopes.
Persistence validates the same contract before writing and after decoding.
Invalid cached metadata is a cache miss; filesystem and ownership failures retain
their original errors. New producer fields must update this canonical contract
and its complete-record tests, rather than a separate host-only interface.

Internally, `StoredBuildResult` is an immutable build descriptor: its artifact
entries contain manifest metadata, never payload strings. Consumers select the
specific artifact they need; the type rejects payload-bearing wire artifacts
at internal stored-build boundaries. Consumers use the asynchronous reader,
which verifies the file length and SHA-256 integrity before returning bytes.
Text consumers decode only that selected artifact. This keeps panel activation,
metadata inspection, and lazy resources from eagerly reading every artifact.
Materialize payload strings only at the existing `build.getBuild` RPC boundary,
whose wire schema requires them; descriptor and artifact RPCs retain their
manifest-only contract.

The execution-publication journal may synchronously resolve only descriptors
already verified and hydrated in the build store's in-memory cache. Its lookup
does no filesystem I/O while the journal transaction is held and returns a
fail-closed miss when hydration has not happened. Callers must establish the
descriptor through the canonical asynchronous build-store path before entering
that transaction; the journal lookup must not grow a second hydration path.
Fresh publication must admit the promoted descriptor to this same cache after
verification and before returning it, just as a verified cache read does.

An extension with external runtime dependencies publishes its bundle and a
complete `node_modules` projection in the same temporary build directory before
the build-store rename exposes either. The projection receipt records the
platform-specific dependency key only after all copies have joined and the
declared packages resolve inside that tree. The shared build cache carries
compiler artifacts only; each local owner projects the runtime closure for its
host after hydration. A cached projection from an earlier host runtime is
repaired in a private staging directory, then promoted by the process owner
before any BuildSystem runtime accessor returns the extension. Extension
activation uses those accessors; directory existence alone is never a
readiness check.

Async state watches register the subscriber before hydrating their initial
snapshot at a captured sequence watermark. Snapshot records and intervening
live events share one byte budget; snapshots precede newer buffered events.
Snapshot failure errors the response with the original failure and retires the
watch. Request admission is also owned before any asynchronous identity read:
disconnect and shutdown close admission, and retirement joins accepted work.
Finished live requests return errors to their caller instead of retaining an
unbounded server-wide error history. Response readers retain the exact abort
reason, join producer cancellation before releasing their lock, and preserve
read, observer, and cleanup failures together. HTTP and session transports share
this reader lifecycle; cancellation never emits a successful end frame.

`pnpm type-check:host` and `pnpm type-check:userland` retain each original compiler program, including its global/module augmentations, source aliases, tests, and compiler options. Compiler realms and template compositions run sequentially. Incremental no-emit state is seeded privately and retained when the compiler completes, including cached diagnostics from a failed check. Compiler errors still propagate; cancellation or launch failure retains the preceding state. Temporary configurations and unpublished state are removed. State lives under the host checkout's `.cache/typecheck-state`, with derived-cache leases and quotas. Template source and installed dependencies are projected into host-owned temporary directories, so no compiler state is written into external template checkouts.

## Packaged script dependency closure

Npm and desktop producers use `scripts/lib/npm-runtime-script-closure.mjs`
to derive the local dependency graph of their shipped runtime scripts. The
entry roots come from the actual package selection, including every routable
CLI module. Literal imports, re-exports, dynamic imports, CommonJS loads and
`tsImport` targets contribute edges. Helpers under `scripts` are staged at
their original relative paths; existing generated artifacts must already exist
inside the declared artifact boundary. Missing targets and escaping paths fail
packaging before expensive runtime preparation.

Bare imports must be Node builtins, declared production dependencies, or actual
vendored packages. Development dependencies do not satisfy a runtime contract.
The source-only Shared SDK is loaded through `tsx`, so that loader is a production
dependency for both npm and desktop. Desktop file selection and `asarUnpack`
include the same discovered helper closure. Keep the installed-package command
and runtime smoke checks as the final verification of the produced artifact.

## CI and release parallelism

### Startup acceptance and preparation

The startup target is a usable application within seconds on both a fresh install
and an established workspace. Measure from launch through an interactive selected
panel whose required services are ready. A visible loading shell does not satisfy
that boundary. Record cold and warm results separately, with the exact app revision,
template pins, prepared artifact identities, and native startup phase receipts.
Until that boundary has been measured, do not claim that startup meets the target.

Native service-startup evidence includes the existing ServiceContainer ready
message with `startupReport=<JSON>`. Each successful readiness boundary records
the container's elapsed duration, realized critical path, and service names,
dependencies, start/completion times, queue delays, and durations. A later
background extension has its own successful report; a failed extension does not
emit a success packet. These finite graph facts contain no service instances or
configuration. Use the required-readiness packet to attribute startup delays,
not the duration of unrelated background services.

Release producers prepare immutable template source closures and eligible runtime
builds before packaging. The installed consumer waits for complete preparation;
it must consume artifacts matching its content state, source, effective version,
and build identity. Workspace-specific semantic history and protected publication
remain runtime responsibilities. Moving a proof to a producer requires preserving
its authority and binding the proof to the exact installed input.

Development launch can start its consumer once exact template sources and their
captured compiler inputs are materialized. The same owned producer continues
building every runtime in the background. Demand compilation joins the exact-key
shared build coordinator; it does not start a second compiler for the same build.
A source-ready notification is not a completed runtime release. Only joined
production and full publication proof may seal `userland-builds/release.json`.
Installed launches consume that complete release. Keep cold source artifact
production distinct from a cold installed launch with completed prepared
artifacts. Neither increasing a smoke deadline nor serving an unproven workspace
establishes fast startup.

The shared derived cache has two distinct immutable publication phases:

- `workspace-releases` stores the complete
  `vibestudio-workspace-runtime-release/3` publication. Its key binds platform,
  architecture, host generation, host dependency fingerprint, compiler protocol,
  the designated Base/Personal/System roots, and each role's dependency-first
  ordered exact layer pins. The three root pins alone do not identify a
  composition with floating transitive dependencies.
- `workspace-sources` stores the `vibestudio-workspace-sources/1` source phase.
  Its key binds the preparation recipe digest, host SDK/dependency fingerprint,
  system epoch, designated roots, and the same ordered exact layer pins. The
  recipe comes from the immutable generation's published
  `host-preparation-recipes.json` receipt for its actual preparation entry;
  startup does not hash the preparation bundle again. Source records carry the
  complete immutable blob closure and source provenance, but no runtime builds
  or captured compilation input. They retain no workspace SQL databases,
  protected publication/history, provider credentials or credential stores,
  runtime grants, or compiler state.

Dependency metadata resolution and the operation's one current host SDK capture
run independently and join before either cache lookup. The metadata resolver
admits manifest epochs, repository ownership, overrides, and exact transitive
pins without loading every source blob. Composition consumes that captured plan
through the same resolver/composer boundary; it never re-resolves floating
tracks during hydration. Reviewed local metadata can cross the supervisor
boundary as manifest text and repository facts rather than another Git tree
walk.

A completed full-release hit projects its admitted artifacts directly. On a
full-release miss, source acquisition and private source-ready projection happen
before joining the complete background runtime coordinator. That projection
attaches the current operation's compilation input and publishes source
readiness exactly once, allowing developer CLI/desktop startup and selected
demand builds to proceed while the exhaustive runtime batch remains owned.
Warm source readiness reads sealed records and links their cache blobs; it does
not first hydrate the producer's private runtime source paths. Only the winning
background runtime producer later hydrates those paths through the ordinary
prepared-template bootstrap hook. Cold source production retains its already
materialized role states for that continuation. If another producer supplies the
complete release while this operation waits, no redundant runtime hydration or
second source-ready notification is needed.

The critical dependency edges are:

```text
exact metadata plans + current host SDK capture (independent)
  -> complete-release lookup
     -> hit: complete artifact projection -> consumer startup
     -> miss: source publication/projection -> consumer startup + selected demand
                  -> background runtime coordination -> required private hydration
                     -> all runtime builds + publication proof -> complete release
```

Source readiness is not workspace authority: each consumer still creates its
own workspace state, initializes semantic protected main, and admits required
runtime executions. Fresh scratch paths never form part of either cache key.
A packaged consumer uses its exported complete release and does not depend on
the producer's cache. Packaging still joins every runtime build and full
publication proof before accepting the installed artifact.

Cold verification and profiling select a private cache through the existing
`VIBESTUDIO_SHARED_DERIVED_CACHE_DIR` input; their owner retires that cache after
joining all work. Ordinary launch never deletes the inherited shared cache.
The release orchestrator assigns its one exhaustive producer a bounded batch
build budget from the runner's CPU and memory allocation. Interactive workspace
owners keep their smaller independent budget. Consumers reuse the complete
immutable release keyed by its exact host and template inputs instead of
starting a second producer.

Each phase proves its complete source or executable payload integrity before
atomically exposing its completion record; the full runtime phase also proves
compressed executable inventories. Ordinary reuse admits the sealed identity,
record digests, exact role/layer inventories, descriptors, and file census; it
does not reload and hash every payload. A present but incomplete or mismatched
publication fails admission rather than silently rebuilding over it. Source
records and full runtime records have separate completion markers, so a source
hit cannot satisfy the full production gate. Artifact serving likewise reads the
admitted immutable file without another content hash. Cache projection joins all
payload links or copies before exposing the inherited completion record. These
are phases of one publication contract, not a switch that disables validation.
The source-cache and lazy Git-index leases remain owned through the runtime
continuation. Retirement first joins all admitted work, then releases those
inputs and cache coordination, then removes private scratch; every operation
and cleanup failure remains observable.

The release operation captures host dependency inputs once. Its exact v8 hash
trace is carried by the prepared template record, bound to the host generation,
compiler protocol, and dependency installation policy. A workspace composes its
five current tooling inputs with that trace through the same hash encoding used
by fresh compilation. SDK trees and installed package manifests are not scanned
again by each workspace server. Ordinary development still captures current host
inputs when selecting its release cache; packaged production captures its final
installed dependency realm during preparation.

The CI graph in `.github/workflows/ci.yml` expresses per-platform artifact
dependencies, rather than broad verification barriers. Native producer jobs
prepare executor payloads and source-attested Darwin observers once. Linux
verification waits for its platform's native producer; Darwin verification also
consumes the prepared development-host artifact. The macOS application
candidate waits for the Darwin production-host producer; the Windows candidate
starts independently.
The universal `npm-server-preflight` needs all three Unix producers.
Each installed-acceptance job waits only for the application candidate for its
platform, without waiting for the other platform, native tests, or npm checks.
Its condition requires that exact producer to succeed: a dependency edge alone
does not prevent execution after producer failure when a status-check function
overrides GitHub Actions' implicit success condition. Failed or cancelled
production leaves acceptance skipped and the required release gate unsatisfied.
Shared reusable workflows keep the
platform job definitions consistent. Consumers verify downloaded inputs before
use. Run-scoped artifact names and observer attestations bind them to the
current workflow revision.

Linux quality has its own source-input edge. `quality-inputs` checks out the
selected Base ref and complete template catalog once, builds the infrastructure
packages once, and uploads those outputs with a receipt for the host commit,
infrastructure manifest, and every template commit and tree. The `quality`,
`quality-followup` CI caller of the `quality-linux` reusable workflow, and
`quality-desktop` jobs verify that receipt after
restoring the exact artifact. Template type-checking and the complete userland
suite stay together in `quality`; the mobile, host-boundary, packaged host,
lint, formatting, and unit checks run in `quality-linux`. Native remote
transport and desktop pairing run in `quality-desktop` so they share one
development host build. Each quality consumer owns its generated files on its
own runner, while the infrastructure packages and template inputs come from the
single `quality-inputs` producer. All three jobs are required by reusable CI
before a release tag can be created. This lets the follow-up checks overlap the
long userland suite; artifact transfer and job durations determine the actual
wall-clock saving.

Darwin packaging and source integration use two host modes with distinct
fingerprints. One macOS-14 production-host job installs the exact native and
observer inputs, builds the production desktop generation, runs its native
acceptance, and uploads immutable generation records and payloads, infrastructure
package outputs and their cache receipt, the original Darwin native isolation
input required by the packaging hook, and a source-SHA receipt. Transport
admission verifies that native input through the canonical matrix validator;
the staged runtime alone does not satisfy the packager's input contract. Transient
generation locks, leases, staging, and garbage directories are excluded. The
version-2 generation pointer identifies an immutable directory; its version is
independent of the version-1 build fingerprint receipt inside that directory.
Transport admission compares that receipt against current source inputs, then
checks that the pointer's mode, fingerprint, and input count identify the same
build. Pointer format versions must never be compared as build receipt versions.
The application candidate and a separate development-input producer are sibling
consumers of this artifact, so source preparation does not wait for app
packaging. The development producer builds the development source generation
once, resolves the eight official template checkouts (including the requested
Base ref), and prepares their complete workspace runtime release once. It
uploads one source-SHA-bound archive containing those exact template Git
snapshots, both host generation modes, infrastructure outputs, and the prepared
release. MacOS-14 source integration and macOS-26 native verification consume
and verify that archive; they do not compile the host or re-prepare the template
runtimes. Ordinary startup still validates and reuses the prepared release
against the current host and template pins. Installed-app acceptance remains an
independent consumer of the packaged candidate and does not wait for source
preparation.

Public Iroh Vitest entrypoints prepare their development desktop generation
before shared test setup reads it. Android smoke owns a source-server generation,
not a desktop generation: its public command first builds infrastructure packages
needed by the CLI import closure, then the CLI prepares the host and complete
workspace release before the bounded server-readiness and interaction phases.
Desktop and website smokes use the same phase boundary: they prepare the source
host and validate or produce the exact workspace release before starting their
acceptance deadline. An inherited release root goes through the canonical
producer's full input validation. The source server validates and reuses the
completed release through the normal producer. Device installation and preparation retain owned process lifetimes;
cleanup joins them before retiring the generation lease or scratch. The nightly
workflow invokes those public entrypoints instead of substituting a production
build or bypassing their prerequisites with a raw test command. Linux source
runners share one setup action for bubblewrap, credential-service dependencies,
and the exact checkout MXC AppArmor permission; desktop consumers also request
Xvfb. Packaged-app and npm consumers retain their own artifact-path profiles.

The npm preflight retains its canonical `npm pack` archive after staging,
dry-run, and fresh-install smoke checks succeed. Its artifact name includes the
exact source SHA and run attempt; its receipt records package identity, archive
length, and SHA-256. Publication may reuse that archive from the matching
successful CI run after all release gates succeed. Run
`pnpm publish:server-npm -- --candidate-receipt PATH` against that exact checkout.
The publisher verifies the receipt against Git HEAD and package version, checks
the archive length and SHA-256, and validates the installed package manifest.
The ordinary producer packs once; dry-run, fresh-install smoke and publication
consume the same archive bytes, followed by registry verification and smoke.
CI uses `--candidate-output DIR` to retain that verified archive and receipt.
Receipt reuse avoids another build, stage and pack without bypassing acceptance.
This candidate is an output of the ordinary producer, not a separate packaging
implementation. Record producer, transfer, and final publication wall-clock
times before claiming a measured deployment speedup.

A GitHub Actions `needs` edge to a matrix job waits for every matrix leg. Use
separate named jobs when consumers need different subsets of its outputs;
otherwise a slow unrelated producer serializes those consumers. Keep platform
variation in shared reusable workflows rather than copying build recipes.

The protected-main push CI run is the authoritative release candidate run for
its exact source SHA. It resolves the stable committed version, runs every
quality and native check, produces each enabled signed installer candidate,
and installs and launches each required candidate. Its final candidate gate
requires every applicable result to succeed and emits a receipt binding the
source SHA, version, enabled platforms, canonical Windows runner, and the exact
commit and tree of every official template consumed by the quality checks.
The Darwin development source and npm preflight consume the quality producer's
manifest and pin every official template to its recorded commit and tree before
building. Independent producers still start when their own inputs are ready;
the final gate joins them without serializing their builds. PR and ordinary
manually dispatched diagnostic CI runs cannot
supply a release candidate. If a push candidate fails for an external reason,
manually dispatch the same CI workflow at the same `main` commit with
`release-candidate=true`; it executes the same complete graph and creates a
new authoritative run ID without requiring a no-op source commit. Candidate
retries must use the canonical `base-ref=main` and `windows-runner=windows-2025`
inputs; diagnostics can still select alternatives but cannot publish. The
release dispatcher verifies the receipt's complete template identities and
runner before tagging.

Once the diagnostic workflow is present on the default branch, run a focused
check against the branch with a fix by selecting that branch with `--ref` and
choosing the failing expensive job:

```sh
gh workflow run ci-diagnostic.yml --ref my-fix-branch \
  -f target=linux-installer-x64
```

Targets are `npm-server-preflight`, `linux-installer-x64`,
`linux-installer-arm64`, `windows-installer-candidate`, `quality-desktop`,
`quality-linux`, and `android-iroh-smoke`. `quality-linux` invokes the same
reusable workflow as CI and prepares `quality-inputs` with the selected
`base-ref`. `application-candidate-mac` also reruns the Darwin native
input, production-host build, macOS application candidate, installed-app
acceptance on macos-14 and macos-26, installer packaging, and installed release
acceptance. It calls the same reusable installer and release-acceptance
workflows as protected CI. That target requires `release-tag` set to the exact
`vX.Y.Z` version in `package.json`, so
the reusable candidate workflow exercises its release-candidate validation
path. It passes Apple signing secrets only on `main` when `RELEASE_MAC=true`;
feature-branch runs therefore exercise the empty-secret path without exposing
signing credentials to branch code. The reusable application workflow applies the same
all-five-or-none credential handling. On a feature branch, the diagnostic
installer follows the candidate's ad-hoc signing mode and still verifies the
DMG checksum, app signature, installation, and launch path.
For example:

```sh
gh workflow run ci-diagnostic.yml --ref my-fix-branch \
  -f target=application-candidate-mac \
  -f release-tag=v1.2.3
```

The workflow runs the selected job's declared
prerequisites and calls the same reusable workflows as CI or the Iroh nightly
workflow. The Android target runs only the Android Iroh emulator job; dispatching
`iroh-e2e-nightly.yml` directly still runs its desktop and Android jobs together.
The diagnostic workflow does not call release metadata or the release
candidate gate. Its macOS target alone sets the reusable app job's
`release-candidate=true` to reproduce that packaging path. The top-level
workflow does not offer a full-candidate switch, and its run and artifacts are
separate from the protected-main `CI` workflow run that release publication
requires.

While a version tag does not yet exist, any protected-main push could become
the requested release SHA, so enabled candidate packages are produced in that
CI run. Once the version is tagged, subsequent same-version pushes skip only
release-candidate packaging and signing; normal quality and application checks
continue. The next version bump admits candidate production again. This keeps
the release source selectable by exact SHA without rebuilding its full CI
graph at publication time.

Release publication is a manual dispatch from `main` with that CI run ID, the
exact version tag, and full source SHA. Before creating an annotated tag, the
workflow checks the tag against the checked-out commit and stable package
version, verifies the run belongs to this repository's CI workflow and a
successful protected-main push or explicit candidate retry at the exact SHA,
checks its required unexpired artifacts, and reads the final gate receipt. It
rejects a changed platform configuration. Prerelease and build-metadata versions
are not accepted in this
`--latest` release lane. The tag is never moved or overwritten. Publication
pins the verified run's exact successful attempt and each required artifact ID
and archive SHA-256 digest. Tag creation and publishers recheck that specific
attempt through GitHub's attempt API, download by artifact ID, verify the
archive digest, and then check installer checksums. A later rerun of the CI run
does not change the accepted attempt or substitute same-name artifacts;
publication fails if one of the pinned artifacts is deleted or expires.
Publication does not rebuild the
application or re-run CI. If the candidate CI run fails, repair it before
dispatching Release. After a pre-tag dispatch failure, rerun
the dispatch against the same successful CI run while its artifacts are
retained; after a post-tag publisher failure, use **Re-run failed jobs** on the
Release workflow. Do not rerun candidate CI to repair publication: once the
version is tagged, that CI workflow skips candidate packaging, while the
original successful attempt remains the publication authority. The final
publication job
serializes only the shared latest-release promotion and compares stable semantic
versions, so an older release cannot demote a newer latest release. GitHub keeps
one running and one pending job per concurrency group; a third concurrent
publication can replace the pending middle run. That run's tagged release stays
a draft. After the newer publication finishes, use **Re-run failed jobs** on
the canceled middle run; its draft then publishes without becoming latest.
Mobile and nightly workflows remain separate checks.
Keep the workflow name `Release`: the Linux repository publisher is triggered
by its successful `workflow_run` completion.

The CI graph keeps quality checks and native-input production
independent. On configured Windows releases, the installer candidate consumes
the exact `packaged-app-win32-x64` layout produced by the Windows
application-candidate job. The artifact name includes the exact workflow SHA.
It uses electron-builder's `--prepackaged` NSIS path,
so installer creation does not rebuild the tested application. The candidate
is named with the workflow SHA and remains read-only. Its installer-acceptance
job depends only on that candidate and checksums, installs and launches the
exact installer, and retains diagnostics. On configured macOS releases, the
canonical `--dir` application candidate receives Apple credentials only in its
packaging step; electron-builder signs and notarizes that app before its
acceptance. A provenance manifest binds the archive digest, source SHA,
version, signing mode, and afterPack receipt. DMG/ZIP packaging consumes that
verified app with `--prepackaged`, and installed-DMG acceptance is a sibling
downstream of that packaging job. Linux installer jobs similarly consume only
their matching native inputs. After both architectures pass, a pre-tag signer
validates their original checksums, signs the RPMs with the repository key,
verifies those signatures, and uploads one immutable candidate with canonical
final checksums. The post-tag publisher only verifies those checksums and
attaches the candidate. The final release job joins every enabled publisher;
the exact successful CI candidate gate is checked before tagging.
The prepackaged installer job runs `pnpm build:infrastructure` before invoking
electron-builder: it eagerly imports configured hooks even when `--prepackaged`
skips their execution, and the hook import closure needs the built RPC package.
This does not rebuild the application layout.
Linux installer candidates live inside the same reusable graph as their native
inputs. Separate x64 and arm64 application producers each wait only for their
matching native payload. Each builds and prepares one installed application.
The packager promotes that application only after the `afterPack` hook writes a
completion receipt for the exact platform, architecture, and output directory;
an unfinished hook cannot leave a publishable app. Electron Builder uses
`linux-unpacked` for x64 and `linux-arm64-unpacked` for arm64 here, so the
producer resolves its actual staging path and publishes the common
`release/linux-unpacked` archive path for the format jobs.
Debian, RPM, and Arch format jobs then run concurrently from separate copies of
that exact application: the package tool writes metadata into its input tree,
so the copies are required to keep format jobs independent. The candidate job
joins all three format results and uploads checksum-protected installers bound
to the exact source SHA. Neither architecture waits for the other, native
verification, or the quality suite. These candidates run for configured Linux
protected-main push runs before the release workflow creates its tag.
All post-tag publishers wait for the validated draft and consume artifacts from
the previously verified CI run. Keep `needs` edges tied to a consumed artifact or another
concrete prerequisite, and record that reason beside the edge. Independent
checks should overlap, without rebuilding the same candidate or weakening its
installed acceptance tests.

`pnpm check:workflows` first validates the desktop runtime script import closure
using the same implementation as desktop packaging and npm staging. Shared
script helpers must live in the packaged script boundary; source-only adapters
may re-export them, but packaged scripts cannot import those adapters. This
check rejects missing imports and undeclared runtime dependencies before builds.
Path membership is matched directly against the declared patterns; it must not
enumerate unrelated generated directories once for every import. Ordered
exclusions and exact-directory declarations still determine the same closure.
It then runs a checksum-pinned actionlint against every workflow,
including expression-context and dependency validation, both locally through
the commit/quality gates and in CI. Its semantic checks do not depend on
optional shellcheck or pyflakes installations. Focused workflow tests protect
the actual artifact dependency graph. Use observed job durations to assess the
critical path; a parallel graph alone does not establish a measured speedup.

Release preparation and dependency-maintenance children inherit their owner's
OS scheduling priority. They must not silently lower it: maintenance holds shared
cache writer authority and becomes required work when its owner retires. Resource
admission and the caller's scheduling policy govern throughput and host usability;
an OOM ceiling does not require conserving otherwise available memory.

Local release work should use the available CPU and memory to reduce that critical
path. An aggregate memory limit protects the host from an OOM; it is a ceiling,
not a target for keeping workloads small. Choose build admission from the host's
available capacity and observed peak of the owned workload, leaving room for
unrelated applications. Increase independent admission when those resources are
idle. Account for builds and verification together, and distinguish reclaimable
file cache from process memory before attributing growth to a leak. Avoid duplicate
builds and keep shared mutable artifact production under its existing owner.

Protected-ref validation likewise admits a tree read when its parent is available,
without waiting for unrelated nodes at the same depth. One bounded queue reads
each authenticated hash once; later shallower paths reuse that read and propagate
their depth through the graph. Join all admitted reads before returning the
per-root completeness verdict.

## Compiler memory and ownership

Prepared-dependency resolution distinguishes plugin requests from delegation to
esbuild's default resolver. Default delegation must bypass every composed plugin,
including framework deduplication; otherwise a plugin can request resolution
from `node_modules`, the authority can delegate from its parent, and the same
plugin can restart that request indefinitely. The real-esbuild composition
regression in `builder.dependencyEnvironment.test.ts` verifies this boundary.
Compiler diagnostics report admission and terminal completion before a build
receipt exists, so an unfinished resolver can be distinguished from a large
finite module graph.

Every prepared file has one canonical virtual identity, regardless of whether
a plugin rewrites its import or esbuild resolves it directly. Returning a
physical filename in the prepared namespace creates another module instance:
React providers and consumers can then reference different context objects,
and the compiler repeats work for the duplicate graph. Preserve custom plugin
namespaces while normalizing file resolutions through the same owned-root map.
The composition test executes both import forms and checks singleton identity.

Import resolver filesystem reads are asynchronous and memoized within one
immutable build. Dependency content sharing and CAS pruning use the existing
maintenance child, rather than taking profile-wide SQLite writer locks on the
workspace event loop. Newly installed dependency trees are deduplicated while
they are still private staging directories, before atomic publication. Once a
cache tree is published, builders may borrow it; maintenance must not rewrite
that tree. Background maintenance therefore prunes unreferenced CAS content,
while preparation requests carry the exact private staging and destination
coordinates to the existing child and are joined before the caller publishes.
One maintenance owner admits one child at a time because its jobs mutate the
same content store. Every admitted child retains its natural process handle
until terminal close, including pruning. An awaited promise does not keep Node
alive; unreferencing its child can retire the parent before the owned work
settles. Only the idle scheduling timer may be unreferenced, before it admits
any job. Independent workspace builds continue while that child
runs. At retirement, first join cache-prune callbacks that can admit
maintenance, then join maintenance and artifact publications, then close their
coordinators and remove scratch. Standalone projection commands and awaitable
test-runner teardown own the same retirement sequence; reusable build functions
release their borrow without closing another caller’s process-wide resources.
Both servers and release producers retain all
failures through this dependency order; an ownership failure keeps its state
anchor until the owner has actually retired.

Dependency maintenance acquires ordinary digest lease rows in bounded batches,
rather than committing an acquisition and release transaction for every file.
The existing collector sees the same ownership rows and requires no new schema
or locking protocol. Hashing and publication stay bounded; every admitted file
finishes before the batch releases its leases. A failed batch stops further
admission and retains publication and release failures together. Fewer commits
are a code-level reduction in storage work, not a measured end-to-end speedup.

Responsiveness samples record their actual elapsed interval. Existing warnings
also include process user and system CPU deltas: event-loop utilization counts
synchronous native waits as active, so high utilization alone does not prove a
JavaScript CPU bottleneck. Process CPU includes worker threads and cannot
identify the blocking owner without operation or stack evidence.

Each semantic GC snapshot proves semantic, protected-main, execution, and cached
workspace roots through one operation-scoped batch. Shared tree nodes and content
are verified once within that snapshot. Strict-root failures prevent sweeping and
retain every original failure; disposable cached views are evicted using the exact
captured cache identity. The final GC snapshot remains a separate lifecycle edge
that captures roots admitted during the first snapshot.

A required build-state publication observer returns its original operation failure
to the protected-ref store, which retains the pending observer receipt for replay.
Its recovered admission queue permits later publications; joining that queue is a
terminal barrier, not evidence that every publication succeeded.

BuildV2's three build lanes belong to one Node process. They are not a host-wide
resource budget: the Hub's template preparation and each workspace server have
independent builders, and each compiler can fan out internally. Do not multiply
these lanes by the number of workspaces and describe the result as bounded host
concurrency. A shared compiler-admission design must account for all those
owners and their child processes, retain interactive demand, and release capacity
only after the admitted operation has actually terminated.

Disk-backed derived caches prevent scratch storage from consuming RAM. They do
not bound compiler heaps, output buffers, worker threads, or workerd memory.
Measure the entire owned process tree, including each esbuild child's PID,
parent, peak RSS, and active compilation identity. Node's own RSS and a completed
bundle's size do not measure the compiler child's peak memory. Successful-build
receipts alone cannot identify a compile killed before it wrote a receipt.

Composition typechecks also need a measured memory allowance. On the October
2026 Linux checkout, one Base source/integration check completed in 30 seconds
with a 5.8 GiB process-tree peak; a 6 GiB diagnostic scope killed the compiler
before completion. That scope failure does not establish an unbounded compiler
or a source error; a completed run does not justify its memory cost either.
The measured program contained 4,648 files, performed about 19 million generic
instantiations, and created about 3.9 million types. Attribute excessive memory
to the compiler's actual allocations and type-checking work before declaring
a larger allowance to be a fix. Prefer a heap profile over a full type trace:
retaining and serializing every expanded type can itself exceed the compiler's
normal memory use and invalidate the measurement. For an attribution sample, admit one composition compiler so its allocations
can be attributed to the exact program. Deployment scheduling uses the available
CPU and memory budget: admit independent checks concurrently when their aggregate
measured peaks, projection costs, and desktop headroom fit that budget. Measure
again when the source graph or compiler changes.

TypeScript 7.0.2 defaults to four independent checker instances, with files
assigned across them in its [checker pool](https://github.com/microsoft/typescript-go/blob/typescript/v7.0.2/internal/compiler/checkerpool.go).
The measured trace contained roughly a million types in each checker context;
aggregate diagnostics include that repeated work. Separate process-level
concurrency from this internal replication when attributing memory. Do not
claim that a source abstraction reduces compiler memory without comparing the
same program and retaining its exact diagnostics and public types.

Cold profiling must keep the existing native operation and startup receipts.
On a Linux host with delegated systemd memory controllers, an explicitly sized
memory scope can contain a diagnostic workload so its failure cannot exhaust
the desktop's remaining memory. Run the real managed-instance command inside
that scope, not a substitute build implementation. Keep the cleanup owner and
evidence directory outside the scope: a kernel OOM kill cannot execute a
JavaScript or Python `finally` block. The outer owner must inspect the actual
scope terminal result, stop the exact managed instance, join its processes, and
retire its private scratch paths. Report a resource-limit failure as a failed
measurement; it is not a passing test or a production recovery policy.

Builder retirement closes admission before joining active work. Queued requests
must settle without starting another compilation during shutdown; active builds
retain their worker resources until their terminal result. Close auxiliary
workers only after that join, and preserve operation and retirement failures
together. A timeout, a larger heap allowance, or a smaller local lane override
does not repair missing ownership or establish a safe host-wide budget.

The process owns the compiler admission queue, compiler-worker residency, shared
build flights, and store-maintenance coordination. Each builder session owns its
immutable source provider, root fingerprint, native executor, state root, store,
and diagnostics. Concurrent template roles use separate sessions under one process
owner; they do not switch an ambient source or store between builds.

Shared flights are keyed by the physical cache root and complete deterministic
build identity. A follower hydrates and verifies the result through its own store
and retains its own workspace authority. Cancellation withdraws that caller's
borrow; the producer continues while another borrower needs it. The last borrower
or process shutdown cancels the owned operation. Session retirement joins retained
resources, and process retirement joins every admitted flight and worker close.
Store publication and maintenance failures reach every waiting caller, including
combined operation and cleanup failures, rather than disappearing in detached
logging callbacks.

Merkle scaffold publication follows the actual tree dependency graph. Independent
sibling branches run concurrently under one eight-write admission budget for the
composition. A parent waits for its child hashes, preserves canonical entry order,
and uses the existing authenticated CAS publication path. Every admitted branch
settles before a failure returns, retaining all original errors; the state pointer
is published only after the complete scaffold succeeds. Permit handoff reserves
capacity for the next queued operation before new work can acquire it.

Host-local dependency fingerprinting shares a sixteen-operation I/O budget across
all package trees in one fingerprint. Files stream into incremental SHA-256 hashes,
so concurrency does not retain entire source files. Completion order does not
change the sorted depth-first fingerprint encoding. Sibling preparation failures
are joined before the fingerprint rejects. These bounds keep useful I/O overlap
while preserving content identity and lifecycle ownership.
