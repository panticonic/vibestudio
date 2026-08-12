---
name: extensiondev
description: Create or modify trusted Vibestudio extensions — supervised Node services with RPC, optional fetch handlers, and explicit authority.
---

# Extension development

Extensions under `extensions/` run as approved Node processes with full Node
APIs, native modules, sockets, and host filesystem access. Prefer a worker when
a workerd isolate suffices. To call an installed extension, use live generated
docs and the `extensions` runtime API; this skill is for authoring one.

## Read by task

| Task | Reference |
| --- | --- |
| Package manifest, `activate(ctx)`, API, authority | [AUTHORING.md](AUTHORING.md) |
| Optional HTTP fetch handler | [FETCH.md](FETCH.md) |
| Build, publish, inspect, reload | [DEV_LOOP.md](DEV_LOOP.md) |

## Invariants

- Use `extensions/<name>` with a private ESM package and a validated
  `vibestudio.extension` manifest.
- Give each unit a semantic icon per the [icon
  guide](../workspace-dev/references/icons.md).
- Return a plain object from `activate(ctx)` — its own enumerable function
  properties are the RPC surface.
- Node and `ctx.fs` access is trusted authority, not a sandbox. Declare
  protected resources in `authority.provides` and bind methods through
  `vibestudio.extension.methodAuthority` — no advisory prompts inside methods.
- Use `ctx.log` for structured runtime logs. Select the exact live extension
  identity before reading supervision health or logs.
- Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) before editing. Only an
  approved protected-main publication drives the build and activation
  projection; local or merely committed work doesn't update the running unit.
- Add a repo-local `SKILL.md` documenting the extension's purpose, trust
  boundary, diagnostics, and non-obvious topology. Point to live docs or code
  for changing method catalogs.

## Workflow

Create the package, declare it under `extensions:` in `meta/vibestudio.yml`, and
let the elevated review cover exact native code and requested authority. Use
`extensions.use(...)` or `extensions.invoke(...)` only after activation.

For exact manifest and runtime shapes, use [AUTHORING.md](AUTHORING.md), live
generated docs, and the extension host types. Start implementation review at the
entry point and follow direct imports. Run focused tests and the smallest
affected manifest, authority, and runtime checks.
