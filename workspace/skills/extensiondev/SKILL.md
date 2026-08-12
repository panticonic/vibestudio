---
name: extensiondev
description: Create or modify trusted Vibestudio extensions: supervised Node services with RPC methods, optional fetch handlers, explicit authority, semantic publication, and runtime diagnostics.
---

# Extension development

Extensions under `extensions/` run as approved Node processes with Node APIs,
native modules, sockets, and host filesystem access. Prefer a worker when a
workerd isolate is sufficient. To call an installed extension, use the live
generated docs and `extensions` runtime API; this skill is for authoring one.

## Read by task

| Task | Reference |
| --- | --- |
| Package manifest, `activate(ctx)`, API, authority | [AUTHORING.md](AUTHORING.md) |
| Optional HTTP fetch handler | [FETCH.md](FETCH.md) |
| Build, publish, inspect, and reload | [DEV_LOOP.md](DEV_LOOP.md) |

## Invariants

- Use `extensions/<name>` with a private ESM package and a validated
  `vibestudio.extension` manifest.
- Give the unit a semantic icon; follow the
  [icon guide](../workspace-dev/references/icons.md).
- Return a plain object from `activate(ctx)`. Its own enumerable function
  properties are the RPC surface.
- Treat Node and `ctx.fs` access as trusted authority, not a sandbox. Declare
  protected resources in `authority.provides` and bind methods through
  `vibestudio.extension.methodAuthority`; do not add advisory prompts inside
  methods.
- Use `ctx.log` for structured runtime logs. Select the exact live extension
  identity before reading supervision health or logs.
- Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) before editing. Only an
  approved protected-main publication can drive the build and activation
  projection; local or merely committed work does not update the running unit.
- Add a repo-local `SKILL.md` that documents the extension's public purpose,
  trust boundary, diagnostics, and non-obvious topology. Point to live docs or
  code for changing method catalogs.

## Workflow

Create the package, declare it under `extensions:` in `meta/vibestudio.yml`, and
let the elevated review cover the exact native code and requested authority.
Use `extensions.use(...)` or `extensions.invoke(...)` only after activation.

For exact manifest and runtime shapes, use [AUTHORING.md](AUTHORING.md), live
generated docs, and the extension host types. Start implementation review at
the extension's entry point and follow direct imports. Run its focused tests
and the smallest affected manifest, authority, and runtime checks.
