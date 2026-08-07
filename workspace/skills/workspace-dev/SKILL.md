---
name: workspace-dev
description: Build and develop Vibestudio workspace units — project scaffolding, panels, workers, Durable Objects, runtime publishing, repo-local SKILL.md authoring, and development workflow.
---

# Workspace Development Skill

Documentation for developing Vibestudio workspace units, including panels, workers,
packages, skills, and extensions.

For trusted workspace apps under `apps/` (`@workspace-apps/*`, Electron shell,
mobile React Native, or terminal targets), use the `appdev` skill instead.

When authoring skill docs, keep repo-specific guidance in the repo it documents
as a top-level `SKILL.md`. Use `skills/<name>` only for cross-repo workflows or
skills that are themselves reusable code packages.

## Repo-Local Skill Docs

Any workspace repo can carry a top-level `SKILL.md`. Add or update that file
when a package, panel, worker, extension, project, template, about page, or
other repo needs agent guidance that should travel with its code.

Use repo-local skill docs for implementation-specific workflows, APIs, schemas,
debugging recipes, generated files, ownership notes, or schema-migration guidance. Put
the file at the repo root:

- `packages/foo/SKILL.md`
- `workers/foo/SKILL.md`
- `panels/foo/SKILL.md`
- `extensions/foo/SKILL.md`
- `projects/foo/SKILL.md`

Use `skills/<name>/SKILL.md` only for workspace-wide workflows, cross-repo
guidance, or a reusable skill package that exports code. The built-in onboarding
skill intentionally stays at `skills/onboarding/SKILL.md` because it describes
the whole workspace. Trusted app repos under `apps/` can also carry `SKILL.md`,
but use the `appdev` skill when developing those apps.

Agents read skills by the path shown in the generated skill index, for example
`read("packages/foo/SKILL.md")`; do not assume every skill lives under
`skills/<name>`.

## Files

| Document                                   | Content                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)                 | Canonical agent workflow: scaffold, open, inspect, edit, rebuild/reload, close                                                                                   |
| [PANEL_DEBUG_LOOP.md](PANEL_DEBUG_LOOP.md) | Short canonical create/build/screenshot/rebuild/interact/publish recipe for panel debugging and polish tasks                                                     |
| [PANEL_API.md](PANEL_API.md)               | Runtime panel API reference                                                                                                                                      |
| [WORKERS.md](WORKERS.md)                   | Workers & Durable Objects: DO-backed app databases, AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, custom shared-resource approval grants |
| [capabilities](../capabilities/SKILL.md)   | Explicit requests and provided capabilities, dynamic workspace service discovery, host grants, receiver-owned acquisition, and content provenance                |
| [performance](../performance/SKILL.md)     | Bounded panel/app profiling plus build, worker, startup, and optimization workflow                                                                               |
| [RPC.md](RPC.md)                           | Typed parent-child contracts                                                                                                                                     |
| [BROWSER.md](BROWSER.md)                   | Browser automation (Playwright/CDP)                                                                                                                              |
| [TOOLS.md](TOOLS.md)                       | Agent tools reference                                                                                                                                            |
| [create-project.ts](create-project.ts)     | Project scaffolding helpers (importable via eval `imports` parameter)                                                                                            |

For host-process debugging while developing workspace units, pair the relevant
unit/panel diagnostics below with the [server-logs](../server-logs/SKILL.md)
skill. `serverLog` captures the workspace server's own logs and supports live
following through `server-log:append` and the `about/server-logs` viewer.

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`.

## Critical Rules

0. **Build production-ready systems** — workspace units are durable
   infrastructure, not throwaway prototypes. Design for real use from the start:
   proper schema migrations, error surfaces, principled state management, and
   tested edge cases. Do not scaffold a "v1 prototype" with the intent to
   rewrite later. Do not populate apps with hardcoded demo data or placeholder
   content — build real empty states, real data entry flows, and real
   persistence from the start.

For a panel build/debug/polish task, read and follow
[PANEL_DEBUG_LOOP.md](PANEL_DEBUG_LOOP.md) first. It is the canonical bounded
recipe. Do not preload the full workflow, browser, panel, and eval manuals; open
only the specific reference needed when the recipe reaches an unfamiliar typed
result.

1. **Relative workspace paths only** — use `panels/my-app/index.tsx`, NEVER host absolute paths such as `/home/.../workspace/...`. In runtime `fs.*` calls, `/panels/...` is context-root absolute and accepted, but docs and source-edit examples prefer `panels/...` to avoid ambiguity.
2. **NEVER use Bash** for vcs, file listing, or file creation — use the structured tools
3. **Use filesystem tools for file edits** — Read, Edit, Write (not eval).
   Whole-file Write is idempotent: writing bytes already present in the
   working file succeeds with `details.unchanged: true` and records no semantic
   edit. Treat that as completion, not as a reason to manufacture a different
   change.
4. **Use eval only for runtime operations** — project creation, typecheck, tests, launching panels
5. **Eval injected globals + package imports** — in eval, the **ambient-only** globals `scope`, `scopes`, `db`, `ctx`, `help`, and (in agent eval) `chat`/`agent` are injected free variables; do **not** `import` them. `services`, `hosts`, `runtime`, `rpc`, and `fs` are portable runtime bindings: they are available directly in eval and importable from `@workspace/runtime`, with the same semantics in panels and workers. `@workspace/runtime` also exposes `openPanel`/`getPanelHandle`/`panelTree`, `vcs`/`workspace`/`gad`/`credentials`/`git`. Both static `import` and dynamic `await import(...)` work. See `sandbox/EVAL.md` for the full surface.
6. **Close panels you open for temporary work** — keep the one development panel the user is reviewing, but close duplicate, browser, child, and diagnostic panels with `await handle.close()` when done. Start current-owner discovery with bounded `panelTree.roots({ limit })`; use `children()`/`search()` for addressed reads and the advanced `page()` form only with a complete explicit group. Reuse existing panels instead of opening another copy.
7. **Read the capabilities skill before adding authority** — workspace services are resolved from the caller's live semantic context; manifests request but never grant; generated catalogs are not authoring surfaces.
8. **Eval is a notebook kernel** — `scope` retains live objects across cells while
   the EvalDO's 30-minute idle lease is active. Store a working `PanelHandle` or
   `CdpPage` there when a multi-cell workflow benefits from it, and also retain
   stable identity/provenance needed for cold recovery. The durable scope
   snapshot preserves only exact data, never degraded class instances; after an
   explicit `[kernel] Restarted` result, reacquire each named lost handle with
   `getPanelHandle(scope.panelId)` rather than opening a duplicate panel.
9. **Discover accessible names before live UI actions** — read
   [BROWSER.md](BROWSER.md) before using `handle.cdp.page()`. Inspect the intended
   roles and their computed accessible names before clicking or filling; do not
   guess from a visual label or source snippet because descendant badges and
   labels contribute to the name.
10. **Collection actions need item-specific accessible names** — controls
    repeated per row/card/item must include that item's visible identity, for
    example `aria-label={\`Complete ${todo.text}\`}`and`aria-label={\`Delete ${todo.text}\`}`. Repeated identical action names are
an accessibility defect: repair the panel before exercising the flow.
Never use `.first()`, `.last()`, or `.nth()`to guess which repeated control
belongs to an item. Ordinals are acceptable only after`inspect()` proves
    the intended rendered ancestor context.

## Persistence

Choose the right persistence layer for the data shape:

- **Durable Object SQLite** (`this.sql` in a `DurableObjectBase` subclass) —
  the default for live application state that needs transactions, queries, or
  shared access across panels/agents/apps. See
  [WORKERS.md](WORKERS.md#durable-object-backed-app-databases) for the full
  pattern.
- **Version-controlled files in `projects/`** — for editable content that
  benefits from history, diffing, branching, and easy agent access. Freely
  create new repos under `projects/` (e.g. `projects/my-dataset/`,
  `projects/config-store/`). Content there is ordinary workspace source:
  agents can read, edit, and commit it through the VCS surface, and multiple
  users or agents can collaborate on it through normal branch/merge. Use this
  for structured documents, configuration, datasets, templates, or any content
  that humans and agents jointly author.

Do not store meaningful application state only in panel `stateArgs`, eval
`scope`, or ephemeral in-memory structures. If a user closes a panel and
reopens it, or an agent restarts, state that matters should survive.

## Agentic Integration

Workspace apps should be agentically enabled by default. When building a panel,
worker, or app that manages data or exposes actions:

1. **Expose DO methods over RPC** with explicit `@rpc` contracts so agents can
   call them, not just human UIs. Keep methods app-shaped (`addItem`,
   `listItems`, `getStatus`) rather than UI-shaped (`getTableRows`).
2. **Integrate with channels** — if the app has a conversational or
   collaborative surface, wire it into the workspace messaging system using
   `addAgentToChannel` from `@workspace-skills/agents`. Agents should be able
   to participate in the app's workflows.
3. **Publish structured events** that agents can subscribe to and act on.
   Prefer the workspace channel/envelope system over ad-hoc notification
   mechanisms.

The goal is that every meaningful workspace surface is programmable by agents
as a first-class concern, not bolted on after the human UI ships.

## Theme And Layout

All panels and apps must respect the host theme and work on mobile viewports:

1. **Use the passed-down theme** — call `usePanelTheme()` from `@workspace/react`
   to get the live `"dark"` | `"light"` appearance and subscribe to changes.
   For Radix-based panels, `autoMount` wires this automatically through
   `useAppTheme()`. Do not hardcode a color scheme or ignore the host theme.
2. **Mobile-friendly layout** — use responsive CSS (flexbox/grid, relative
   units, `max-width: 100%` on media, vertical stacking at narrow widths).
   Panels render on desktop, tablet, and mobile hosts. Test that the UI is
   usable at small viewports, not just wide screens.

## Quick Start Workflow

When building functionality that needs both a panel and a backing service,
create them together with `createProjects` — one call, one approval prompt:

```ts
eval({
  code: `
  import { createProjects } from "@workspace-skills/workspace-dev";
  import { openPanel } from "@workspace/runtime";

  scope.created = await createProjects([
    { projectType: "worker", name: "task-board-store", title: "Task Board Store" },
    { projectType: "panel", name: "task-board", title: "Task Board" },
  ]);
  scope.createdPanel = await openPanel(scope.created[1].created);
  return {
    created: scope.created,
    observation: await scope.createdPanel.observe(),
    snapshot: await scope.createdPanel.snapshot(),
  };
`,
});
```

Even for a single project, use `createProjects` with a one-element array.

`createProjects` returns an array of results, one per project.
Each result includes
`{ created, files, preflight, publication }`.
For every project type, `created` is the complete canonical repository path
(`panels/name`, `workers/name`, and so on), not a basename. Pass it directly to
APIs that accept a workspace source.
`name` is a stable repository identifier matching `^[a-z][a-z0-9-]*$`. For an
isolated suffix use lowercase base 36, for example
`` `my-app-${Date.now().toString(36)}` ``; a raw ISO timestamp is invalid.
`preflight.ok === true`, `scope === "planned-repository"`, and
`semanticBuildGate === "pending-publication"` prove the mutation-free checks
that are possible before the repository has an exact semantic state: canonical
project type, package identity, executable entry, authority-manifest syntax,
skill instructions, and the module-dependency contract. Compilation and
semantic authority coverage run later against the exact committed candidate in
the protected publication gate. The dependency contract uses the same shared
syntax-aware analyzer as eval import validation and sandbox-renderer linting;
comments, strings, templates, regular expressions, Node built-ins, and
self-imports do not become phantom packages. Value imports in production source
must be in `dependencies` or `peerDependencies`; test-only and type-only imports
may be in `devDependencies` (DefinitelyTyped packages satisfy their matching
type-only module).

A failure is a `ProjectPreflightError`, not a flat compiler string. Eval
preserves `errorData.code === "project_preflight_failed"`,
`stage: "dependency-contract"`, and one issue per package with the exact source
file, specifier, import kind/syntax, line/column, expected manifest field,
observed wrong field, accepted coordinates, and remediation. Repair the
manifest/source named by that packet and rerun the same operation; do not try a
different canonical source merely to escape its contract.

`publication` then names the exact
`committedEventId`, `publishedEventId`, `mainEventId`, `effectId`, and
`appliedAt`. If repository creation and commit succeed but
protected publication fails, the helper throws `ScaffoldPublicationError`.
Eval preserves its structured `errorData`, including
`code: "scaffold_publication_failed"`, `published: false`, the exact committed
event and original push request, the nested typed VCS error, and its command-ID
retry policy. Do not call `createProjects` again. Branch on
`retry.commandIdPolicy`: use `recoverProjectPublication` for an uncertain
external effect or a refusal that only needs a freshly observed main. For
`repair-source-and-recommit`, consume every nested `BuildGateFailed` diagnostic,
repair the already-created repository, rebuild the exact context, commit a new
event, and publish from fresh status. Retrying the rejected commit cannot pass.
`stop-integrity-investigation` is terminal pending investigation.

Eval is not a transaction: if creation publishes and a later statement in the
same cell fails, those repositories still exist. Resume from
`scope.created` and retry only the failed
open/verification phase. Never rerun `createProjects` because
`openPanel`, `snapshot`, or another downstream operation failed.

The same rule applies to `forkPanel`, `forkWorker`, and every mutating helper:
assign its receipt into `scope` before the next awaited operation. A panel
snapshot is a structured document-capture object, not a string; return or
inspect its fields and do not call string methods such as `slice()` on it.

`Project already exists: <path>` is not a recoverable publication failure. It
means the requested repository is outside this creation attempt. Stop or choose
a genuinely new name; never adopt, edit, or publish the existing repository as
if this call had created it.

Edit the generated files with the `edit`/`write` tools — each edit is recorded as
authored intent on the context's exact working head and projected to disk.
Before comparing, committing, updating, moving/copying managed files, or
publishing, read the canonical [Vibestudio VCS skill](../vibestudio-vcs/SKILL.md).
Runtime-managed workers and Durable Objects follow their owning semantic
context by default. Pass `ref: "main"` only when deliberately running protected
main. Panel navigation still needs an explicit context build ref when testing
unpublished panel code.

One context is a complete workspace branch spanning all repositories. A vault,
project, or repository is focus within that branch, never a context. A panel's
context is host-bound; its agents and channels must use that same context, and
`stateArgs` cannot override it. Create a new context only through an explicit
fork/clone/subagent lifecycle operation. Use `panel.switchContext(...)` only to
move the current panel to an already-created branch.

For context-local scratch files under `projects/`, do not scaffold. Write inside
a repo-shaped path such as `projects/tmp-name/note.md`; that repo remains private
to the current context until you intentionally commit the complete local chain
and publish its committed workspace event. `createProjects` is for published
workspace units: it scaffolds coherent units and takes them through the
canonical commit/publication protocol. File-oriented APIs also accept a shorthand such as
`projects/note.md`, canonicalize it to `projects/note/note.md`, and return the
canonical path; use the full form when composing later paths.

`openPanel` returns a host-mediated `PanelHandle` and is part of the portable
runtime surface. It works from eval, panels, workers, and DOs. It returns only
after the exact runtime attempt is application boot-ready and throws a
structured `PanelOperationError` on resolve/build/host/boot failure. It accepts
an explicit `ref`; use plain launch for main/pushed code and pin context-local
code deliberately:

```tsx
import { openPanel } from "@workspace/runtime";
const myApp = await openPanel("panels/my-app");
const local = await openPanel("panels/my-app", {
  contextId: ctx.contextId,
  ref: `ctx:${ctx.contextId}`,
});
const observation = await local.observe();
const snapshot = await local.snapshot();
return { panelId: local.id, observation, snapshot };
```

Use `createPanelSlot(source, options)` when the authoritative result is the
durable panel-tree receipt rather than a ready renderer. It returns promptly,
never focuses, and has no readiness option; call `handle.observe()` later when
live runtime state matters. Slot commit starts server-owned, level-triggered
activation; it is recovered after transient failure or restart independently of
the creator. `openPanel` joins that activation and waits on the exact attempt's
event stream without a fixed deadline. Pass a caller-owned `AbortSignal` when the
workflow supports cancellation and a stable `operationId` when it may retry.

Boot readiness and rendered verification are deliberately distinct. A
successful `openPanel(...)` or `observe()` proves that the selected immutable
attempt reached its application boot handshake; it does **not** prove that the
rendered UI is correct. For every create/fork/open/rebuild task, call
`snapshot()` after the ready observation and return both values from the same
eval. Do not report success from a panel id, `phase: "ready"`, or build key
alone. The snapshot is the provenance-bound rendered evidence that catches
blank, error, stale, and semantically wrong UI.

Returning only a panel id proves tree allocation, not a working application.
For later cells, keep the live handle and stable identity together:
`scope.panelHandle = handle; scope.panelId = handle.id`. Reuse
`scope.panelHandle` while present. Only after `[kernel] Restarted` reports that
key as lost should you reconstruct it with `getPanelHandle(scope.panelId)`.

## Common Tasks

| Task                        | How                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create projects             | `eval` — `import { createProjects } from "@workspace-skills/workspace-dev"` then `return await createProjects([{ projectType, name, title }, ...])`. Create related units (e.g. a DO store + its panel) in one call for one approval prompt. Even for a single project, pass a one-element array. Retain the exact `publication`; recover from `scaffold_publication_failed` data without rerunning creation |
| Fork panel                  | `eval` — `import { forkPanel } from "@workspace-skills/workspace-dev"`; store the `dryRun: true` plan, then assign the applied receipt to `scope.forkedProject` **before** opening `scope.forkedProject.created`. Store the handle too, and return the structured observation and snapshot without string-coercing either. If open/snapshot fails, resume from scope; never fork again.                      |
| Fork worker                 | `eval` — `import { forkWorker } from "@workspace-skills/workspace-dev"` then `forkWorker({ from: "workers/source", name: "new-worker", title, dryRun: true })`; pass `classMap` for multi-class workers                                                                                                                                                                                                      |
| Build app database          | Create a worker DO with `DurableObjectBase` + `this.sql` — include it in the same `createProjects` call as its panel. Declare it as a live service with `authority.principals` and explicit `@rpc` receiver policies, then call it from panels/apps/eval via `workers.resolveService(protocol, objectKey?)` + `rpc.call(...)`. See [WORKERS.md](WORKERS.md#durable-object-backed-app-databases).             |
| Add repo guidance           | Edit or create `<repo>/SKILL.md` next to the code it documents, such as `packages/foo/SKILL.md`; create `skills/<name>` only for cross-repo or reusable skill packages                                                                                                                                                                                                                                       |
| Launch panel                | `eval` — `const handle = await openPanel(source)` for pushed/main code, or `openPanel(source, { contextId: ctx.contextId, ref: \`ctx:${ctx.contextId}\` })`for intentional context-local code; return both`await handle.observe()`and`await handle.snapshot()` before reporting success.                                                                                                                     |
| Inspect panel console       | `eval` — `const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 })`; read `history.errors`, `history.entries`, `history.dropped`, and `history.capacity`. The return value is an object, not an array.                                                                                                                                                                               |
| Launch worker               | `eval` — `rpc.call("main", "runtime.createEntity", [{ kind: "worker", source: "workers/my-worker", key: "my-worker", contextId: ctx.contextId }])`; the owning context is the default code ref. Pass `ref: "main"` only for protected-main code. Retire with `rpc.call("main", "runtime.retireEntity", [{ id }])` using the returned handle's `id`                                                           |
| Read a file                 | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                                                                                                                                                                                                                                                                             |
| Edit a file                 | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                                                                                                                                                                                                                                                                                       |
| Check compiler/build        | `eval` — `return await services.build.getBuildReport("panels/my-app", \`ctx:${ctx.contextId}\`)`; inspect its structured target diagnostics and rerun after repairs.                                                                                                                                                                                                                                         |
| Run tests                   | `eval` — `await extensions.invoke("@workspace-extensions/test-runner", "run", [{ target: "packages/my-lib" }])`                                                                                                                                                                                                                                                                                              |
| Operate workspace VCS       | Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md); retain the exact working head, merge stable-coordinate pages, review intents/composed results, commit the complete chain, then publish                                                                                                                                                                                                                    |
| Move/copy managed files     | Use `vcs.move` or `vcs.copy`; runtime `fs.rename`/`fs.copyFile` and agent `move_file`/`copy_file` route through the same identity-aware adapter                                                                                                                                                                                                                                                              |
| Import an external snapshot | Use `vcs.importSnapshot` with a canonical credential-free source URI, exact source revision, and complete repository/file descriptors; the semantic workspace verifies host-observed CAS descriptors, derives the snapshot digest, and atomically returns the committed event/application/work-unit/repository/snapshot evidence                                                                             |

(`extensions` is a runtime client — the same surface bare, as
`services.extensions`, or imported from `@workspace/runtime`.
`use(name).method(...)` is typed sugar; `extensions.invoke(name, method,
[args])` is the untyped equivalent. Invocation preserves the admitted caller
and execution-session context in panels, workers, and server-side eval.)

The development loop is semantic: author work from the exact working head;
compare with an exact committed source event; merge incoming coordinates in
small local steps; test; commit the complete local application chain; then
publish the clean committed event. Work needing another commit boundary belongs
in another context. See [WORKFLOW.md](WORKFLOW.md) for the development loop and the
[Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) for protocol details.
| Get workspace config | `eval` — `workspace.getInfo()` and inspect its `config` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |

Workspace catalog operations (list/create/delete/select) belong to the human
shell's stable hub session and are not available from workspace eval.

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, bounded `panelTree` reads, `PanelHandle.observe`,
  `rebuild`/`reload`/`close`) are portable across panel, worker, DO, and eval
  contexts; presentation and CDP still require an available host.
- Project scaffolding (`createProjects`), semantic workspace VCS operations,
  typecheck, and test runs work in **headless** sessions via eval + RPC.
- Unit tests run through `@workspace-extensions/test-runner`, not shell commands.

## Provenance And Reloads

VCS state and ordinary builds can address an exact **working state**. Workers
and Durable Objects select `ctx:<contextId>` from their owning context by
default; `ref: "main"` is an explicit pin. Panel launch/navigation keeps its
own ref-capable API and must be pinned when unpublished panel code is intended.
If an edit appears absent at runtime, check provenance before changing the fix:

- Was the runtime launched or navigated with an explicit `ref` for the context
  branch, or was the change pushed to `main` first?
- Does the observed working head contain the expected work unit and exact
  application, rather than merely a projected file?
- Did the build system rebuild that source?
- For a worker or DO, does its recorded owning context match the working head,
  or was it explicitly pinned to `main`/another immutable ref?
- For a panel, did launch/navigation pass `ref: \`ctx:${ctx.contextId}\`` when
  unpublished code was intended?
- Did the already-open panel run `handle.rebuild()` after the edit, and does its
  returned observation name the intended `requestedRef`, `effectiveVersion`,
  and `buildKey`?
- In dogfood mode, did the mirror apply or skip because the host checkout was dirty?

Log the exact event or application state alongside runtime build provenance.
Use `vcs.compare({ view: "changes" })` to plan an update and `inspect`,
`neighbors`, `history`, or `blame` to traverse commands, files, changes, work
units, applications, decisions, events, and trajectories. Paths are views; they
do not define revision identity.

Context-local state may remain ahead of or diverged from `main` after another
context publishes. Call `vcs.status` again and branch on the typed relation.
Do not reconstruct semantic state from filesystem dirtiness or rendered byte
differences. See [contexts and state](../vibestudio-vcs/references/contexts-and-state.md)
and [provenance and blame](../vibestudio-vcs/references/provenance-and-blame.md).

Panel operations already report their exact runtime/build provenance through
`observe()`, lifecycle return values, structured failures, and snapshots. Use
those identities rather than filesystem dirtiness or a renderer-presence guess.
