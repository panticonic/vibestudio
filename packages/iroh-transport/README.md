# Iroh transport

This source-only workspace package holds the transport-neutral protocol primitives and the Node
Iroh adapter being qualified by Phase 0 of the remote transport plan.

- `@vibestudio/iroh-transport` exports bounded framing, reach validation, ordered relay dialing,
  and the pinned release-set metadata. It does not import Node built-ins or the native binding.
- `@vibestudio/iroh-transport/node` exports the explicit Node endpoint configuration and native
  binding loader.
- `@vibestudio/iroh-transport/release-set` exports only the audited release pins and hashes.

Run the qualification checks from the repository root:

```sh
pnpm --filter @vibestudio/iroh-transport typecheck
pnpm --filter @vibestudio/iroh-transport test
```

## Upstream package entry points

`@number0/iroh@1.1.0` publishes its JavaScript and declarations at the package root but declares
missing `iroh-js/` entry points. The root pins a pnpm patch that points `main` and `types` at those
published root files, so development installs and vendored npm packages resolve the same contract.
The Node adapter uses the host's `createRequire` to resolve and load that package physically beside
its native addon; it remains external to static bundles. Packaging checks verify those declared
targets exist in npm's actual published file list.

The binding exposes no per-attempt cancel method. The single endpoint-generation owner therefore
cancels a timed-out dial by closing the whole current endpoint generation, awaiting native
cancellation, and rebinding the same secret. Hub and workspace sessions reconnect together on the
new generation; no abandoned promise or parallel attempt survives.
