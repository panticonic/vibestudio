---
name: workspace-dev
description: Create, develop, verify, and diagnose workspace panels, workers, Durable Objects, packages, external dependency policy, and repo-local skills.
---

# Workspace development

Use [app development](../appdev/SKILL.md) for trusted apps and [extension
development](../extensiondev/SKILL.md) for trusted Node services.

## Read by task

| Task | Reference |
| --- | --- |
| Development loop | [WORKFLOW.md](WORKFLOW.md) |
| External dependencies, overrides, and patches | [DEPENDENCIES.md](DEPENDENCIES.md) |
| Build, inspect, polish a panel | [PANEL_DEBUG_LOOP.md](PANEL_DEBUG_LOOP.md) |
| Panel lifecycle, observation, failure diagnosis, host commands | [PANEL_API.md](PANEL_API.md) |
| Workers, DOs, service-backed data, agent workers | [WORKERS.md](WORKERS.md) |
| Typed parent-child contracts | [RPC.md](RPC.md) |
| CDP/browser automation | [BROWSER.md](BROWSER.md) |
| Agent tool recipes | [TOOLS.md](TOOLS.md) |
| Icons and unit identity | [references/icons.md](references/icons.md) |

Also read [capabilities](../capabilities/SKILL.md) before adding authority,
[performance](../performance/SKILL.md) before changing startup cost, and
[Vibestudio VCS](../vibestudio-vcs/SKILL.md) before managed-source operations.

## Diagnose panel loading first

For a preparing, blank, failed, or stuck panel, start at [PANEL_API
diagnostics](PANEL_API.md#diagnostics). Reuse the existing handle, call its
read-only `observe()`, then one bounded `diagnose()` call. That packet owns the
active attempt, phase, failure, host state, console history, and build
provenance.

Escalate only from that evidence: exact-entity supervision, exact source/ref
build report, or server logs when the packet places the failure below the panel
lifecycle. Never rebuild, reload, open a duplicate, enter VCS, or inspect test
sources merely to discover the failing layer. Use performance profiling only
after lifecycle health is established.

## Repo-local skills

Put implementation-specific guidance beside its code as `<repo>/SKILL.md` (e.g.
`packages/foo/SKILL.md`). Use `skills/<name>` only for cross-repository
workflows or reusable skill packages. Keep method rosters, generated schemas,
and volatile constants in live docs or code — a repo-local skill explains
purpose, workflow, ownership, invariants, and diagnostics.

## Core rules

- Use workspace-root-relative paths. Never put host checkout paths in workspace
  source or tool arguments.
- Use structured read/edit/write/move/copy and semantic VCS tools for managed
  files. Use eval for runtime operations, not as a file editor or shell.
- Use `verify` for exact-context build checks and focused tests.
- In eval, use ambient `scope`, `scopes`, `db`, `ctx`, `help`, `chat`, and
  `agent` directly. Portable runtime bindings are also importable from
  `@workspace/runtime`; see [sandbox eval](../sandbox/EVAL.md).
- Retain mutating receipts in `scope` before awaiting a later step — eval is not
  transactional.
- Reuse handles, archive temporary panels, and close temporary pages, workers,
  and diagnostics.
  After an eval-kernel restart, reacquire a lost handle from its retained stable
  ID.
- Give every panel and worker a semantic manifest icon from the [shared
  guide](references/icons.md). Use `@workspace/ui/icons` for controls.
- Inspect accessible roles and names before automation — repeated item controls
  need item-specific accessible names, not ordinal guesswork.
- Respect the host theme and narrow mobile viewports.

## Persistence and programmable surfaces

Use Durable Object SQLite for transactional shared application state. Use
version-controlled files under `projects/` for content benefiting from history,
diffing, and collaboration. Never keep meaningful shared state only in panel
state args, eval scope, or process memory.

Expose application operations as narrow, app-shaped RPC methods with explicit
receiver contracts. Use channels and structured events when collaboration is
part of the product. Keep UI projection methods out of the domain API.

## Scaffold projects

Use `createProjects` for one coherent publication of related units:

```ts
import { createProjects, searchProjectCatalog } from "@workspace-skills/workspace-dev";

const [databaseCatalog, panelCatalog] = await Promise.all([
  searchProjectCatalog({ resource: "icon", query: "database", limit: 5 }),
  searchProjectCatalog({ resource: "icon", query: "panels top left", limit: 5 }),
]);
const databaseIcon = databaseCatalog.entries[0]?.id;
const panelIcon = panelCatalog.entries[0]?.id;
if (!databaseIcon || !panelIcon) throw new Error("Required catalog icons are unavailable");

scope.created = await createProjects([
  { projectType: "worker", name: "task-board-store", title: "Task Board Store", icon: databaseIcon },
  { projectType: "panel", name: "task-board", title: "Task Board", icon: panelIcon },
]);
return scope.created;
```

Pass a one-element array for a single unit. Each result returns the canonical
repository path, created files, preflight evidence, and publication receipt.

If publication fails after creation, follow the structured retry policy and
recover or repair the already-created repository — never call `createProjects`
again. If a later open or snapshot fails, resume from the stored creation
receipt. An existing destination is not part of the attempt; choose a distinct
name or stop.

Use context-local project files when the user wants private scratch content
rather than a published executable unit.

## Open and verify panels

`openPanel(source, options)` waits for the selected runtime attempt's boot
handshake. `createPanelSlot` returns only the durable tree placement. Neither a
slot nor boot readiness proves rendered UI correctness.

For unpublished code, pass the exact context and `ctx:<contextId>` ref. After
open or rebuild, return the observation and a structured snapshot from the same
handle. Keep the handle and stable panel ID together in scope.

Use `PANEL_DEBUG_LOOP.md` for authoring and polish. For host chrome actions,
follow [host commands](PANEL_API.md#host-commands): the panel owns command
meaning and execution; desktop and mobile hosts own presentation and routing.

## Development and runtime provenance

Author from the exact working head, run focused checks, commit the complete
local application chain, and publish explicitly. Work that needs a separate
commit boundary belongs in another context.

Workers and DOs normally follow their owning context. Panels need an explicit
context ref when testing unpublished source. If a change appears absent, inspect
the current VCS relation, requested/effective ref, build key, runtime identity,
and rebuild observation before editing again — never infer revision from
filesystem dirtiness or renderer presence.

Panel lifecycle APIs and semantic checks work in headless eval, but visual
presentation and CDP require an available host. Workspace catalog selection and
creation belong to the human shell's hub session, not workspace eval.
