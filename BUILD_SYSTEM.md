# Vibestudio Build Systems

Status: current overview; last reconciled 2026-07-13 against `92e4aefe`.

Vibestudio has two independent build systems with different inputs and
lifecycles:

- [Workspace runtime builds](WORKSPACE_BUILD_SYSTEM.md) run inside the server
  (`src/server/buildV2/`). They build content-addressed workspace units on
  demand and cache them by effective version and build key.
- [Host and distribution builds](HOST_BUILD_SYSTEM.md) run from the repository
  root (`build.mjs`). They produce Electron, standalone server, CLI, preload,
  browser-transport, internal-DO, and headless-host artifacts under `dist/`.

`pnpm build` invokes the host build. A running server invokes buildV2 as
workspace state changes or a caller requests a unit build.
