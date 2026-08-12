---
name: local-models
description: Inspect local-model readiness, install the bundled local model when requested, and run agent tasks on an installed local model.
---

# Local models

Use the local-models extension for lifecycle and the ordinary agent runtime for
inference. Never request loopback credentials or call a model server directly.

## Inspect availability

From agent eval, inspect the extension's own state:

```ts
const extension = "@workspace-extensions/local-models";
const [status, models] = await Promise.all([
  services.extensions.invoke(extension, "status", []),
  services.extensions.invoke(extension, "listModels", []),
]);
return { status, models };
```

The bundled model reference is `status.fallback.modelRef`. Its model row is
usable when `state` is `startable` or `ready`; `ready` means warm, while
`startable` is a healthy downloaded-but-cold state. Report `downloading`,
`starting`, and `error` honestly rather than treating absence of readiness as a
generic failure. Use `getHardwareProfile` only when selection or performance
depends on the machine.

## Install only on user intent

Downloading model weights is a large persistent effect. Do it only when the
user asked to install, download, prepare, or run a model that is not installed.
For the bundled fallback, start its idempotent installation with:

```ts
await services.extensions.invoke("@workspace-extensions/local-models", "installModel", [
  status.fallback.modelRef,
]);
```

A returned job means the transfer is in progress; `null` means the current
artifact was already present. `listModels` is the bounded progress/readiness
surface. Do not start parallel duplicate downloads, invent a catalog slug, or
remove a successfully installed model as cleanup.

## Run a task on the local model

Model execution belongs to a real agent turn. For a bounded delegated task,
spawn a normal `pi` subagent with `config.model` set to the exact installed
`local:<slug>` reference. Use `mode: "fork"` when it needs the current
trajectory or workspace context and `mode: "fresh"` when it does not. The
runtime joins an in-progress bundled download, starts the correct server, and
injects loopback authentication at the trusted execution edge.

Continue useful foreground work, then suspend while the child runs. Do not poll
the child. Its terminal delivery proves that the configured local-model agent
completed or failed the task; retain inspection-only results without merging.
If startup fails, inspect the local-model row and bounded server-log tail and
report the concrete failure.
