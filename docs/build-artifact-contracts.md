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

`pnpm type-check:host` and `pnpm type-check:userland` retain each original compiler program, including its global/module augmentations, source aliases, tests, and compiler options. Compiler realms and template compositions run sequentially. Incremental no-emit state is seeded privately and retained when the compiler completes, including cached diagnostics from a failed check. Compiler errors still propagate; cancellation or launch failure retains the preceding state. Temporary configurations and unpublished state are removed. State lives under the host checkout's `.cache/typecheck-state`, with derived-cache leases and quotas. Template source and installed dependencies are projected into host-owned temporary directories, so no compiler state is written into external template checkouts.

## CI and release parallelism

The CI graph in `.github/workflows/ci.yml` expresses per-platform artifact
dependencies, rather than broad verification barriers. Native producer jobs
prepare executor payloads and source-attested Darwin observers once. Each Unix
verification job waits only for its platform's producer. The macOS application
candidate waits for Darwin inputs; the Windows candidate starts independently.
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

A GitHub Actions `needs` edge to a matrix job waits for every matrix leg. Use
separate named jobs when consumers need different subsets of its outputs;
otherwise a slow unrelated producer serializes those consumers. Keep platform
variation in shared reusable workflows rather than copying build recipes.

The reusable CI workflow must still succeed in full before the release
workflow creates its draft. Windows installer jobs prepare private, run-scoped
candidates alongside that validation, using read-only repository permissions.
Linux installers wait for the reusable CI boundary because their native input
producers are internal jobs of that workflow. Exposing those exact producer edges
at the caller is the prerequisite for overlapping Linux packaging with unrelated
checks. Signing, artifact attachment, and making the release public still wait
for the validated draft and exact candidate; installed acceptance remains a
required gate where defined.
The Apple-credentialed macOS build stays behind the draft. Keep `needs` edges
tied to a consumed artifact or another concrete prerequisite, and record that
reason beside the edge. Independent checks should overlap, without rebuilding
the same candidate or weakening its installed acceptance tests.

`pnpm check:workflows` runs a checksum-pinned actionlint against every workflow,
including expression-context and dependency validation, both locally through
the commit/quality gates and in CI. Its semantic checks do not depend on
optional shellcheck or pyflakes installations. Focused workflow tests protect
the actual artifact dependency graph. Use observed job durations to assess the
critical path; a parallel graph alone does not establish a measured speedup.

Local release work should use the available CPU and memory to reduce that critical
path. An aggregate memory limit protects the host from an OOM; it is a ceiling,
not a target for keeping workloads small. Choose build admission from the host's
available capacity and observed peak of the owned workload, leaving room for
unrelated applications. Increase independent admission when those resources are
idle. Account for builds and verification together, and distinguish reclaimable
file cache from process memory before attributing growth to a leak. Avoid duplicate
builds and keep shared mutable artifact production under its existing owner.

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
normal memory use and invalidate the measurement. During that
investigation, admit one composition compiler at a time on this host and leave
headroom for its projection and the desktop. Measure again when the source
graph or compiler changes. Independent unit checks can overlap when their
measured peaks fit the remaining budget.

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
