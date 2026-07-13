# Host and Distribution Build System

Status: current; last reconciled 2026-07-13 against `92e4aefe`.

The root [`build.mjs`](build.mjs) creates the trusted host artifacts used by the
desktop application, standalone server, CLI, and source-server development
flow. This is separate from the server's content-addressed
[workspace runtime build](WORKSPACE_BUILD_SYSTEM.md).

## Commands

| Command                                  | Purpose                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                             | Production host/distribution build (`NODE_ENV=production`).                                                                         |
| `pnpm dev`                               | Development host build, host type-check, then Electron.                                                                             |
| `pnpm server`                            | Run the already-built standalone `dist/server.mjs`.                                                                                 |
| `pnpm server:live`                       | Run `src/server/index.ts`; callers must first build source-server prerequisites.                                                    |
| `node build.mjs --source-server-prereqs` | Rebuild infrastructure packages, `dist/headless-host`, browser transport, and the embedded internal DO for live source-server runs. |
| `node build.mjs --internal-do-only`      | Rebuild only `dist/internal-do.bundle.mjs`.                                                                                         |

The CLI's live-server launcher runs `--source-server-prereqs` automatically so
source host code does not run with stale RPC, headless-host, or internal-DO
artifacts.

## Build graph and outputs

The host build performs these dependency-ordered stages:

1. Build `@vibestudio/*` infrastructure packages.
2. Build userland workspace packages that later host bundles consume.
3. Build `apps/headless-host` and copy its `main.js`/`index.js` bundles to the
   canonical `dist/headless-host/` runtime location.
4. Build Electron main, preloads/overlays, browser transport, bootstrap UI,
   CLI, and the standalone/Electron server bundles. The internal-DO bundle is
   built first within this stage because its bytes are embedded into both
   server outputs.
5. Build dependency-declared web workers, copy static/runtime assets, and run
   `scripts/check-build-artifacts.mjs`.

Principal outputs include:

| Output                                          | Consumer                                 |
| ----------------------------------------------- | ---------------------------------------- |
| `dist/main.cjs`                                 | Electron main process                    |
| `dist/server-electron.cjs`                      | Electron workspace utility process       |
| `dist/server.mjs`                               | Standalone server / npm server package   |
| `dist/cli/client.mjs`                           | `vibestudio` CLI                         |
| `dist/*Preload.cjs`, `dist/*OverlayPreload.cjs` | Electron renderer boundaries             |
| `dist/browserTransport.js`                      | Host-injected browser/panel transport    |
| `dist/internal-do.bundle.mjs`                   | Embedded internal Durable Object program |
| `dist/headless-host/`                           | Spawned standalone Chromium panel host   |

The build itself is a clean full rebuild. Integration and smoke scripts call
`scripts/ensure-host-build.mjs`, which reuses a completed build only when its
content fingerprint still matches every conservative host-build input and the
requested development/production mode. A successful full build writes that
contract to `dist/host-build-fingerprint.json`; source, package, workspace,
lockfile, or build-configuration changes invalidate it and rebuild. This avoids
serially rebuilding identical artifacts across smoke suites without introducing
a second incremental build path.

## Infrastructure package build profiles

Every immediate `packages/*` package declares `vibestudio.buildProfile` in its
`package.json`. The profile describes the artifact its consumers actually load;
it is not a request to make packages with different runtime needs use the same
build command.

| Profile         | Contract                                                                                                                                                                                        | Packages                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-only`   | Public entries point at `src/*.ts`; there is no `build` script or package-local build artifact. TypeScript-aware host bundlers consume the source directly.                                     | `durable`, `identity`, `mobile-webrtc`, `service-schemas`, `shared`, `shell-core`, `sqlite`, `unit-host`, `workspace-contracts`, `workspace` |
| `tsc-output`    | `tsc --project tsconfig.build.json` emits JavaScript and declarations under `dist/`, and every public entry points there.                                                                       | `browser-data`, `credential-client`, `dev-log`, `env-paths`, `extension`, `git`, `process-adapter`, `rpc`, `types`                           |
| `tsc-build`     | TypeScript build mode emits a composite project under `dist/`; `--force` keeps the production build independent of stale incremental state.                                                     | `typecheck`                                                                                                                                  |
| `custom-bundle` | A package-local `build.mjs` bundles runtime entries and separately emits any required declarations. This profile is reserved for artifacts that cannot be represented by plain TypeScript emit. | `extension-host`                                                                                                                             |

The root package-build stage runs the declared `build` scripts in dependency
order; pnpm naturally skips source-only packages. `tests/packageBuildProfiles.test.ts`
discovers every immediate package and rejects missing profiles, fake source-only
builds, noncanonical commands, mismatched `src/`/`dist/` entries, and custom
builds that do not actually bundle.

## Packaging contract

Electron Builder includes the required `dist/` artifacts according to
`electron-builder.yml`. `scripts/build-npm-packages.mjs` stages the standalone
server and CLI packages, including the same `dist/headless-host/main.js`
contract used by `HeadlessHostManager`. `VIBESTUDIO_APP_ROOT` identifies the
installed package root; source commands use the repository root.
