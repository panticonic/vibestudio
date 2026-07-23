Workspace-local operating guide for Vibestudio agents. This section focuses on workspace-specific paths, APIs, and diagnostics.

## Filesystem layout

Your file root IS the workspace root. Top-level directories: `about/`, `apps/`, `extensions/`, `meta/`, `packages/`, `panels/`, `projects/`, `skills/`, `templates/`, `workers/`. Always use paths relative to that root (`skills/sandbox/SKILL.md`, `packages/foo/SKILL.md`, `panels/my-app/index.tsx`) — never prefix them with `workspace/`, `/workspace/`, or an absolute machine path, and don't probe with `process.cwd()` (not available in the sandbox).

## Tool guidance

- **read / ls / grep / find / edit / write** are native file tools over your workspace root — prefer them for reading docs and editing source; use **eval** when you need to run code.
- **Before authoring or consuming a workspace service, read `skills/capabilities/SKILL.md`.** Service declarations and generated API docs are live, context-relative facts; a build or static catalog is never the discovery or approval path.
- **eval** is available for workspace actions — files, databases, APIs, panels, browsers. Use static imports (not dynamic await import()). `chat`, `scope`, `scopes`, and `help` are pre-injected; use them directly and do not import them from `@workspace/runtime`. Import `contextId` from `@workspace/runtime`. Every eval result includes a `[scope]` summary showing current keys.
- Quick patterns: `fs.readFile(path)` / `fs.writeFile(path, data)` for files. `this.sql.exec("SELECT ...")` inside a Durable Object for databases (db is a client — call `.open()` first). Load the **sandbox** skill for the full API reference.
- Workspace source uses one semantic, provenance-aware VCS over the whole workspace. Before any VCS task, read `skills/vibestudio-vcs/SKILL.md`. A context has one committed event and one exact working head; each edit or integration step creates an ordinary local application. In an agent session, use the compact `vcs({ operation: ... })` tool for status, compare, incremental integration, revert, blame, and push; use the dedicated `edit`, `write`, `move_file`, `copy_file`, and `commit` tools for authoring. These tools derive the exact context, expected working head, and command identity from the live invocation—do not pass lower-level service fields to them. Direct runtime clients use the typed `vcs.*` service and must provide those service fields themselves. Run typechecks, tests, or `services.build.getBuildReport(unit, "ctx:<contextId>")` explicitly while work is local; these checks are advisory and do not authorize publication. Commit the complete local application chain; use another context when work needs a separate commit boundary. Push only an already committed event. For managed source, use the explicit move/copy tools or canonical service operations so file identity and copy provenance remain explicit. Do not use shell commands, raw `isomorphic-git`, or manually constructed clients for workspace source edits. For external Git remotes, use `@vibestudio/git` with `credentials.gitHttp()`.
- **Conversation forks and subagents are semantic contexts, not repo forks.** A conversation fork is an alternate chat branch; a subagent is a delegated child agent with a task channel and child context. `spawn_subagent({ mode: "fork" })` can save substantial tokens when the child needs context you already loaded, because the child starts from your current trajectory and the context window cache is shared. Before orchestrating nontrivial delegation, read `packages/agentic-do/SKILL.md` and its subagents reference; it explains `spawn_subagent`, `read_subagent`, `inspect_subagent`, `integrate_subagent`, `close_subagent`, and child-side `complete`.
- Call **set_title** after the first substantive exchange.
- **Tool availability is runtime-dependent.** `inline_ui`, `load_action_bar`, `feedback_form`, and `feedback_custom` are advertised by chat panels and only appear when a panel is connected. In headless contexts (workers, automated harnesses, tests) they will be absent — return data via eval results and ask follow-up questions through normal conversation messages instead. Do not assume a tool exists; rely on what's actually exposed to you.

## Scope

`scope` is a live in-memory object shared across eval calls — store anything (handles, pages, functions, data) and it all works between calls. After every eval, the result includes a `[scope]` line listing current keys. Scope is serialized to DB automatically; on panel reload, data survives but functions and class instances are lost. A system message will list what was restored, partially restored, or lost.

## Workspace skills

Skills have two parts: **documentation** (read via the read tool) and optionally **code exports** (used via JS `import` in eval). Read the docs first — they explain what the skill does and how to use it.

The generated skill index shows each skill's repo path. Read docs with the shown path, for example `read("skills/sandbox/SKILL.md")` for a reusable workflow skill or `read("packages/foo/SKILL.md")` for a skill embedded in the package it documents.

When authoring or moving skills, keep repo-specific guidance with the code it describes: put a top-level `SKILL.md` in `packages/<name>`, `workers/<name>`, `apps/<name>`, `panels/<name>`, `extensions/<name>`, `projects/<name>`, `about/<name>`, or `meta`. Use `skills/<name>` only for cross-repo workflows or skills that are themselves reusable code packages. Keep the built-in onboarding skill in `skills/onboarding` because it describes the whole workspace.

Some skills also export code you can use in eval. Workspace packages (`@workspace-skills/*`, `@workspace/*`, `@vibestudio/*`) are **auto-resolved** — just write the `import` and they're built on first use:

```
eval({ code: `import { createProject } from "@workspace-skills/workspace-dev"; ...` })
```

npm packages require the `imports` parameter: `imports: { "lodash": "npm:4" }`

Before using eval, read the **sandbox** skill — it has the complete API reference.

- **sandbox** — **read this first** — eval patterns, complete runtime API reference, inline_ui, feedback forms, browser automation
- **architecture** — the theory of the whole system: trust boundary, unit kinds, log-first storage, semantic workspace state, permissions/credentials (`skills/architecture/SKILL.md`) — load before designing anything cross-cutting
- **capabilities** — explicit authority requests, live caller-context service discovery, dynamic intra-workspace protocols, host grants, userland approvals, and content-integrity rules (`skills/capabilities/SKILL.md`)
- **vibestudio-vcs** — canonical semantic VCS protocol: committed events and exact working heads, comparison and integration, whole-chain commits, move/copy identity, counteractions, provenance, typed recovery (`skills/vibestudio-vcs/SKILL.md`)
- **workspace-dev** — building panels, workers, Durable Objects; exports `createProject`, `forkProject`
- **browser-import** — importing cookies, passwords, bookmarks, history from installed browsers
- **api-integrations** — connecting to OAuth APIs (Gmail, GitHub, Slack, Notion, Linear)
- **agentic-do** — changing the host chat agent's model/provider defaults and live effort, approval, chattiness, or subagent behavior
- **onboarding** — first-time setup, workspace configuration, Vibestudio overview (`skills/onboarding/SKILL.md`)
- **system-testing** — headless test runner; exports `HeadlessRunner`, `TestRunner`, test suites
- **web-research** — searching the open web and reading pages with `web_search`, `web_fetch`, `web_read`

## Diagnostics — explicit checks and runtime projections

**Builds are explicit advisory checks, not publication gates.** Before committing or publishing, run the smallest relevant typecheck, test, or build against the exact context working head. `services.build.getBuildReport(unit, "ctx:<contextId>")` returns structured diagnostics with source, severity, file, line, column, message, and optional source context. A build report creates no semantic event, grants no approval, and advances no pointer. Fix the cited source through an ordinary working application, then rerun the check.

When publication reports that current `main` is not reachable, do not invoke a file-oriented shortcut. Resolve current main and the context's exact committed event, compare them, account for every actionable change through adopt/reconcile/decline, then commit those local decisions. The semantic commit derives its integration parent from the incorporated work. Retry the push from the returned committed event. Follow the typed result discriminant; never parse explanatory prose. See `skills/vibestudio-vcs/references/semantic-commit.md` and `skills/vibestudio-vcs/references/typed-recovery.md`.

After publication, build and runtime systems consume `main` as derived projections. A projection failure does not roll back semantic publication. Runtime activation fails closed: the failed artifact is not activated, and the previous runnable artifact remains selected while diagnostics explain the new source failure.

## Diagnostics — querying RUNNING unit errors, logs, and build failures

Every workspace unit (panel, worker, DO, extension, app) feeds a per-unit diagnostics store. When a post-publication projection or running unit fails — a build cannot be produced, a worker will not start, or a panel renderer crashes — query it here instead of guessing:

```js
import { workspace } from "@workspace/runtime";

// One-stop health check: unit status + lastError, error ring, log tail,
// and recent build events (build-error entries carry the esbuild message).
const diag = await workspace.units.diagnostics("workers/my-worker");
// → { unit: { status, lastError, ... }, errors: [...], logs: [...], builds: [...] }

// Just the log tail (level: "debug"|"info"|"warn"|"error", since: epoch ms):
const logs = await workspace.units.logs("panels/my-panel", { level: "warn", limit: 50 });

// All units with status at a glance (status "error" + lastError for failed workers):
const units = await workspace.units.list();
```

Accepts either the package name or the workspace-relative source path (`workers/foo`, `panels/bar`). What's captured per kind:

- **Workers / DOs** — `console.*` output, plus lifecycle events (started, updated, _failed to start_ with the error message).
- **Panels** — console warnings/errors and lifecycle failures (renderer crash, load failure) forwarded from the shell. Full console history for a _running_ panel is available via the panel CDP host (`consoleHistory` host command).
- **All kinds** — state-triggered build events in `diag.builds`; `diag.builds[].diagnostics` carries structured `{ source, severity, file, line, column, message }` entries rather than an opaque blob.

From a terminal, the same data is available via the external-agent CLI: `vibestudio agent diag UNIT` and `vibestudio agent logs UNIT [--level error]`. For whether context-local source builds, run an explicit build or typecheck against that context. Use diagnostics for post-publication projection and runtime state.

Debugging order: for context-local build/type confidence, run an explicit check and inspect its structured result. After publication, use `units.diagnostics` → `builds` for projection failure → `errors` for activation/runtime failure → `units.logs` for surrounding context. Confirm that a failed activation retained the previous runnable artifact.

## Web tools

You have three tools for reaching the open web:

- `web_search({ query, max_results })` — discovery. Returns ranked `{ title, url, snippet }`. DuckDuckGo by default; auto-upgrades to Tavily, Brave, or Exa when the matching API key is set in the worker env.
- `web_fetch({ url })` — fetches a URL, extracts the main content as markdown, caches the full result in the blobstore (URL-deduped within a session), and returns `{ url, title, digest, size, head }`.
- `web_read({ digest, offset, limit })` — reads a byte range from a previously-fetched page. Use this to drill into a large page without re-fetching it.

Typical flow: `web_search` to find URLs → `web_fetch` on the most promising one → if the head doesn't answer the question, `web_read` further into the cached content. Always cite source URLs.

For grepping a cached page, targeted searches (GitHub / npm / Stack Overflow), PDF handling, or aux-model summarization, **read the `web-research` skill** — those live as eval recipes, not top-level tools.

## Live capability docs

Use `docs_search({ query: "keywords", surface?, limit? })`, then
`docs_open({ id: "<catalog-id>" })`. These tools accept exactly those object
fields: `docs_search` does not take `path`, and `docs_open` does not take
`query`, `surface`, or `limit`. The `workspace` surface is generated from the
exact context-relative provider build and includes its `@rpc` method roster;
do not source-scan a provider or consult a generated product catalog when that
live contract is available.

## Style

Keep workspace-facing answers concise and concrete; prefer diagnostics and exact paths over speculation.
