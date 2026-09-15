# Native panel churn handoff

## Verified resolution

The handoff has been checked against the implementation. Its observations were
useful, but several proposed remedies were either larger than the defect or
based on an incomplete model of the Electron-local RPC path.

- Creation placement now has one authority: `panel-created`. Focused creation
  completes host-local focus mechanics without also emitting the
  existing-panel `navigate-to-panel` command.
- Native-slot logical focus is separate from imperative WebContents focus.
  Same-panel rebinds, repeated focus synchronization, and native-view
  recreation no longer steal interactive focus from shell chrome.
- Focus listeners are installed per WebContents incarnation, including after a
  destroyed panel view is recreated.
- Bind, update, and clear carry a renderer-document identity, binding sequence,
  and operation sequence. `ViewManager` rejects operations older than the last
  accepted operation for the slot, so concurrent asynchronous service dispatch
  cannot resurrect a relinquished binding. Renderer updates wait for the bind
  acknowledgement, cleanup supersedes a pending bind immediately, and stale
  completions cannot schedule retries.
- A full shell document replacement starts a fresh ordering epoch; cleanup from
  the replaced document is ignored.

The presentation-forest fanout is bounded by the Electron runtime projection,
not by durable panel-history size. Durable history is read through the
query-first paginated tree APIs, while `PanelManager` keeps at most 256 recently
touched panels in `PanelRegistry` and evicts older projections by address. The
fanout is therefore O(runtime-cache size), with a fixed upper bound, rather than
O(browser-history size). Further changed-ID work remains a measurement-driven
constant-factor optimization; deriving a diff by rescanning or hashing the
bounded forest would add another cache without changing history-scale behavior.

Focused regressions cover focused creation authority, same-panel rebind focus,
view recreation focus feedback, clear-before-bind delivery, late older claims,
pending-bind unmount, StrictMode replay, and shell-document replacement.

## Scope

The reported session repeatedly reused one native slot:

`panel-stack:pane-7768785e`

The sequence included bindings for the chat panel, browser-import inspector,
the taskflow board, and the parent shell surface. The stale-clear messages are
partly expected: each `PanelSurface` cleanup is asynchronous and carries an
incarnation guard, so an old cleanup is rejected after a newer bind owns the
slot. `Created view` means that a managed Electron view was materialized; it
does not mean that every bind caused a new WebContentsView.

The X11 `atom_cache.cc` portal MIME-type errors are Chromium/Linux warnings
and are not causally connected to the panel-slot churn.

## Completed straightforward fixes

1. `ViewManager` no longer falls back to the just-removed `visiblePanelId`
   when the last focused native slot is cleared. The old fallback could leave
   the manager reporting a panel as visible after its slot and native view had
   both been released. See `src/main/viewManager.ts` and the regression in
   `src/main/viewManager.test.ts`.

2. `PanelTreeProvider` now treats `panel-presentation-changed.revision` as a
   monotonic sequence. Older events are ignored, and an async read belonging
   to an older revision cannot overwrite a newer read. The selected-child map
   also preserves its existing `Map` when all updates are no-ops, avoiding an
   unnecessary provider render. See
   `workspace/apps/shell/shell/hooks/PanelTreeContext.tsx` and its focused
   regression in `PanelTreeContext.pins.test.tsx`.

Validation completed:

```text
pnpm exec vitest run src/main/viewManager.test.ts \
  workspace/apps/shell/shell/hooks/PanelTreeContext.pins.test.tsx \
  workspace/apps/shell/components/PanelSurface.test.tsx
86 tests passed
```

## Medium issues

### 1. Presentation-event authority and duplicate focus work

`panelOrchestrator.createPanel()` emits `panel-created`, then
`attachCreatedPanel()` calls `focusPanel()` when creation requested focus.
Those paths can both cause the shell to place/focus the new panel. The source
comments explicitly describe the local focus call as an idempotent fallback
for host/test-created panels, so simply deleting either event or call would
break a real fallback path.

Relevant code:

- `src/main/panelOrchestrator.ts` around `panel-created` emission
- `src/main/panelOrchestrator.ts` around `attachCreatedPanel()` and
  `focusPanel()`
- `src/main/index.ts` where the local presentation snapshot is fanned out as
  `panel-presentation-changed`

Recommended handoff:

- Decide which layer owns initial placement and which layer only repairs it.
- Give the placement operation an explicit transaction/operation identity so
  duplicate deliveries can be observed and deduplicated without relying on
  timing.
- Preserve the host/test-created fallback, but make its authority and
  completion condition explicit.
- Add a test for focused creation, non-focused creation, duplicate delivery,
  and fallback delivery when the server event is absent.

### 2. Focus can be stolen during a bind/rebind

`bindPanelSlot(... focused: true)` calls
`setFocusedNativePanelSlot()`, which calls `focusVisibleView()`, which calls
`webContents.focus()`. This is correct for a genuine focus transition, but a
rebind caused by layout churn, StrictMode effect replay, or view recreation can
therefore steal focus from shell chrome, the address bar, or another native
surface. The binding path also installs a WebContents focus listener, so an
imperative focus can feed back into shell focus bookkeeping.

Relevant code: `src/main/viewManager.ts` around `bindPanelSlot()`,
`setFocusedNativePanelSlot()`, and `handleNativeSlotViewFocus()`.

Recommended handoff:

- Separate “record this slot as focused” from “imperatively focus its
  WebContents”.
- Only perform the imperative focus when the requested focus state is a real
  transition for the current owner/incarnation.
- Define what should happen when shell chrome currently has interactive focus.
- Add a regression that types into shell chrome, causes a same-panel rebind,
  and verifies that focus is not stolen unless the user-selected pane changed.

### 3. Presentation fanout is still O(tree size)

The revision/no-op fix removes stale writes and avoidable renders, but the
main process still sends every panel ID in the presentation forest on each
registry snapshot, and the provider calls `getPresentation()` for every ID.
This is acceptable for a small tree but becomes a visible source of work as
the tree grows.

Recommended handoff:

- Make the registry event carry changed panel IDs (or a compact diff) while
  retaining the global revision.
- Keep the current monotonic guard at the consumer boundary.
- Measure RPC count and provider render count for a large tree before and
  after the change; do not infer improvement from log volume alone.

### 4. Recreated views retain a focus-listener closure for the old WebContents

`restorePanelSlotIfPending()` reuses the remembered slot object. That object’s
`detachFocusListener` closure was created for the old panel WebContents, so a
destroy/recreate cycle can restore the slot visually without installing a
focus listener on the replacement WebContents. This is adjacent to the
churn, but it is a real lifecycle hole rather than a log-only concern.

Recommended handoff:

- Store slot ownership/bounds/focus data separately from per-WebContents
  listener functions.
- Attach a fresh listener whenever a managed panel view is created or
  restored.
- Test destroy → recreate → native focus and verify the shell receives one
  focus notification from the new WebContents.

## Complex issue: bind/clear linearizability

This is the highest-risk item and should be handled as a protocol redesign,
not by adding another boolean or delay.

`PanelSurface` currently marks `boundRef.current = true` before the async bind
RPC resolves, and marks it false before the async clear RPC resolves. The
component can therefore issue operations in this order:

```text
bind(A) begins
component unmounts or changes owner
clear(A) begins
bind(A) resolves after clear(A), or is processed after it
```

The native slot can then be resurrected after React believes the surface is
gone. The same class of race can occur when a `bindingKey` changes, because
the component invalidates its local bookkeeping and schedules a new bind while
the previous operation may still be in flight. React StrictMode in
`workspace/apps/shell/index.tsx` amplifies the effect by replaying mount/effect
lifecycle work, but disabling StrictMode would only hide the race.

Relevant code: `workspace/apps/shell/components/PanelSurface.tsx` around
`clearSlot()`, `syncSlot()`, the `bindingKey` effect, and the unmount cleanup;
`src/main/viewManager.ts` around `bindPanelSlot()` and
`clearPanelSlot()`.

Desired invariant:

> After a surface has relinquished an ownership incarnation, no later
> completion or delayed delivery belonging to that incarnation may leave that
> incarnation active in the native slot.

Suggested design direction:

- Model the renderer side as a desired-state queue with one serialized
  operation chain per native slot. A new desired owner supersedes the old
  desired owner; cleanup is not allowed to race an unsequenced bind.
- Give each claim/operation an explicit incarnation and sequence. The main
  process must reject stale operations by slot and owner generation, rather
  than relying on promise completion order.
- Keep retry behavior inside that state machine. A retry may only bind the
  currently desired incarnation; an old retry timer must not revive a released
  surface.
- Keep `bindingId` as an ownership identity, but do not use it as a substitute
  for operation ordering unless its semantics are made explicit across
  component remounts and binding-key changes.

Required tests before considering this fixed:

1. Deferred `bind`, then unmount, then deferred `clear`; resolve in both
   orders and assert the slot is inactive.
2. Bind A, replace with B, deliver A’s late completion, and assert B remains
   active.
3. Change `bindingKey` while bind is pending and assert only the newest claim
   can become active.
4. Replay the mount/effect lifecycle under StrictMode and assert one final
   active binding with no leaked retry timer or focus listener.
5. Run the native-slot ViewManager tests together with the PanelSurface tests;
   renderer-only tests cannot prove the main-process ordering invariant.

## Non-goals for the next agent

- Do not remove stale-clear logging; it is useful evidence that the guard is
  working.
- Do not disable React StrictMode as the fix.
- Do not delete the creation fallback until event authority is redesigned and
  covered by tests.
- Do not treat the Chromium portal MIME warnings as an application panel bug.
