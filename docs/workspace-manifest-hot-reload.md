# Workspace Manifest Hot Reload

`workspace/meta/vibestudio.yml` is the runtime manifest for workspace-owned
units and policies. It is versioned as the `meta` repo in workspace VCS, so a
push to `meta/main` must update the active runtime from the committed VCS state,
not from a possibly stale source checkout.

This document defines the hot-reload contract for manifest-derived runtime
state. The goal is to keep newly approved workspace capabilities usable without
restarting the host, while still failing closed when a declaration is invalid or
when a setting cannot safely be changed in a running process.

## Startup Source Of Truth

On server startup, the protected workspace `main` refs are the manifest
authority when they exist. The projected source checkout may lag committed VCS
state, so startup must:

1. create the VCS/ref services from the projected manifest only far enough to
   bootstrap the VCS machinery;
2. compose the protected `main` workspace view from refs and the content store;
3. read `meta/vibestudio.yml` from that composed state;
4. replace the live `workspaceConfig` and derived declarations before RPC
   services, workerd, singleton reconciliation, extensions, apps, recurring
   jobs, or trust-dependent UI use them.

Only a brand-new workspace with no protected `main` refs may fall back to a
fresh disk snapshot. Once protected refs exist, falling back to disk would hide
approved-but-unprojected manifest changes and recreate stale visibility bugs.

## Apply Pipeline

On a `main` head advance whose changed paths include `meta/`:

1. Read `meta/vibestudio.yml` from the advanced VCS workspace state.
2. Parse and validate it as a complete workspace config.
3. Build all derived declarations before mutating live state.
4. If validation succeeds, replace the live `workspaceConfig` object in place.
5. Refresh derived registries that long-lived services close over.
6. Reconcile side tables that are not computed on every lookup.
7. Notify section-specific managers such as extensions, apps, recurring jobs,
   heartbeats, shared remotes, and route dispatch.

If parsing or validation fails, the live runtime keeps the previous manifest.
Do not partially apply individual sections.

The source checkout is not an authority for hot reload. It is a projection used
for development and may lag a VCS main advance. Runtime reloads must read from
the state hash carried by the `state-advanced` event. State refs may already be
formatted as `state:<hash>`; reload helpers must normalize them without adding a
second `state:` prefix.

## Config Writes

Host services that mutate `meta/vibestudio.yml` must write the protected
`meta/main` ref, not `source/meta/vibestudio.yml`. The source checkout may be
stale, and merging config changes into that file can drop fields that are
present in protected `main`.

The write path is:

1. read `vibestudio.yml` from the current protected `meta/main` state;
2. merge the typed config update into that parsed YAML so unknown top-level
   fields from protected `main` are preserved;
3. validate the rendered YAML with the normal workspace config parser;
4. mirror the new `meta` repo tree into the content store;
5. advance only `meta/main` through the protected ref CAS;
6. let the normal main-advance reaction reload the manifest and reconcile
   services, routes, apps, extensions, jobs, trust, and remotes.

Service-specific authorization may happen before the CAS. For example,
`gitInterop` keeps its existing shared-remote/import approvals, then performs
the already-approved config mutation through the protected ref writer. It does
not prompt a second time just because the implementation now uses the same
state-backed main-advance machinery.

## Hot-Reloaded Sections

These sections are expected to update without a host restart after a successful
`meta/main` push:

- `singletonObjects`: refreshes the in-memory `SingletonRegistry` in place so
  existing consumers observe updated object keys.
- `services`: refreshes the userland service resolver used by
  `workers.listServices` and `workers.resolveService`.
- `routes`: reconciles the compiled `/_r/w/...` route table for both old and
  new route sources. DO routes remain lazy: a route may be registered before the
  DO class is warmed, and the gateway prepares the DO on first request.
- `extensions`: reconciled by `ExtensionHost`.
- `apps` and `hostTargets`: app declarations are reconciled by `AppHost`; host
  target preference lookups read the live config.
- `recurring` and `heartbeats`: registry managers reload from the live config
  and sync durable schedule state.
- `trust`: re-seeds the process trust registry after the manifest is applied.
- shared remotes: synced after meta reload from the live config.

Hot reload should not require callers to retry with lower-level APIs. For
example, after a valid `services[]` declaration lands, `workers.resolveService`
should work directly; callers should not need to fall back to
`workers.resolveDurableObject`.

## Context-Scoped Visibility

The committed `main` manifest is the global service registry. A caller running
inside a workspace context may also resolve services and direct DO targets
declared only in that same context, but only as a fallback when `main` has no
matching service name/protocol or DO class. This lets agents test newly authored
workers/DO services before merge without making those declarations globally
visible.

Context fallback must preserve policy and build isolation:

- A matching `main` service always wins. If `main` has the name/protocol but its
  policy denies the caller, resolution fails; a context duplicate must not bypass
  the global policy.
- A matching `main` direct DO class also wins. If any `main` service policy
  backing that DO denies the caller, resolution fails; a context duplicate must
  not bypass the global policy.
- Context-only DO services and direct DO targets are activated in the caller
  context and built from `ctx:<contextId>`.
- Callers without a registered context only see the `main` registry.
- Once the context is pushed to `main`, the normal hot-reload path promotes the
  declaration to the global registry.

## Restart-Bound Sections

Some manifest fields are injected into static workerd services or foundational
host wiring. Changing them at runtime must either restart the owning subsystem
or produce an explicit "restart required" diagnostic. They should not silently
look updated while existing isolates still use old bindings.

Current restart-bound examples:

- `providers.evalEngine`, `providers.evalRuntime`, and `providers.cdpClient`:
  injected into `EvalDO` as env bindings when workerd config is generated.
- `providers.browserData`: injected into `BrowserDataDO` as the broker
  identity.
- the singleton DO backing the `vcs` service (`vibestudio.vcs.v1`): this is
  foundational storage and attribution wiring. Changing it in a running server
  requires explicit migration/restart handling.

When adding a new manifest field, decide whether it is hot-reloadable or
restart-bound at design time. A field is restart-bound if it is baked into a
static process config, static internal DO env, long-lived credential identity,
or durable storage owner.

The manifest apply path logs a `[WorkspaceConfig]` warning when a restart-bound
field changes. Hot-reloadable sections from the same manifest still apply; the
warning is not a denial. Existing static bindings keep the previous value until
the owning subsystem is restarted or a purpose-built migration path handles the
change.

## Derived Registry Rules

Any code that builds a registry from `WorkspaceConfig` must follow these rules:

- Do not close over a startup-only snapshot unless the registry is explicitly
  restart-bound.
- Prefer reading from the live `workspaceConfig` object for cheap lookups.
- If a derived object must be held by long-lived services, refresh it in place
  on manifest apply so existing references stay current.
- If a compiled side table exists, such as HTTP route dispatch, provide a
  reconcile method that can remove stale entries and add new entries from the
  current manifest.
- Reconcile both old and new keys. Removal only works if the apply path knows
  which keys existed before the reload.
- Validate before mutation. Invalid manifests must leave all live registries on
  the previous valid state.

## UX And Security

Fail closed on invalid declarations, missing singleton rows for DO routes, and
unknown policy shapes. Do not fail closed by requiring a restart for fields that
can be safely reconciled in memory; that breaks the workspace authoring loop and
encourages callers to bypass manifest-level APIs.

Access policy checks remain at resolution/dispatch time. Hot reload updates the
registry; it does not grant access outside `services[].policy`, route auth, app
capabilities, extension approvals, or trust declarations.

## Regression Checklist

When changing manifest reload behavior, include tests for:

- adding a service after the `workers` RPC service has already been constructed;
- adding, changing, and removing a route without rebuilding the worker source;
- preserving lazy DO route behavior, meaning route registration does not warm or
  build the DO until the first request;
- rejecting invalid configs without mutating the live registry;
- loading startup declarations from protected `main` when source projection is
  stale;
- accepting both bare hashes and `state:<hash>` refs in state-backed manifest
  reads;
- mutating workspace config through protected `meta/main` while preserving
  protected YAML fields and without reading a stale source projection;
- resolving a service declared only in the caller's context without allowing a
  context duplicate to bypass a denied `main` service;
- resolving a direct DO target declared only in the caller's context without
  allowing a context duplicate to bypass a denied `main` DO policy;
- restart-required diagnostics for static provider/core binding changes.
