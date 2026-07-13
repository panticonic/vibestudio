# `@vibestudio/extension-host`

This package is intentionally separate from `src/server` even though the server
is its only in-repository API consumer. It owns two build artifacts with a
process boundary between them:

- the server-side extension registry and process supervisor;
- the Node child runtime forked to execute an extension outside the server
  process.

Keeping that boundary as a package gives the child runtime a dedicated build,
dependency set, public wire contract, and test surface. Server policy and
workspace orchestration do not belong here; extension execution and its process
protocol do.

See [`../../docs/build-artifact-contracts.md`](../../docs/build-artifact-contracts.md)
for the emitted-artifact contract.
