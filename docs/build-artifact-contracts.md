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
Shared reusable workflows keep the
platform job definitions consistent. Consumers verify downloaded inputs before
use. Run-scoped artifact names and observer attestations bind them to the
current workflow revision.

A GitHub Actions `needs` edge to a matrix job waits for every matrix leg. Use
separate named jobs when consumers need different subsets of its outputs;
otherwise a slow unrelated producer serializes those consumers. Keep platform
variation in shared reusable workflows rather than copying build recipes.

The reusable CI workflow must still succeed in full before the release
workflow creates its draft. Parallel candidate preparation is not publication
authority: all required verification remains part of the release gate. Keep
new `needs` edges tied to a consumed artifact or another concrete prerequisite;
record that reason beside the edge. Independent checks should overlap, without
rebuilding the same candidate or weakening its installed acceptance tests.

`pnpm check:workflows` runs a checksum-pinned actionlint against every workflow,
including expression-context and dependency validation, both locally through
the commit/quality gates and in CI. Its semantic checks do not depend on
optional shellcheck or pyflakes installations. Focused workflow tests protect
the actual artifact dependency graph. Use observed job durations to assess the
critical path; a parallel graph alone does not establish a measured speedup.
