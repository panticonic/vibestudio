# Terminal app units: design note

Status: decided (2026-10-13): option B below, implemented. It covers pieces 1, 2 and 5 of the
terminal plan revision (`docs/terminal-refurbish-plan.md`, "Revision
(2026-10-12)"). It answers two questions:

- which existing build, admission, instance and grant machinery a terminal app
  reuses;
- where that reuse hits a wall.

Direction from the user: a terminal app is to a terminal browser what a panel is
to the Electron shell. It is an ordinary workspace unit hosted by a client. It
differs from a panel only in that it runs as a Node program in a workspace PTY
instead of in a browser view. Terminal apps have nothing to do with ClientHost,
`vibestudio.client`, client runtimes, client principals, candidates or
rollback, or `clients:*` events. Only the terminal browser itself is a client.

## What a panel is today, and the terminal equivalent

| Concept | Panel (desktop) | Terminal app |
|---|---|---|
| Unit | `panels/<name>` (also `about/<name>`): `BuildableUnitKind` `panel`, scope `@workspace-panels/` | `terminal-apps/<name>`: **the same kind `panel`**, scope `@workspace-terminal-apps/`, added as one row of `BUILDABLE_UNIT_DIRS` exactly like `about/` |
| Manifest | `vibestudio` title / description / icon / entry / stateArgs | the same fields; the location alone makes the unit terminal-hosted (`isTerminalAppLocation`), the manifest never selects it. The icon is shown only when it is one emoji |
| Build | `doBuild` → `buildPanel` (browser bundle) | `doBuild` dispatches terminal-hosted panels to `buildTerminalProgram`: a Node ESM bundle from the path extensions use (see "Build"), no browser page template |
| Version / identity | `effectiveVersion`, `buildKey`, sealed `executionDigest`, authority manifest | identical (`createBuildExecutionIdentity`) |
| Admission | publication review (`REVIEWED_RUNTIME_KINDS = ["panel","worker"]`), install review grouped as panels | identical: kind `panel` is already reviewed. The install review groups `terminal-apps/` as "Terminal apps" through the existing directory grouping |
| Listing | the workspace source tree's `launchable` nodes under `panels/` and `about/` | the same tree marks `terminal-apps/*` launchable; the terminal browser lists those, the desktop and mobile launchers list only `panels/` and `about/` |
| Instance | slot + history entry `{source, stateArgs}`, runtime entity `kind:"panel"` (`panel:<key>`, own context, `ownerUserId`) | see "Instance and principal" |
| Per-instance state | `stateArgs` on the slot's history entry, patched with `slot.patchCurrentStateArgs` (RFC 7386 merge, validated against the build's `stateArgsSchema`) | the same contract (piece 5) |
| Hosting grant | the desktop shell creates the entity and calls `auth.grantConnection(entityId)` (capability `panel-hosting`); `connectionGrants.grant(principal, issuedBy = shell, {subject})` | the launch service (the PTY host) does the same with the same `connectionGrants.grant`, issued by the launching person's caller |

## Build: zero new lifecycle, one shared Node bundle path

`buildExtension` and `buildTerminalApp` already share their shape:
`prepareBuildEnv("runtime-root")`, an esbuild Node ESM bundle with the
`createRequire` banner, and node conditions. Extensions additionally classify
runtime externals (`analyzeExtensionDependencies`), acquire them
(`ensureExtensionRuntimeDeps`) and project them next to the bundle
(`materializeExtensionRuntimeDeps`, refreshed on cache hits by
`refreshCachedExtensionRuntimeDeps`), so the bundle runs from `builds/` inside
the sandbox.

The refactor extracts that sequence into one `bundleNodeProgram` (plus
`projectNodeProgramRuntimeDeps`) used by:

- `buildExtension`, which keeps its smoke test and extension details;
- `buildTerminalProgram`, whose details are `{kind: "terminal", runtimeDepsKey,
  externalDeps, dependencyOverrides, dependencyPatches, classifiedDeps}`.

The cache-hit refresh (`refreshCachedNodeProgramRuntimeDeps`) re-projects runtime
dependencies for both.

`buildStore` already writes `{"type":"module"}` for worker and extension build
directories. Panels whose primary artifact is a Node module get the same. No
new store, no new admission and no new lifecycle.

The terminal **browser** is not a terminal app. It is a client (unit kind
`client`, runtime `terminal`) built by `buildTerminalClient`: it is downloaded into
the CLI as one self-contained module, so it cannot use a runtime dependency
projection next to a server-side build directory.

## Instance and principal: the wall

A terminal session must have a code principal with:

- its own context, so the channel service's "creator runtime context" check and
  `runtime.createEntity` for agents work;
- `ownerUserId`, so subject resolution and `liveCallerGate` admit it;
- a sealed incarnation, so approvals are attributed to its code identity and
  manifest `requests` (for example `accounts.connect`, `server-logs.read`)
  apply.

A runtime entity of `kind:"panel"` has all three. However, **every panel
connection must also hold a panel-runtime lease**:

- `rpcServer.handleAuth` → `PanelRuntimeCoordinator.authorizePanelConnection`.
- Leases are keyed by entity, bound to a slot of the workspace panel tree, and
  owned by a registered panel host (`registerClient(PanelHostRegistration)`).
- They come with load and boot attempts, boot reports, CDP and presentation
  callers.

The lease model is desktop-view machinery. There are three ways forward:

**A. Terminal sessions are panel slots hosted by a terminal host.** The launch
service registers as a panel host and opens a slot per session. The PTY process
connects under that slot's lease, and `stateArgs` is the slot's own.

- *Pros:* this is literally "a panel hosted elsewhere". The desktop sees
  terminal sessions in its tree and can show them in the terminal panel.
- *Cons:* it puts terminal sessions in the shared panel tree. It also requires
  the coordinator's attempt and boot supervision to accept a host whose
  "view" is a PTY. That is the largest change, and it touches desktop behaviour.

**B. Panel entity without a slot, leased by its PTY host.** The coordinator
gains host-held leases for entities that have no slot: the launch service holds
the lease for the session's PTY connection. Per-session state is the entity's
own `stateArgs` (a durable entity-record field today), patched through a
`runtime.patchEntityStateArgs` that applies the slot method's merge and
validation code.

- *Pros:* small, and it reuses the entity, grant and identity paths unchanged.
- *Cons:* it is a second lease shape inside the coordinator.

**C. A dedicated entity kind `terminal`.** This is rejected: it is new
lifecycle machinery (prepare hook, subject source, live-caller rule, approval
title) that duplicates `panel`.

**Decision: B** (user, 2026-10-13). As implemented:

- `PanelRuntimeCoordinator.holdEntityForHost` keeps host-held leases in their own
  map (`hostHeldEntityLeases`), separate from slot leases. They admit exactly the
  launched connection, authorized by the launching person's caller
  (`resolveAuthorizerForRuntime` is the counterpart of the presentation caller
  for connection-grant authentication), and route calls to the program. They
  emit no `panel:runtimeLeaseChanged` events, are absent from `getSnapshot()`
  (so they never count toward the headless host's idle timer), have no
  attempt/boot/stall/CDP/presentation supervision, survive client registration
  churn, and have no reconnect timer: they end when the entity is retired.
- The launch service retires the entity when the shell extension reports the
  PTY's exit (`awaitExit`, the authoritative lifecycle) or when the person closes
  the session.
- Per-instance state is the entity's own `stateArgs`:
  `runtime.patchEntityStateArgs` (the calling slotless panel runtime only) and
  `slot.patchCurrentStateArgs` both go through one `mergeValidateStateArgs`.

**Why this differs from the command overlay.** The overlay plan
(`docs/command-overlay-client-runtime-plan.md`) rejected a slotless panel lease,
because a lease "says 'panel' for something with no slot, placement or
navigation": the overlay is a piece of host UI, not a workspace unit. A terminal
app is a real workspace panel unit: a manifest, a build, admission, an execution
digest and per-instance `stateArgs`. Only its host is different (a PTY, not a
view). The host-held lease states that host relationship and nothing more.

## Launch (piece 2), common to A and B

`terminalApps.launch({source?, cols, rows, approvalsKey?})` is a host service
(`src/server/services/terminalAppsService.ts`), called by the person's own
caller (the browser's device session in the shown workspace, or the desktop
terminal panel). Its prepared approval reads "Run <App> <version> in this
workspace?" (grant scopes once/session/version; a person's own device session is
cleared as their action, as in the desktop). It:

1. Activates a new incarnation with `runtime.createEntity({kind: "panel",
   execution: {surface: "code", source}, key: "nav-term-<uuid>", contextId,
   stateArgs})` as a host operation for the person (the person owns it; the
   session keeps one context across relaunches and the previous incarnation's
   stateArgs carry over). Callers never pass paths: the primary artifact path
   comes from the build store.
2. Holds the entity's lease for a connection id it chooses, and mints
   `connectionGrants.grant(entityId, issuedBy = caller, {subject})`.
3. Opens the PTY through the shell extension as the person (host-originated,
   since the run was already approved): `command = <runtime node>`,
   `args = [bundle]`, cwd = the session context's folder. The environment is the
   shell's minimal one plus the launch variable; `CI` is never passed.
4. Records the session in the per-person registry (the single tab registry,
   replacing `system/workers/terminal-sessions`; it also keeps the terminal
   browser's settings) and emits `terminal-apps:sessions-changed` to the person.
5. Hands the grant to the program through a **one-shot launch file**:
   - It is written mode 0600 under the runtime's writable home, and its path is
     the only launch variable.
   - The program reads the file and unlinks it before connecting, and holds
     the grant only in memory afterwards. Panels already reconnect with a
     redeemed grant in exactly this way.
   - Inside one native runtime, processes are not separate security domains
     (`docs/isolation-plan.md`). This removes a standing secret from
     `/proc/<pid>/environ`; it does not isolate siblings.

Plain login shells are sessions of the same registry (no entity, no grant).
