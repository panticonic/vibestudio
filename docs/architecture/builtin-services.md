# Builtin services

Builtin services are product-owned Durable Objects that remain in the shipped
runtime only because their persistence or execution mechanism satisfies one of
the closed kernel-residency reasons. Their implementations live under
`packages/builtin/`; workspace code sees protocols and schemas, never those
implementations.

The typed catalog in
`packages/service-schemas/src/productBuiltinServices.ts` is the single
declaration site for class identity, protocol, schema table, residency reason,
workerd bindings, authority requests, object-key version, and implementation
module. `pnpm generate:builtin-catalog` derives the server export barrel,
internal class list, resolver targets, direct-authority projection, and workerd
execution catalog. `pnpm check:builtin-catalog` rejects drift.

## Create a service

Run:

```sh
pnpm scaffold:builtin-service example-store ExampleStoreDO \
  vibestudio.example-store.v1 durable-data
```

The command creates the builtin implementation and schema table, adds the
package export and catalog entry, and leaves a deliberately gated `ping`
contract. Replace that contract with the real typed methods and review every
method's capability, tier, principals, sensitivity, and return schema. Then run:

```sh
pnpm generate:builtin-catalog
pnpm type-check:host
pnpm check:unit-authority
```

Builtin service classes set `static rpcMethods` to their schema table. The
shared durable base validates arguments before dispatch and validates successful
results before returning them. Do not add a host façade, provider forwarder,
class-name switch, hand-maintained registry, fallback loader, legacy schema
reader, or migration path.
