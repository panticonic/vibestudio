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
debugging recipes, generated files, ownership notes, or migration guidance. Put
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

| Document                               | Content                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)             | Canonical agent workflow: scaffold, open, inspect, edit, rebuild/reload, close                                                    |
| [PANEL_API.md](PANEL_API.md)           | Runtime panel API reference                                                                                                             |
| [WORKERS.md](WORKERS.md)               | Workers & Durable Objects: DO-backed app databases, AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, custom shared-resource approval grants |
| [RPC.md](RPC.md)                       | Typed parent-child contracts                                                                                                            |
| [BROWSER.md](BROWSER.md)               | Browser automation (Playwright/CDP)                                                                                                     |
| [TOOLS.md](TOOLS.md)                   | Agent tools reference                                                                                                                   |
| [create-project.ts](create-project.ts) | Project scaffolding helpers (importable via eval `imports` parameter)                                                           |

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

## Quick Start Workflow

Create a project via eval with the `imports` parameter:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
```

Edit the generated files with the `edit`/`write` tools — each edit is recorded as
an uncommitted working edit on your context head and projected to disk. Runtime
launches do not infer code provenance from that context: no `ref` means the main
build. Use `vcs.previewBuild({ repoPaths })` to check context-local code, and
use an explicit `ref: \`ctx:${ctx.contextId}\`` only on APIs that expose a build
ref. Snapshot milestones with `vcs.commit({ message })`; ship them into `main`
with the build-gated `vcs.push({ repoPaths })`.

For context-local scratch files under `projects/`, do not scaffold. Write inside
a repo-shaped path such as `projects/tmp-name/note.md`; that repo remains private
to the current context until you intentionally `vcs.commit` and `vcs.push` it.
`createProject` is for published workspace units: it scaffolds, commits, and
pushes immediately. File-oriented APIs also accept a shorthand such as
`projects/note.md`, canonicalize it to `projects/note/note.md`, and return the
canonical path; use the full form when composing later paths.

`openPanel` returns a host-mediated `PanelHandle` and is part of the portable
runtime surface. It works from eval, panels, workers, and DOs. It does not expose
a build-ref option; use it for main/pushed code, and use `PanelHandle.navigate`
or another ref-capable host path when you intentionally need a context build:

```tsx
import { openPanel } from "@workspace/runtime";
const myApp = await openPanel("panels/my-app");
```

## Common Tasks

| Task            | How                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create project  | `eval` — `import { createProject } from "@workspace-skills/workspace-dev"` then `createProject({ projectType, name, title })`                             |
| Fork panel      | `eval` — `import { forkProject } from "@workspace-skills/workspace-dev"` then `forkProject({ from: "panels/chat", to: "panels/chat-experiment", title })` |
| Fork worker     | `eval` — run `forkProject({ from, to, title, dryRun: true })` first; pass `classMap` for multi-class workers                                              |
| Build app database | Create a worker Durable Object with `DurableObjectBase` + `this.sql`, declare `authority.principals` on its manifest service and `@rpc({ principals })` on each method, then call it via `workers.resolveService(protocol, objectKey?)` + `rpc.call(...)`. See [WORKERS.md](WORKERS.md#durable-object-backed-app-databases). |
| Add repo guidance | Edit or create `<repo>/SKILL.md` next to the code it documents, such as `packages/foo/SKILL.md`; create `skills/<name>` only for cross-repo or reusable skill packages |
| Launch panel    | `eval` — `const handle = await openPanel(source)` for pushed/main code, or `openPanel(source, { contextId: ctx.contextId, ref: \`ctx:${ctx.contextId}\` })` for intentional context-local code. |
| Launch worker   | `eval` — `rpc.call("main", "runtime.createEntity", [{ kind: "worker", source: "workers/my-worker", key: "my-worker", contextId: ctx.contextId, ref: \`ctx:${ctx.contextId}\` }])` for newly created or context-edited worker code; omit `ref` only when launching the main build. Retire with `rpc.call("main", "runtime.retireEntity", [{ id }])` using the returned handle's `id` |
| Read a file     | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                          |
| Edit a file     | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                                    |
| Check types     | `eval` — `await extensions.use("@workspace-extensions/typecheck-service").checkPanel("panels/my-app")`                                                     |
| Run tests       | `eval` — `await extensions.invoke("@workspace-extensions/test-runner", "run", [{ target: "packages/my-lib" }])`                                           |

(`extensions` is a runtime client — the same surface bare, as `services.extensions`, or `import { extensions } from "@workspace/runtime"`. `use(name).method(...)` is typed sugar; `extensions.invoke(name, method, [args])` is the untyped equivalent. Both work everywhere — panel, worker, and server-side eval.)

The dev loop is **edit → commit → push**: the `edit`/`write` tools (and
`vcs.edit` directly) record each change as an uncommitted working edit on your
context head and project it to disk (no commit, no build). `vcs.commit({ message })`
folds working edits into a deliberate snapshot per repo; the build-gated,
fast-forward-only `vcs.push({ repoPaths })` is the only thing that advances
`main`. Build happens at push (and on demand via `vcs.previewBuild`).
| Commit working edits | `eval` — `await services.vcs.commit({ message: "..." })` |
| Push to main (build-gated) | `eval` — `await services.vcs.push({ repoPaths: ["panels/my-app"] })` |
| Discard uncommitted edits | `eval` — `await services.vcs.discardEdits("panels/my-app")` |
| Vcs status (incl. `uncommitted` count) | `eval` — `await services.vcs.status("panels/my-app")` (see TOOLS.md) |
| List workspaces | `eval` — `workspace.list()` |
| Get workspace config | `eval` — `workspace.getConfig()` |
| Create workspace | `eval` — `workspace.create("name", { forkFrom: "default" })` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |
| Switch workspace | `eval` — `workspace.switchTo("name")` |

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `listPanels`, `panel.focusPanel`, handle `rebuildAndReload`/reload/close) require **panel context**.
- Project scaffolding (`createProject`), per-repo vcs operations (`vcs.edit`, `vcs.commit`, `vcs.status`, build-gated `vcs.push`, `vcs.merge`, `vcs.previewBuild`, `vcs.forkRepo`), typecheck, and test runs work in **headless** sessions via eval + RPC.
- Unit tests run through `@workspace-extensions/test-runner`, not shell commands.

## Provenance And Reloads

VCS and preview builds can build your context's **working content** (committed
head + uncommitted edits), but runtime launches are selected by build ref. If no
`ref` is supplied, panels, workers, and DOs use the main build even when their
`contextId` points at your editing context. If an agent edits a panel, worker,
package, or skill and then observes unchanged runtime behavior, check provenance
before changing the fix:

- Was the runtime launched or navigated with an explicit `ref` for the context
  branch, or was the change pushed to `main` first?
- Was the edit applied through `edit`/`write`/`vcs.edit` (not a stray `fs.writeFile` that never landed on the head)?
- Did the build system rebuild that source?
- For panels, workers, or DOs created/edited in this context, did the launch
  pass `ref: \`ctx:${ctx.contextId}\``? `contextId` selects runtime
  storage/state; `ref` selects the code build. Without `ref`, runtime launches
  use the main build and cannot see a scaffold that exists only on your context
  head.
- Did the already-open panel run `handle.rebuildAndReload()` after the edit, and
  is that panel already pinned to the intended build ref?
- For `projects/vibestudio`, does `devHost.status` name the expected full source-state and execution-input hashes?

For raw runtime `vcs` calls, `vcs.status(repoPath, head?)` reports a repo head's
committed unpushed changes vs that repo's own `main` (a GAD state-diff, not
filesystem dirtiness) plus an `uncommitted` count of working edits not yet
committed; pass a positional repo path (e.g. `panels/my-app`), not the workspace
root. Snapshot working edits with `vcs.commit({ message })`, then ship a repo's
commits into its `main` with the build-gated `vcs.push({ repoPaths: [...] })`. Use
`vcs.resolveHead(head, repoPath).stateHash` or the `stateHash` returned by
`vcs.edit`/`vcs.commit` when you need repo-rooted hashes for
`vcs.diff(leftStateHash, rightStateHash)`. For a pinned `build.getBuild` ref,
convert a repo hash with `vcs.workspaceViewWithRepoAt(repoPath, repoStateHash)`
and pass the returned workspace-rooted `stateHash`.

Unpushed state is context-local. A running panel's per-repo context head can stay
ahead of `main` ("unpushed changes") even after another context pushed the same
source path. `vcs.status`'s `dirty` flag means the committed head is ahead of
`main`; its `uncommitted` count means you have working edits not yet folded into a
commit. Check `contextId` when validating editor or vcs status symptoms.

Planned hardening: expose a runtime build-provenance API that reports source,
context id, git SHA/ref, dirty state, build timestamp, and artifact id for a
panel/worker/skill/package.
