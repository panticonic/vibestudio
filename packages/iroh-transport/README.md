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

## Upstream packaging warning

`@number0/iroh@1.1.0` publishes `index.js` and `index.d.ts` at the package root, while its manifest
declares `iroh-js/index.js` and `iroh-js/index.d.ts`. Node currently falls back to the root entry
with a deprecation warning, and strict static resolvers reject the package. The Node adapter uses
the repository's normal host-native `createRequire` loading seam, which is also the intended
packaging boundary for native externals. Packaged-product tests must prove that every retained
artifact copies and loads the matching native package; the warning is not hidden or patched.

The binding exposes no per-attempt cancel method. The single endpoint-generation owner therefore
cancels a timed-out dial by closing the whole current endpoint generation, awaiting native
cancellation, and rebinding the same secret. Hub and workspace sessions reconnect together on the
new generation; no abandoned promise or parallel attempt survives.
