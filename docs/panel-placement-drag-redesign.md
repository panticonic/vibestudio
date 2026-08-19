# Panel placement drags — first-principles redesign

Status: implemented (2026-08-19) in the Base checkout under `apps/shell`.
Supersedes the tree→viewport drop shelf described by the multi-column layout
plan (§D8) and the `place-from-tree` engine action.

## 1. What was wrong

The shell had one drag gesture with two grammars fused into it, arbitrated by a
collision solver.

1. **The drop vocabulary did not come from the layout.** Three droppables were
   registered over the viewport — left half, right half, and the whole viewport
   — all overlapping, all with `pointerEvents: none`, resolved by dnd-kit's
   `closestCenter` against *the tree rows as well*. Near a boundary the winning
   target was a function of centre distances between incomparable things, so it
   was not predictable from anything on screen.

2. **The drop did not mean where you dropped.** `left`/`right` inserted a new
   column beside **the focused pane**, not beside the column under the cursor;
   `full` isolated the panel. With focus on column 1 of 3, dropping on the right
   half put the panel next to column 1. The tinted half-viewport preview
   therefore did not predict the outcome.

3. **Every drag tore down every panel.** `ColumnRow` passed
   `resident={treeDragActiveId === null}`, so the first pixel of *any* tree drag
   — including a pure reorder that never leaves the sidebar — unmounted every
   `PanelSurface`, which cleared each native slot; on drop they rebound and
   re-presented, re-running loading for anything the host had unloaded. This is
   the blink-out that made the feature feel broken.

4. **The layout could not be edited directly at all.** Panes had no drag
   handle: no reordering columns, no moving a pane between columns, no vertical
   split by drag. `move-pane-to-new-column` existed in the engine but only the
   context menu could reach it.

5. **The state had no owner.** Drag state lived in dnd-kit; layout targets were
   encoded into droppable id *strings*, parsed back in the dnd provider, and
   delivered to `PanelStack` through a `window` CustomEvent — a side channel
   around the component tree.

## 2. The constraint that shapes everything

Panel views are native Electron `WebContentsView`s composited **above** all
shell DOM. The shell therefore cannot draw over a panel, and cannot even
receive pointer events over one. Any design where the viewport is a drop
surface must first take the viewport away from the panels.

The host already has the right primitive: `setShellOverlay(true)` hides panel
views (`view.setVisible(false)`) **without unbinding their slots**, so nothing
is torn down, nothing reloads, and restoring is a repaint. That is what a
placement drag now uses; the old code achieved the same visibility by
unbinding, which is why it was expensive.

## 3. The model

**A drop is a layout coordinate, not a pixel and not an index.**

```ts
type LayoutDropTarget =
  | { kind: "new-column"; afterColumnId: string | null }   // insert a column at that seam
  | { kind: "pane-edge"; paneId: string; edge: PaneEdge }  // split that pane
  | { kind: "pane-center"; paneId: string };               // take that pane over
```

Ids, not indices: a drop that moves an on-screen pane detaches it first, which
can delete a column and renumber everything after it.

**Hit-testing is geometry** (`layout/dropGeometry.ts`). The pointer is tested
against the pane rectangles the user is already looking at:

- inside a pane — the nearest edge wins if the pointer is inside that edge's
  band (25% of the dimension, clamped to 20–140 px and never more than 40%, so
  a tall narrow pane keeps a usable centre and a short one keeps grabbable
  edges); otherwise it is the centre;
- inside a column but between panes — the seam reads as "below the pane above";
- in a column divider, or outside the columns — a new column at that seam.

Every point resolves to exactly one target, and each boundary is a boundary the
user can see.

**Preview and outcome are one function.** `dropPreview(target, geometry)`
returns the region (or seam) for the *same* target the engine will apply, and
the engine's `refineDropTarget` runs *before* the preview is drawn — so a
vertical split the column cannot fit is downgraded to a side column while the
pointer is still held, rather than surprising the user on release. (That
downgrade is rule 3's existing split-below → open-beside fallback, applied to
drags.)

**One engine action.** `place-panel` replaces `place-from-tree`:

| Target | From the tree | From a pane |
| --- | --- | --- |
| `pane-center` | replace the occupant (it stays in the tree) | **swap** the two panes' panels |
| `pane-edge` top/bottom | stack in that column | move and stack |
| `pane-edge` left/right | new column beside that column | move to a new column |
| `new-column` | new column at that seam | move to a new column |

A moved pane is **re-inserted as the same `LayoutPane` object**, so its pane id
— and with it the native slot the host has already bound — survives the move.
Moving a panel across the layout re-bounds a live view instead of destroying
and recreating it. Drops that would land a pane where it already is degrade to
a focus.

**Blueprint mode** (`components/LayoutBlueprint.tsx`). While a drag is live the
viewport shows the layout as itself: every pane a sheet of glass at exactly its
own geometry with its icon and title, the lifted pane an empty dashed socket,
and one saturated highlight where the drop lands. It is translucent over the
chrome rather than a flat grey stand-in. Turning the native-view constraint
into a mode is deliberate: while you are moving panels you are editing the
layout, so the layout is what you should see.

**One rule decides the grammar**: the pointer is over the layout (placement) or
over the tree (reparent). The tree's insertion indicator is suppressed whenever
a layout target is live, so there is never more than one insertion mark on
screen for one pointer.

## 4. Ownership

`LayoutDragContext` owns "a panel is being dragged into a position": the
source (`{ panelId, title, fromPaneId }`), the measured geometry (taken once at
drag start — the layout cannot change mid-drag), the live refined target, the
rAF-coalesced pointer, blueprint mode, and Escape-to-cancel. Both sources call
into it — dnd-kit's `onDragStart`/`onDragEnd` for tree rows, `beginPaneDrag`
for a pane grip — and `endDrag()` reports whether it committed a placement, so
the tree move is simply what happens when it did not. `ColumnRow` registers the
element to measure plus the engine's `refine`/`commit`. The CustomEvent, the
droppable-id encoding, and `dropTargets.ts` are gone.

## 5. Direct manipulation and keyboard

The pane header grip (the same one the rail shows on hover) is now the pane's
drag handle, and while focused it is a **move handle**: plain arrow keys place
the pane left/right/up/down through the same `place-panel` action. That is the
accessible equivalent of the drag, and it needs no global chord — the existing
`Ctrl/Cmd+Alt+arrow` bindings keep meaning "move the focus ring".

## 6. Tests

- `layout/dropGeometry.test.ts` — the resolver: edges, corners, seams,
  dividers, out-of-viewport, and a sweep asserting every point in the viewport
  resolves to exactly one target; preview rectangles for each kind.
- `layout/placementEngine.test.ts` — `place-panel` per target kind, replace vs
  swap, pane-id survival across a move, column collapse, no-op drops,
  missing-target fallback, `refineDropTarget`, plus the existing randomised
  invariant fuzz extended to emit random `place-panel` actions (25 seeds × 60
  actions).
- `tests/e2e/flows/multiColumnLayout.spec.ts` — scenario 5 now drags a tree row
  onto a *named pane's* centre and left edge through real input, asserts the
  blueprint resolved a preview before release, and asserts the resulting
  surfaces.

## 7. Known follow-ups

- **Blueprint entry is eager.** Panel views are hidden from the first pixel of
  any panel drag, including one that only reorders the tree. Deferring until
  the pointer crosses into the viewport requires knowing whether Chromium
  routes mouse events to the shell view while a button is held over a sibling
  `WebContentsView` (mouse capture across views). Until that is measured,
  eager entry is the deterministic choice: hiding is cheap and reversible,
  whereas missing the crossing would make the drop silently impossible.
- **Panel thumbnails.** Blueprint cards could show a captured image of each
  panel instead of an icon and title, which would make the diagram read as the
  workspace. It needs a host capture RPC the shell does not have today.
