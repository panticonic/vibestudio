---
name: workspace-dev
description: Build and develop NatStack workspace units — project scaffolding, panels, workers, Durable Objects, runtime publishing, and development workflow.
---

# Workspace Development Skill

Documentation for developing NatStack workspace units, including panels, workers,
packages, skills, and extensions.

For trusted workspace apps under `apps/` (`@workspace-apps/*`, Electron shell,
mobile React Native, or terminal targets), use the `appdev` skill instead.

## Files

| Document                               | Content                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)             | Canonical agent workflow: scaffold, open, inspect, edit, rebuild/reload, close                                                    |
| [PANEL_API.md](PANEL_API.md)           | Runtime panel API reference                                                                                                             |
| [WORKERS.md](WORKERS.md)               | Workers & Durable Objects: AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, custom shared-resource approval grants |
| [RPC.md](RPC.md)                       | Typed parent-child contracts                                                                                                            |
| [BROWSER.md](BROWSER.md)               | Browser automation (Playwright/CDP)                                                                                                     |
| [TOOLS.md](TOOLS.md)                   | Agent tools reference                                                                                                                   |
| [create-project.ts](create-project.ts) | Project scaffolding helpers (importable via eval `imports` parameter)                                                           |

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

Edit the generated files with the `edit`/`write` tools — each edit commits to
your context head and projects to disk atomically, so it is build-ready
immediately — then launch.

`openPanel` is a **panel/component-runtime** API (it returns a host-mediated
`PanelHandle`); it does not initialize in server-side eval, so run it from panel
code or an `inline_ui`/`feedback_custom` component:

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
| Launch panel    | `eval` — `const handle = await openPanel(source)` (`openPanel` is importable/ambient in eval; edits are already committed to your head)                                                                |
| Launch worker   | `eval` — use `services.workers.create({ source: "workers/my-worker", contextId: ctx.contextId, ref: \`ctx:${ctx.contextId}\` })` for newly created or context-edited worker code; omit `ref` only when launching the main build |
| Read a file     | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                          |
| Edit a file     | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                                    |
| Check types     | `eval` — `await extensions.use("@workspace-extensions/typecheck-service").checkPanel("panels/my-app")`                                                     |
| Run tests       | `eval` — `await extensions.use("@workspace-extensions/test-runner").run("packages/my-lib")`                                                                |

(`extensions` is a runtime client — the same surface bare, as `services.extensions`, or `import { extensions } from "@workspace/runtime"`. `use(name).method(...)` is typed sugar; `extensions.invoke(name, method, [args])` is the untyped equivalent. Both work everywhere — panel, worker, and server-side eval.)

Edits are edit-first: the `edit`/`write` tools (and `vcs.applyEdits` directly)
apply each change as one atomic GAD transition on your context head and project
it to disk, triggering rebuilds. The edit *is* the commit — there is no separate
commit, staging, or push step.
| Vcs status | `eval` — `await services.vcs.status()` (see TOOLS.md) |
| List workspaces | `eval` — `workspace.list()` |
| Get workspace config | `eval` — `workspace.getConfig()` |
| Create workspace | `eval` — `workspace.create("name", { forkFrom: "default" })` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |
| Switch workspace | `eval` — `workspace.switchTo("name")` |

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `listPanels`, `panel.focusPanel`, handle `rebuildAndReload`/reload/close) require **panel context**.
- Project scaffolding (`createProject`), vcs operations (`vcs.applyEdits`, `vcs.status`, `vcs.publish`), typecheck, and test runs work in **headless** sessions via eval + RPC.
- Unit tests run through `@workspace-extensions/test-runner`, not shell commands.

## Provenance And Reloads

Workspace runtime units are built from the committed context head, which stays
in lockstep with your edits (each edit commits + projects atomically). If an
agent edits a panel, worker, package, or skill and then observes unchanged
runtime behavior, check provenance before changing the fix:

- Was the edit made in the same context the runtime builds from?
- Was the edit applied through `edit`/`write`/`vcs.applyEdits` (not a stray `fs.writeFile` that never landed on the head)?
- Did the build system rebuild that source?
- For workers or DOs created/edited in this context, did the launch pass
  `ref: \`ctx:${ctx.contextId}\``? `contextId` selects runtime storage/state;
  `ref` selects the code build. Without `ref`, worker launches use the main
  build and cannot see a worker scaffold that exists only on your context head.
- Did the already-open panel run `handle.rebuildAndReload()` after the edit?
- In dogfood mode, did the mirror apply or skip because the host checkout was dirty?

For raw runtime `vcs` calls, `vcs.status()` reports a head's unpublished changes
vs `main` (a GAD state-diff, not filesystem dirtiness); do not pass the
workspace root or unit path to it. Use `vcs.resolveHead(head).stateHash` or the
`stateHash` returned by `vcs.applyEdits` when you need hashes for
`vcs.diff(leftStateHash, rightStateHash)`.

Unpublished state is context-local. A running panel's context head can stay
ahead of `main` ("unpublished changes") even after another context published the
same source path. `vcs.status` will not report "dirty" merely because you edited
a file — the edit is already committed to your context head; `dirty` means the
head is ahead of `main`. Check `contextId` when validating editor or vcs status
symptoms.

Planned hardening: expose a runtime build-provenance API that reports source,
context id, git SHA/ref, dirty state, build timestamp, and artifact id for a
panel/worker/skill/package.
