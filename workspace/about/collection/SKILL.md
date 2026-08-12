---
name: collection-conductor
description: Inspect, annotate, automate, title, group, move, or recursively reorganize the panel subtree owned by a Vibestudio collection conductor.
---

# Collection conductor

The collection system prompt supplies a stable `rootPanelId`. That id defines
the scope; a list of panel ids in chat does not. Traverse only the sibling
groups needed for the task, one bounded page at a time:

```ts
import { panelTree } from "@workspace/runtime";

const pending = [rootPanelId];
const workLimit = 500;
let visited = 0;
while (pending.length && visited < workLimit) {
  const parentSlotId = pending.shift()!;
  let cursor: string | undefined;
  let revision: number | undefined;
  do {
    const page = await panelTree.page({
      group: { kind: "children", parentSlotId },
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    if (revision !== undefined && page.revision !== revision) {
      throw new Error("Panel tree changed during traversal; restart from the first page");
    }
    revision = page.revision;
    for (const { node, handle } of page.entries) {
      console.log(handle.id, handle.title, node.childCount);
      if (node.childCount > 0) pending.push(handle.id);
      if (++visited >= workLimit) break;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor && visited < workLimit);
}
```

Choose an explicit work limit appropriate to the request; ask for narrower
scope instead of silently crossing it. `node.childCount === 0` means
structurally childless, not necessarily a browser panel. After a create, move,
close, or batch rename, restart affected sibling groups at their first page.
Compare `revision` between pages to detect changes made by the user, another
agent, or another client. Never maintain a parallel complete tree in eval
state.

## Titles and notes

Use semantic titles for navigation, not descriptions:

```ts
await node.handle.setTitle("Gmail · Support inbox", { explicit: true });
```

An explicit title survives inferred document-title changes. Prefer existing
page title and URL metadata. Do not materialize every deferred browser panel
just to replace an already-useful title.

When the target itself is a collection panel, also merge
`{ title: "…" }` into its state args. The explicit slot title is what its
parent renders; `stateArgs.title` is what the collection renders internally.

Notes for a collection scope live in the root collection's `stateArgs.notes`
map, keyed by stable panel slot id. Merge rather than replace unrelated state:

```ts
const root = panelTree.get(rootPanelId);
const state = await root.stateArgs.get<{ notes?: Record<string, string> }>();
await root.stateArgs.set({
  notes: { ...(state.notes ?? {}), [targetPanelId]: "Needs account selection" },
});
```

Remove an obsolete key by writing a rebuilt map without it; do not put
workspace context ids or other authority data in state args.

## Grouping and moving

Create a nested collection only for a stable, useful concept—not merely
because several URLs share a hostname:

```ts
import { openPanel } from "@workspace/runtime";

const group = await openPanel("about/collection", {
  parentId: rootPanelId,
  contextId: panelTree.get(rootPanelId).contextId,
  title: "Release engineering",
  focus: false,
  stateArgs: {
    title: "Release engineering",
    note: "Builds, CI runs, and release artifacts",
  },
});
```

Collection descendants created for semantic grouping share the root
collection's orchestration context. This lets every recursive collection
conductor supervise that subtree without a prompt per panel. Do not omit
`contextId` and accidentally mint an unrelated context for a nested collection.

Move or reorder existing panels with their handles:

```ts
await target.handle.movePanel(group.id, 0);
```

Rules:

- Never move the scope root into its own subtree.
- Preserve useful imported-window structure unless a semantic organization is
  clearly better.
- Moving a collection moves its recursive subtree; do not separately move its
  descendants.
- Refresh after a structural batch and verify the resulting parent ids and
  order.
- Keep ambiguous panels where they are and ask the user instead of inventing a
  taxonomy.

Tree placement is not capability inheritance. Collection-owned recursive
subtrees share an explicit orchestration context, and panels spawned by the
collection, its bound agent, or that agent's eval are also creator-controlled
through immutable runtime ancestry. Both relationships make ordinary
coordination prompt-free. An unrelated panel moved into the collection retains
its original context and provenance; reparenting it does not silently give the
collection runtime or CDP control. Its first cross-context operation uses the
normal exact requester/target-context approval, whose scoped grant is reusable
for that context rather than prompting per operation.

## Browser automation

Tree inspection, semantic renaming, notes, and moving do not require a browser
runtime. Use CDP only when page content is needed:

```ts
const browserNodes = scope.descendants.filter((node) => node.handle.kind === "browser");
const page = await browserNodes[0].handle.cdp.page();
console.log(await page.title(), page.url());
```

CDP materializes a deferred target. A mass import is intentionally unloaded,
so never connect every leaf with an unbounded `Promise.all`. Work in small
batches (normally 2–4), retain per-panel failures, and refresh the subtree
between batches if the user may be editing it concurrently.

Reuse one CDP page for the current runtime incarnation. If `observe()` reports
a different `runtimeEntityId` after navigation or rebuild, discard the old page
and acquire a new one.

## Completion

After changing a collection:

1. Refresh the subtree.
2. Verify titles, parent ids, and child order from the new snapshot.
3. Report structural changes separately from content automation.
4. Mention panels left ambiguous and any CDP failures without aborting the
   rest of the batch.
