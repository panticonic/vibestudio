# Build Artifact Contracts

Vibestudio builds several artifacts that look similar in source but run in different module systems. Build-system changes should preserve these contracts.

| Artifact | Runtime | Format | Contract |
| --- | --- | --- | --- |
| `dist/main.cjs` | Electron main process | CommonJS | May use native `require`. Externalizes `electron`, `esbuild`, and native/runtime-heavy deps. Must not contain esbuild's ESM dynamic-require fallback. |
| `dist/server-electron.cjs` | Electron `utilityProcess.fork()` | CommonJS | May use native `require`. Receives config through env vars and IPC. Must not contain esbuild's ESM dynamic-require fallback. |
| `dist/server.mjs` | Standalone Node server | ESM | Must inject `createRequire(import.meta.url)` because bundled CommonJS dependencies can still call `require("process")` or other Node modules. |
| `dist/internal-do.bundle.mjs` | workerd/browser Durable Object bundle | ESM | Must not depend on Node `require`, `process`, or Electron. Browser/workerd-compatible code only. |
| `dist/browserTransport.js` | Browser panel runtime | IIFE | Must not depend on Node `require`, `process`, or Electron. |
| `packages/extension-host/dist/index.js` | Node ESM package loaded by the server | ESM | Must inject `createRequire(import.meta.url)` because bundled CommonJS dependencies, currently `yaml`, call Node builtins through `require`. |
| `packages/extension-host/dist/childRuntime.js` | Node child process runtime | ESM | Runs as a forked Node process. Keep Node-only APIs explicit and avoid importing Electron. |
| `packages/process-adapter/dist/index.js` | Node ESM package | ESM | Uses `createRequire(import.meta.url)` only for optional Electron loading. Plain Node must keep working. |

`pnpm build` runs `scripts/check-build-artifacts.mjs` after building. The same check can be run directly with:

```sh
pnpm run check:build-artifacts
```

When changing esbuild options, package `"type"`, `external`, `conditions`, or package boundaries, run a full build and this check before testing Electron startup.
