# Agent Panel Workflow

Use one runtime concept: `PanelHandle`. `openPanel(source, options)` opens both
workspace panels and URLs and returns a handle. Opening a panel is a structural
tree mutation and may prompt on first use for the requester entity and
parent/root target. `listPanels()` rediscovers existing handles.

## Semantic workspace development

Workspace development runs on exact event/application state nodes, not
independent per-directory snapshots. Read the canonical
[Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) before changing source.

The lifecycle is:

1. Call `vcs.status` and keep the returned committed event and working head.
2. Author through `edit`/`write` or the managed VCS edit surface. Each
   user-visible intent becomes a work unit and one local application.
3. Typecheck, test, or build against that context's current materialization.
4. If main or another source advanced, compare the exact source event. Adopt,
   reconcile, or decline useful changes through small `vcs.integrate` steps and
   run checks between them.
5. Commit the complete local application chain. Work that needs a different
   commit boundary belongs in another context.
6. Publish the clean committed event. Publication validates semantic ancestry
   and integration, obtains approval, and atomically advances protected refs.
7. Let the separate post-publication build projection produce an artifact, then
   open or reload the running unit at the intended build ref and verify
   behavior. Failed activation retains the previous runnable artifact.

Repository and path filters are views over this workspace graph. They are
useful for inspection, but they are not revision identity or commit boundaries.
Do not reconstruct incoming obligations or provenance from a rendered file diff.

For managed source moves and copies, use `vcs.move` and `vcs.copy`, or
the managed runtime/agent filesystem adapter. A
move preserves `fileId`; a copy creates a new `fileId`, records an
`authored-copy-source` relation to the exact source file and state, and records
`copies-content` mappings for preserved coordinates. Neither operation relies
on delete/recreate heuristics.

For external ingress, use `vcs.importSnapshot` with a canonical credential-free
source URI, exact source revision, and complete repository/file descriptors
naming CAS bytes. The semantic workspace verifies those host-observed
descriptors and derives the snapshot digest. Do not reconstruct an import as a sequence of ordinary
authored edits or partial repository loops.

## Development loop

1. Scaffold with eval:

```ts
import { createProject } from "@workspace-skills/workspace-dev";

const created = await createProject({
  projectType: "panel",
  name: "my-app",
  title: "My App",
});
return created;
```

Require `created.preflight.ok === true`, then retain `created.publication`: the
former proves the planned repository was validated before mutation and the
latter proves the committed event reached protected main. If the eval fails with
`errorData.code === "scaffold_publication_failed"`, the repository is already
committed but unpublished. Do not scaffold again. Call
`recoverProjectPublication(error)` from the same skill. It validates a clean
context at the exact `committedEventId` and applies the recorded command-ID
policy without rerunning file generation or commit.

Skip scaffolding for context-local notes. Write inside a repo-shaped path such
as `projects/tmp-name/note.md`; that work remains private until its semantic
application chain is committed and its event is published. File-oriented APIs may
canonicalize `projects/note.md` to `projects/note/note.md`; retain the returned
canonical path.

2. Edit with the `edit`/`write` filesystem tools, not eval. Keep semantic
   intent together: a coordinated rename, schema/client update, or multi-file
   behavior change should be one coherent work unit even when it crosses
   repository views.

3. Keep the returned working head, then typecheck, test, or build that context.
   Build results create no semantic event and grant no publication authority.

4. Compare with current main before committing or publishing:

```ts
import { vcs } from "@workspace/runtime";

const status = await vcs.status({ contextId: ctx.contextId });
const comparison = await vcs.compare({
  target: status.workingHead,
  sourceEventId: status.mainEventId,
  view: "changes",
});

console.log(comparison.counts, comparison.changes);
```

If there is incoming work, use `vcs.integrate` to adopt applicable source
changes, reconcile with exact state-predicate evidence, or decline with a
rationale. Continue from each successful result's returned working head.
When judgment changes product intent, show the alternatives and ask the user.

5. Commit the complete local chain as one truthful semantic boundary:

```ts
const committed = await vcs.commit({
  commandId: crypto.randomUUID(),
  contextId: ctx.contextId,
  expectedWorkingHead: latestWorkingHead,
  message: "Implement the panel behavior",
});
```

There is no staging or partial commit. Split independent work into another
context before authoring it. Use `vcs.revert` for a deliberate counteraction or
`vcs.discard` to drop the complete uncommitted chain.

6. Publish only after the context is clean and the intended event passes its
   ordinary checks. If current main advanced, compare and integrate it locally,
   commit the resulting complete chain, then retry publication. An ancestry,
   integration, authorization, approval, or atomic-ref rejection moves no
   protected pointer. A later build or activation failure leaves publication in
   place and retains the previous runnable artifact.

Every semantic context mutation includes `expectedWorkingHead` and a `commandId`.
When a response is lost, retry the identical request with the same command ID.
After `RevisionChanged` or any request change, re-observe the basis and use a
new command ID. Follow the typed discriminant, not prose.

7. Open once after a green publication, or open an explicitly ref-pinned
   context build when the API supports it:

```ts
import { openPanel } from "@workspace/runtime";

scope.myApp = await openPanel("panels/my-app", { focus: true });
const first = await scope.myApp.snapshot();
console.log(first.attemptId, first.buildKey, first.document.text);
```

Runtime-managed workers and Durable Objects follow their owning context unless
explicitly pinned to another `ref`. Panel APIs keep their own build-ref
semantics; when testing unpublished panel code, pass the context ref on the
ref-capable launch/navigation path.

8. Iterate visually with the same handle:

```ts
const observation = await scope.myApp.rebuild();
console.log(observation.phase, observation.attemptId, observation.buildKey);
const capture = await scope.myApp.snapshot();
console.log(capture.document.text);
```

`rebuild()` transactionally prepares and activates a new immutable runtime
attempt at the panel's active build ref, then waits for the application boot
handshake. It does not create work, commit an event, publish main, or affect
child panels.

| Method       | Completion                                                                              |
| ------------ | --------------------------------------------------------------------------------------- |
| `observe()`  | Returns the canonical current attempt and phase without mutating it                     |
| `rebuild()`  | Atomically replaces the current entry with a prepared attempt and returns at boot-ready |
| `reload()`   | Reloads the current renderer and returns at boot-ready                                  |
| `navigate()` | Prepares a new source/ref/context attempt and returns at boot-ready                     |

Before reloading a parent or ancestor, verify the target:

```ts
const observed = await handle.observe();
console.log(
  observed.panelId,
  observed.source,
  observed.contextId,
  observed.requestedRef,
  observed.runtimeEntityId,
  observed.buildKey,
  observed.phase
);
```

Readiness-bearing lifecycle results are `PanelObservation` values. `phase:
"ready"` means both host navigation and application bootstrap completed.
Failures throw `PanelOperationError` with the same provenance fields.
Slot creation itself is durable and immediately observable; runtime preparation
continues asynchronously so one broken panel cannot hold the panel-tree queue.
`openPanel` bridges those two boundaries by waiting up to 90 seconds for the
created attempt's terminal observation.

9. Tune running state without reopening:

```ts
await scope.myApp.stateArgs.set({ theme: "dark", mode: "fixture" });
await scope.myApp.setMode("fixture");
```

## Managing child panels

Use `listPanels()` from agent eval to inspect the current tree. Use
`handle.children()` for a fresh child list and close stale children explicitly.

```ts
import { listPanels } from "@workspace/runtime";

const roots = await listPanels();
for (const panel of roots) {
  console.log(panel.id, panel.kind, panel.source);
}

const children = await scope.myApp.children();
await children[0]?.close();
```

Reuse an existing handle instead of opening duplicates. Scalar handle fields
are last-observed descriptors; call `handle.observe()` whenever live state
matters. Close temporary inspection, browser, diagnostic, and child panels in
`finally`.

## Browser panels

URLs also use `openPanel`:

```ts
import { openPanel } from "@workspace/runtime";

const sitePanel = await openPanel("https://example.com", { focus: true });
try {
  const page = await sitePanel.cdp.lightweightPage();
  await page.title();
} finally {
  await sitePanel.close();
}
```

CDP automation lives under `handle.cdp`. `openPanel()`, `focus()`, `navigate()`,
`reload()`, and `rebuild()` already establish boot readiness; there is no
separate handle lease/load step.

## Verification

Use `handle.snapshot()` for a provenance-bearing agent-readable view and read
its `document` field. Use `handle.tree()`,
`handle.state()`, and `handle.routes()` for deeper inspection. Typecheck before
launch when the change is more than a small text edit.

For runtime failures, choose the narrowest log surface first:
`handle.diagnose()` for the canonical observation plus bounded renderer evidence,
`workspace.units.diagnostics(name)` for unit state, and `serverLog` for host
behavior. See [server logs](../server-logs/SKILL.md).

Tie every verification result to its exact build/state provenance. If the
runtime appears unchanged, verify the active build ref and traverse the
expected work unit, application, event, and publication instead of repeating
the edit.

## Forking existing projects

Forking is a semantic operation, not an unstructured directory copy. Dry-run
the workspace-dev helper to review metadata and class rewrites, then apply it
as one coherent lifecycle work unit:

```ts
import { forkProject } from "@workspace-skills/workspace-dev";

const plan = await forkProject({
  from: "workers/source-worker",
  to: "workers/new-worker",
  title: "New Worker",
  dryRun: true,
});
console.log(plan);
```

For workers with multiple Durable Object classes, pass an explicit `classMap`.
After applying, inspect the returned working head and work-unit identity, run
the build, commit the complete chain, publish, then launch the intended build.

Use the VCS file-copy batch when the operation is literally a set of managed
file copies with exact source and content-mapping provenance. Use a dedicated
lifecycle/fork operation when package metadata, runtime registrations, class
names, and other dependent intent must change together. Neither should infer a
semantic boundary from selected paths or content similarity.
