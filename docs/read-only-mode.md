# Read-only mode

A dispatcher-enforced containment: a caller can request that a single service call —
or a whole eval run / agent session — be **read-only**, in which case the server
dispatcher refuses any method not declared `access.sensitivity: "read"`. Default-deny:
an un-tagged or mutating method is blocked.

It is a general capability, useful for any agent or session that should be able to
_inspect but not mutate_ (a "look but don't touch" agent, a safe triage/inspection
pass, a guardrail around experimental code). It is **independent of, and not required
by, the self-exploration agent** — that agent deliberately runs with full access
against the sandbox to exercise the whole surface.

## How it's enforced (the gate)

`ServiceContext.readOnly` plus one gate in `serviceDispatcher.dispatch()` — the single
choke point every `services.*` RPC funnels through:

```ts
// after the policy/access check + args validation, immediately before the handler:
if (ctx.readOnly && methodDef?.access?.sensitivity !== "read") {
  throw new ServiceError(service, method, "Blocked in read-only mode: …");
}
```

- **Enforced at the dispatcher**, not in the caller — a caller running read-only cannot
  bypass it regardless of which transport or proxy it calls through.
- **Default-deny:** a method with no `access`, or a `sensitivity` of `write` / `admin` /
  `destructive`, is blocked. Only `sensitivity: "read"` runs.

## The safe set (`sensitivity: "read"`)

Read-only-ness is derived from the method's declared `access.sensitivity` (the canonical
signal in `MethodAccessDescriptor`). `"read"` means non-mutating. Examples:
`blobstore.has/stat/getText/grep`, `fs.readFile/readdir/stat/glob`,
`vcs.status/compare/inspect/neighbors/history/blame/readFile/listFiles`,
`workspace.list/get/config`, and the `*.get*/list/status` family across services.
The mutating tiers (`write`/`admin`/`destructive`) are refused.

This is **trusted metadata, not verified** — the dispatcher has no semantic visibility
into a handler's side effects, so the `sensitivity` tag is authored (bootstrapped during
the documentation migration). Default-deny is the backstop: anything not explicitly
`"read"` is blocked, so the mode is safe even before metadata coverage is complete.

## How to request it

### Per RPC call

Any `RpcClient` caller can pass `readOnly: true` in the call options. It travels in the
envelope's `delivery` block and is extracted server-side into `ctx.readOnly` — mirroring
how `idempotencyKey` flows.

```ts
await rpc.call("main", "blobstore.putText", [text], { readOnly: true }); // → blocked
await rpc.call("main", "blobstore.getText", [digest], { readOnly: true }); // → ok
```

### Per eval run (the agent entry point)

`eval.run({ readOnly: true, code })` runs the whole sandbox session read-only: every
service call the eval code makes — `services.*`, the ambient `rpc`, the runtime bindings
(`fs`/`vcs`/`workers`/…) — carries `readOnly`, so the dispatcher refuses any non-`read`
method.

```ts
await eval.run({
  readOnly: true,
  code: `
    await services.blobstore.getText(digest);  // ok
    await services.fs.writeFile("/x", "y");     // throws: Blocked in read-only mode
  `,
});
```

The EvalDO threads the flag per-run, the same way it threads `parentMeta`: the cached
hosted-runtime rpc wrapper and `callMainService` read the live `currentRunReadOnly`, and
the per-run `callOptions` cover the ambient `rpc` / `chat` paths. **DO-infrastructure
calls** (durable state, trajectory writes) use the unwrapped client, so they are never
read-only-blocked.

## Propagation path

```
eval.run({readOnly:true})            packages/service-schemas/src/eval.ts (evalRunArgsSchema.readOnly)
  → evalService.prepareRun           → assembledArgs.readOnly
  → EvalDO.runLocked                  → currentRunReadOnly (host-rpc Proxy + callOptions + callMainService)
  → rpc.call(…, {readOnly:true})     packages/rpc: RpcCallOptions.readOnly
  → envelope.delivery.readOnly        client.ts makeEnvelope
  → rpcServer.handleEnvelopeRequest   → ctx.readOnly = delivery.readOnly
  → serviceDispatcher.dispatch        → GATE: sensitivity !== "read" ⇒ throw
```

## Scope & limitations

- Covers **server `services.*`** (everything through `serviceDispatcher.dispatch`). The
  userland `@rpc` DO/worker dispatch (`connectionless` / `handleEnvelope`) is a separate
  choke point and is **not** yet read-only-gated — a follow-up if read-only DO-to-DO
  calls are ever needed.
- HTTP and WS RPC paths carry `delivery.readOnly` into `ServiceContext.readOnly`.
- Read-only blocks **service mutations**, not all side effects in the abstract: e.g.
  `eval.reset` clears scope/db but doesn't undo external fs/git writes — though under
  read-only those mutating calls are blocked in the first place.

## Tests

`packages/shared/src/serviceDispatcher.accessJit.test.ts` —
_"read-only mode allows readonly methods and blocks the rest (default-deny)"_.
