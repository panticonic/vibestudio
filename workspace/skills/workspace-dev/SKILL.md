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
debugging recipes, generated files, ownership notes, or schema-epoch guidance. Put
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

| Document                                 | Content                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)               | Canonical agent workflow: scaffold, open, inspect, edit, rebuild/reload, close                                                                                   |
| [PANEL_API.md](PANEL_API.md)             | Runtime panel API reference                                                                                                                                      |
| [WORKERS.md](WORKERS.md)                 | Workers & Durable Objects: DO-backed app databases, AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, custom shared-resource approval grants |
| [capabilities](../capabilities/SKILL.md) | Explicit requests, dynamic workspace service discovery, host grants, userland approvals, and content provenance                                                  |
| [RPC.md](RPC.md)                         | Typed parent-child contracts                                                                                                                                     |
| [BROWSER.md](BROWSER.md)                 | Browser automation (Playwright/CDP)                                                                                                                              |
| [TOOLS.md](TOOLS.md)                     | Agent tools reference                                                                                                                                            |
| [create-project.ts](create-project.ts)   | Project scaffolding helpers (importable via eval `imports` parameter)                                                                                            |

For host-process debugging while developing workspace units, pair the relevant
unit/panel diagnostics below with the [server-logs](../server-logs/SKILL.md)
skill. `serverLog` captures the workspace server's own logs and supports live
following through `server-log:append` and the `about/server-logs` viewer.

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`.

## Critical Rules

1. **Relative workspace paths only** — use `panels/my-app/index.tsx`, NEVER host absolute paths such as `/home/.../workspace/...`. In runtime `fs.*` calls, `/panels/...` is context-root absolute and accepted, but docs and source-edit examples prefer `panels/...` to avoid ambiguity.
2. **NEVER use Bash** for vcs, file listing, or file creation — use the structured tools
3. **Use filesystem tools for file edits** — Read, Edit, Write (not eval)
4. **Use eval only for runtime operations** — project creation, typecheck, tests, launching panels
5. **Eval injected globals + package imports** — in eval, the **ambient-only** globals `services`, `scope`, `scopes`, `db`, `ctx`, `help`, and (in agent eval) `chat` are injected free variables; do **not** `import` them (the engine rejects it). `rpc` and `fs` are injected ambiently **and** importable from `@workspace/runtime`. `@workspace/runtime` is importable in eval and exposes the same portable surface as panels — including `openPanel`/`listPanels`/`getPanelHandle`/`panelTree`, `vcs`/`workspace`/`gad`/`credentials`/`git`. Both static `import` and dynamic `await import(...)` work. See `sandbox/EVAL.md` for the full surface.
6. **Close panels you open for temporary work** — keep the one development panel the user is reviewing, but close duplicate, browser, child, and diagnostic panels with `await handle.close()` when done. Use `listPanels()` to reuse existing panels instead of opening another copy.
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

## Quick Start Workflow

Create a project via eval with the `imports` parameter:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  return await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
```

Success returns `{ created, files, preflight, publication }`.
`name` is a stable repository identifier matching `^[a-z][a-z0-9-]*$`. For an
isolated suffix use lowercase base 36, for example
`` `my-app-${Date.now().toString(36)}` ``; a raw ISO timestamp is invalid.
`preflight.ok === true` proves that the complete planned repository passed the
same canonical project-type, package identity, executable entry, strict
authority-manifest, skill-instruction, and module-dependency contract used for
forks before the first VCS edit. The dependency contract uses the same shared
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
retry policy. Do not call `createProject` again. Pass the error or its
`errorData` to `recoverProjectPublication`; it verifies the context is clean at
that exact commit and either replays the identical uncertain command or
reobserves main and uses a fresh command after a known refusal.

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
and publish its committed workspace event. `createProject` is for published
workspace units: it scaffolds one coherent unit and takes it through the
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

| Task                        | How                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create project              | `eval` — `import { createProject } from "@workspace-skills/workspace-dev"` then `return await createProject({ projectType, name, title })`; retain its exact `publication`, or recover the committed event from structured `scaffold_publication_failed` data without rerunning creation                                                                             |
| Fork panel                  | `eval` — `import { forkPanel } from "@workspace-skills/workspace-dev"`; return the `dryRun: true` plan, apply the same typed helper with `dryRun: false`, then `const handle = await openPanel(created.created); return { plan, created, observation: await handle.observe(), snapshot: await handle.snapshot() }`. Never claim the fork works from readiness alone. |
| Fork worker                 | `eval` — `import { forkWorker } from "@workspace-skills/workspace-dev"` then `forkWorker({ from: "workers/source", name: "new-worker", title, dryRun: true })`; pass `classMap` for multi-class workers                                                                                                                                                              |
| Build app database          | Create a worker Durable Object with `DurableObjectBase` + `this.sql`, declare it as a manifest service with `policy.allowed`, then call it from panels/apps/eval via `workers.resolveService(protocol, objectKey?)` + `rpc.call(...)`. See [WORKERS.md](WORKERS.md#durable-object-backed-app-databases).                                                             |
| Add repo guidance           | Edit or create `<repo>/SKILL.md` next to the code it documents, such as `packages/foo/SKILL.md`; create `skills/<name>` only for cross-repo or reusable skill packages                                                                                                                                                                                               |
| Launch panel                | `eval` — `const handle = await openPanel(source)` for pushed/main code, or `openPanel(source, { contextId: ctx.contextId, ref: \`ctx:${ctx.contextId}\` })`for intentional context-local code; return both`await handle.observe()`and`await handle.snapshot()` before reporting success.                                                                             |
| Inspect panel console       | `eval` — `const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 })`; read `history.errors`, `history.entries`, `history.dropped`, and `history.capacity`. The return value is an object, not an array.                                                                                                                                       |
| Launch worker               | `eval` — `rpc.call("main", "runtime.createEntity", [{ kind: "worker", source: "workers/my-worker", key: "my-worker", contextId: ctx.contextId }])`; the owning context is the default code ref. Pass `ref: "main"` only for protected-main code. Retire with `rpc.call("main", "runtime.retireEntity", [{ id }])` using the returned handle's `id`                   |
| Read a file                 | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                                                                                                                                                                                                                                     |
| Edit a file                 | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                                                                                                                                                                                                                                               |
| Check compiler/build        | `eval` — `return await services.build.getBuildReport("panels/my-app", \`ctx:${ctx.contextId}\`)`; inspect its structured target diagnostics and rerun after repairs.                                                                                                                                                                                                 |
| Run tests                   | `eval` — `await extensions.invoke("@workspace-extensions/test-runner", "run", [{ target: "packages/my-lib" }])`                                                                                                                                                                                                                                                      |
| Operate workspace VCS       | Read [vibestudio-vcs](../vibestudio-vcs/SKILL.md); retain the exact working head, integrate in local steps, commit the complete chain, then publish                                                                                                                                                                                                                  |
| Move/copy managed files     | Use `vcs.move` or `vcs.copy`; runtime `fs.rename`/`fs.copyFile` and agent `move_file`/`copy_file` route through the same identity-aware adapter                                                                                                                                                                                                                      |
| Import an external snapshot | Use `vcs.importSnapshot` with a canonical credential-free source URI, exact source revision, and complete repository/file descriptors; the semantic workspace verifies host-observed CAS descriptors and derives the snapshot digest                                                                                                                                 |

(`extensions` is a runtime client — the same surface bare, as
`services.extensions`, or imported from `@workspace/runtime`.
`use(name).method(...)` is typed sugar; `extensions.invoke(name, method,
[args])` is the untyped equivalent. Invocation preserves the admitted caller
and execution-session context in panels, workers, and server-side eval.)

The development loop is semantic: author work from the exact working head;
compare with an exact committed source event; integrate incoming changes in
small local steps; test; commit the complete local application chain; then
publish the clean committed event. Work needing another commit boundary belongs
in another context. See [WORKFLOW.md](WORKFLOW.md) for the development loop and the
[Vibestudio VCS skill](../vibestudio-vcs/SKILL.md) for protocol details.
| Get workspace config | `eval` — `workspace.getConfig()` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |

Workspace catalog operations (list/create/delete/select) belong to the human
shell's stable hub session and are not available from workspace eval.

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `listPanels`, `PanelHandle.observe`,
  `rebuild`/`reload`/`close`) are portable across panel, worker, DO, and eval
  contexts; presentation and CDP still require an available host.
- Project scaffolding (`createProject`), semantic workspace VCS operations,
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
