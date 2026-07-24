# Panel API

Import panel APIs from `@workspace/runtime`. The same portable surface works in
panels, workers, Durable Objects, and server-side eval.

## The completion contract

Panel operations have one meaning:

- `await openPanel(...)`, `focus()`, `navigate()`, `reload()`, and `rebuild()`
  return only after the exact selected runtime attempt is application
  **boot-ready**.
- They never treat a lease, a registered WebContents/CDP target, `about:blank`,
  or a successfully generated HTML shell as application success.
- A resolve, build, host, navigation, bundle, or entry failure rejects with
  `PanelOperationError`. Do not infer success from a panel id or an empty
  snapshot.
- `snapshot()` first enforces the same readiness contract and then returns a
  capture tied to the attempt it read.

Internally, creation has two deliberate boundaries. The durable tree slot is
committed and becomes observable immediately; build preparation, host
assignment, navigation, and application boot then advance that slot through the
canonical phases. This prevents a slow or broken initial panel from blocking
tree discovery, owner seeding, or creation of unrelated panels. The public
`openPanel(...)` promise still waits for its own attempt to reach `ready` and
has a finite 90-second readiness deadline. A terminal failure or deadline
rejects with the last phase, host evidence, diagnostic id, and full attempt
provenance—never with an apparently successful blank handle.

This is intentionally stricter than browser “load” state. The generated panel
bootstrap reports `loading → booting → ready` and reports entry errors,
unhandled rejections, missing assets, and incomplete runtime configuration as
failures.

```ts
import { openPanel, PanelOperationError } from "@workspace/runtime";

try {
  const panel = await openPanel("panels/my-app", {
    focus: true,
    contextId: ctx.contextId,
    ref: `ctx:${ctx.contextId}`,
  });
  const observation = await panel.observe();
  const capture = await panel.snapshot();
  console.log(observation.buildKey, capture.document.text);
} catch (error) {
  if (error instanceof PanelOperationError) {
    console.error(error.failure.code, error.failure.stage);
    console.error(error.failure.message, error.failure.provenance);
  }
  throw error;
}
```

## Discovery and creation

```ts
panelTree.self(): PanelHandle
panelTree.get(id): PanelHandle
panelTree.list(): Promise<PanelHandle[]>
panelTree.roots(): Promise<PanelHandle[]>
panelTree.children(id): Promise<PanelHandle[]>
panelTree.parent(id): PanelHandle | null
panelTree.navigate(id, source, opts?): Promise<PanelObservation>
openPanel(source, opts?): Promise<PanelHandle>
```

`self()` and `get()` are synchronous handle factories; they do no I/O.
`list()`, `roots()`, and `children()` return handles hydrated from a fresh tree
read. The scalar fields `id`, `title`, `source`, `kind`, and `parentId` are the
handle’s last observed descriptor. Use `observe()` whenever correctness depends
on live runtime state.

`openPanel(source)` uses main/pushed code. To run unpublished context code, pass
both the intended storage context and explicit code ref:

```ts
const panel = await openPanel("panels/my-app", {
  contextId: ctx.contextId,
  ref: `ctx:${ctx.contextId}`,
});
```

`contextId` alone selects storage/filesystem isolation; it never selects code
provenance.

When `contextId` is omitted, panel reservation mints a fresh context and
atomically records it as a lifecycle child of the verified creator's context.
The creator may inspect, automate, rebuild, or close that panel without a
foreign-context approval, and destroying the creator context recursively
retires the panel context. Ownership comes from the authenticated bridge caller;
there is no caller-supplied owner/parent field.

Passing an explicit `contextId` deliberately shares that existing semantic
context and does not re-parent it. This is the right form for context-local code
(`ref: "ctx:<id>"`) and for applications that intentionally share storage.
Use omission for an isolated panel world; use an explicit id only when sharing
is part of the design.

When parentage is implicit, the server resolves the caller's runtime lineage to
an open tree slot under a finite five-second deadline. A stalled lineage read
fails as `parent_resolution_timeout` with recovery guidance. Pass
`parentId: null` for an owned root or an explicit open slot id when that is the
intended topology.

## One observation model

`await handle.observe()` is the cheap canonical status read:

```ts
interface PanelObservation {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  requestedRef: string;
  runtimeEntityId: string | null;
  attemptId: string; // runtimeEntityId@buildKey
  effectiveVersion: string | null;
  buildKey: string | null;
  phase:
    | "resolving"
    | "building"
    | "assigning-host"
    | "loading"
    | "booting"
    | "ready"
    | "failed"
    | "stopped";
  failure?: PanelRuntimeFailure;
  host?: {
    holderLabel?: string;
    platform?: "desktop" | "headless" | "mobile";
    supportsInspection?: boolean;
    view: { exists: boolean; url?: string; loading?: boolean };
    boot: {
      phase: "unavailable" | "loading" | "booting" | "ready" | "failed";
      runtimeEntityId?: string | null;
      source?: string | null;
      contextId?: string | null;
      effectiveVersion?: string | null;
      buildKey?: string | null;
      message?: string;
      errorName?: string;
      stack?: string;
    };
  };
  updatedAt: number;
}
```

A host boot state counts only when its runtime entity, source, context, and
build key match the server attempt. This prevents an old ready renderer from
acknowledging a newer rebuild while the host is still switching views.

Every inspecting renderer host must implement the canonical
`panelObservation` host command. Desktop and headless execute the same bounded
page probe for `document.readyState`, the current URL, and
`globalThis.__vibestudioPanelBoot`, then parse the result through the same
shared contract. Target registration, successful navigation, an empty DOM, or
the existence of a browser view is never a readiness substitute. A missing
command or malformed observation is a `host_unavailable` platform failure and
must be repaired in the host; callers must not infer success or fall back to a
different readiness surface.

There are no separate `refresh()`, `getInfo()`, `ensureLoaded()`, or
`isLoaded()` handle concepts. They previously exposed different partial truths
and could report success for a broken panel. Use `observe()`; `phase ===
"ready"` is the sole positive readiness answer.

## Failures

Read `error.failure`, not string fragments:

```ts
interface PanelRuntimeFailure {
  code:
    | "unit_not_found"
    | "ref_not_found"
    | "manifest_invalid"
    | "dependency_resolution_failed"
    | "compile_failed"
    | "build_identity_invalid"
    | "host_unavailable"
    | "lease_conflict"
    | "navigation_failed"
    | "asset_unavailable"
    | "entry_threw"
    | "runtime_handshake_timeout"
    | "render_crashed"
    | "panel_not_found"
    | "unknown_failure";
  stage: "resolve" | "build" | "host" | "load" | "boot" | "runtime";
  message: string;
  diagnosticId: string;
  occurredAt: number;
  provenance: {
    panelId?: string;
    runtimeEntityId?: string | null;
    attemptId?: string;
    source: string;
    contextId: string;
    requestedRef: string;
    effectiveVersion?: string | null;
    buildKey?: string | null;
  };
  details?: Record<string, unknown>;
}
```

The failure and the shell error display come from the same host/server
observation. If an operation rejects, do not immediately retry or open another
panel. Inspect its failure first; retries cannot fix a missing unit, wrong ref,
compile error, or throwing entry module.

## Handle operations

| Member                                          | Contract                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `observe()`                                     | Current exact attempt, phase, host state, provenance, and structured failure                                                   |
| `diagnose()`                                    | One bounded packet containing `observation`, historical console/lifecycle records, and a document when ready                   |
| `snapshot()`                                    | Boot-ready document capture with `panelId`, `attemptId`, `runtimeEntityId`, `buildKey`, and `capturedAt`                       |
| `navigate(source, opts?)`                       | Transactionally prepare a new source/ref/context attempt, activate it, and wait for ready                                      |
| `rebuild()`                                     | Transactionally prepare a new immutable attempt for the current source/ref without adding a history entry, then wait for ready |
| `reload()`                                      | Reload the current view and wait for its boot handshake                                                                        |
| `focus(opts?)`                                  | Assign/present the panel and wait for ready                                                                                    |
| `children()` / `parent()`                       | Tree relationships                                                                                                             |
| `stateArgs.get()` / `stateArgs.set()`           | Validated host-owned application state args                                                                                    |
| `close()` / `archive()` / `unload()`            | Explicit lifecycle/resource operations                                                                                         |
| `tree()` / `state()` / `routes()` / `setMode()` | Optional workspace `_agent` application inspection                                                                             |
| `cdp` / `click(selector)`                       | Approval-gated CDP automation                                                                                                  |

`navigate()`, `reload()`, `rebuild()`, and `focus()` return
`Promise<PanelObservation>`, not another `PanelHandle`. Keep using the original
handle for `observe()`, `snapshot()`, and later lifecycle operations:

```ts
const observation = await handle.rebuild();
const capture = await handle.snapshot();
```

`navigate()` and `rebuild()` are atomic replacements: the new runtime and build
are prepared before the current history entry is replaced. A preparation
failure does not pretend that the old attempt was replaced. The panel-tree id
and handle remain stable, while runtime entity, build key, and CDP endpoint are
incarnation-scoped. Create one fresh CDP page after either operation resolves;
more generally, replace the page whenever a lifecycle result changes
`runtimeEntityId`.

## Snapshot provenance

```ts
const capture = await panel.snapshot();
// {
//   panelId,
//   attemptId,
//   runtimeEntityId,
//   buildKey,
//   capturedAt,
//   document: { kind: "synth", text, structure }
// }
```

Always inspect `capture.document`, not the top level. The identities prevent a
capture from being mistaken for a later rebuild or navigation.

## Diagnostics

Use one diagnostic call when something is wrong:

```ts
const packet = await panel.diagnose();
console.log(packet.observation);
if (packet.consoleHistory.available) console.log(packet.consoleHistory.errors);
else console.log(packet.consoleHistory.error);
console.log(packet.document?.document.text);
```

`consoleHistory` has `entries`, `errors`, `dropped`, and `capacity`; it has no
separate `warnings` array. Filter warnings with
`entries.filter((entry) => entry.level === "warning")`.

`diagnose()` is safe for a failed attempt: it returns the canonical failure and
whatever bounded host evidence exists instead of requiring a successful
snapshot first. `workspace.units.diagnostics(source)` reads bounded historical
unit health, build events, and errors; it does **not** request a new build and
must not be used as proof that the current working source compiles. Use
`services.build.getBuildReport(source, \`ctx:${ctx.contextId}\`)` for that
structured compile/build check. Read server logs only when the panel packet
shows the failure is below the lifecycle boundary.

## State and agent inspection

Inside a panel:

```ts
import { panel } from "@workspace/runtime";

const initial = panel.stateArgs.get();
await panel.stateArgs.set({ theme: "dark" });
```

From a handle:

```ts
await handle.stateArgs.set({ theme: "dark" });
const next = await handle.stateArgs.get();
```

`handle.state()` is empty unless the application registers state providers via
`useAgentState` or `agentApi.registerStateProvider`.

## CDP

`handle.cdp.page()` is the sole Playwright-style automation surface.
Do not install Playwright. For historical diagnostics use `diagnose()`; use
`handle.cdp.consoleHistory()` only when you specifically need a filtered console
read. CDP access is served by the active desktop/headless host and rejects when
a non-CDP mobile host owns the target.

In server-side eval, use this handle API directly. The CDP client selects the
runtime's supported WebSocket transport; do not open the panel's private HTTP
URL, construct a raw WebSocket, or install a second browser library as fallback.

The page surface includes `page.keyboard.press/type/insertText`,
`page.setViewportSize/viewportSize`, `locator.evaluate/evaluateAll`, regex
text/name locators, and React-compatible form updates. Browser callbacks are
serialized into the page realm, so pass external data as the explicit callback
argument. Browser evaluation errors preserve the real exception description
and stack; locator failures add the exact rendered locator. See
[BROWSER.md](BROWSER.md) for the complete supported surface.

## Ownership

Close temporary panels in `finally`. Reuse an existing handle rather than
opening duplicates. Leave a panel open only when the user asked to keep it or it
is the primary deliverable being inspected.
