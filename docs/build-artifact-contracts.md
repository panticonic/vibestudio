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

Build ownership and reuse live in `build.mjs`, so direct builds and desktop launchers use the same lock and freshness check. A matching source fingerprint reuses artifacts only after their contracts pass. Compatible esbuild entrypoints share an invocation; separate compiler realms run sequentially. Failed builds leave no reusable success marker.

Infrastructure package builds hash their compiler inputs and verify emitted output. Source edits retain incremental compiler state; missing or changed output resets it. Files retired from the compiler program are removed from `dist` after compilation. An excluded test only invalidates production output when production code imports it.

`pnpm type-check:host` and `pnpm type-check:userland` retain each original compiler program, including its global/module augmentations, source aliases, tests, and compiler options. Compiler realms and template compositions run sequentially. Incremental no-emit state is seeded privately and retained when the compiler completes, including cached diagnostics from a failed check. Compiler errors still propagate; cancellation or launch failure retains the preceding state. Temporary configurations and unpublished state are removed. State lives under the host checkout's `.cache/typecheck-state`, with derived-cache leases and quotas. Template source and installed dependencies are projected into host-owned temporary directories, so no compiler state is written into external template checkouts.
