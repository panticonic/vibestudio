---
name: sandbox
description: Run server-side eval code or build chat-panel interactions with inline UI, action bars, custom messages, feedback, browser automation, and portable runtime APIs.
---

# Sandbox execution

`eval` runs server-side in the caller's per-agent EvalDO. Inline UI, action
bars, and feedback components render in a connected chat panel.

## Read by task

| Task | Reference |
| --- | --- |
| Eval, imports, timeouts, cancellation, scope, filesystem | [EVAL.md](EVAL.md) |
| Portable runtime clients and services | [RUNTIME_API.md](RUNTIME_API.md) |
| Persistent chat components | [INLINE_UI.md](INLINE_UI.md) |
| Pinned panel controls | [ACTION_BAR.md](ACTION_BAR.md) |
| Typed custom transcript messages | [CUSTOM_MESSAGES.md](CUSTOM_MESSAGES.md) |
| Ordinary rich chat content | [MDX.md](MDX.md) |
| Blocking user feedback | [FEEDBACK.md](FEEDBACK.md) |
| Chat and channel operations | [CHAT_API.md](CHAT_API.md) |
| Panel/browser CDP automation | [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) |
| Common recipes | [PATTERNS.md](PATTERNS.md) |
| Choosing an interaction surface | [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) |

Use `help()` inside eval for the exact injected/importable runtime surface and
`help("<binding>")` for its callable methods. Use `docs_search` and `docs_open`
as agent tools for live service schemas; they are not eval functions.

## Choose the execution surface

| Surface | Runs in | Use for |
| --- | --- | --- |
| `eval` | server-side EvalDO | imperative code, services, files, persistent agent scope |
| `inline_ui` | chat panel | persistent interactive content in the transcript |
| `load_action_bar` | chat panel | compact controls pinned above history |
| `feedback_form` / `feedback_custom` | chat panel | a response the agent must await |

Panel-only tools are absent in headless sessions. Return data from eval and ask
through normal conversation when no renderer is connected.

## Eval essentials

`scope`, `scopes`, `db`, `ctx`, `help`, and—when agent-owned—`chat` and `agent`
are ambient eval bindings. Use them directly. Portable clients such as `rpc`,
`services`, `fs`, `workers`, `credentials`, `gad`, and `panelTree` are injected
and also importable from `@workspace/runtime`.

Workspace and platform packages resolve on first use. Raw inline code must
declare npm packages through the eval `imports` map; file-loaded code can infer
them from the nearest `package.json`. Use static relative imports. Consult
[EVAL.md](EVAL.md) rather than maintaining a package table here.

Eval `db` and `scope` belong to the agent's EvalDO. Scope persists serializable
values across reloads but cannot restore functions or live handles. Put shared
application data behind a manifest-declared Durable Object service with narrow
RPC methods; do not treat eval storage as an app database.

`panelTree.self()` identifies the EvalDO runtime, not the visible chat panel.
Resolve visible parents, siblings, or children through bounded panel-tree reads,
then read the target panel's state args when its channel identity is needed.

Account, workspace membership, live presence, channel participants, and runtime
identity answer different questions. Use the specific API described in
[RUNTIME_API.md](RUNTIME_API.md); never infer a verified user from an agent or
runtime entity.

## Component essentials

Inline, action-bar, and feedback source files must default-export a component.
Read the matching reference for its injected props and lifecycle. Component
scope is browser-local and is not eval scope or shared application state.

Use stable inline IDs when rerendering one workflow. Send user-authored follow-up
prompts with `chat.send(...)`; publish custom visual state only through the
typed custom-message APIs. Do not construct raw transcript rows.

Use inline UI when a side effect has meaningful choices, progress, retry, or
failure state. Keep simple status in ordinary chat and use feedback only when
the agent truly needs the returned decision.

## Paths and source

- Tool `path` arguments are context-relative, with no leading slash.
- Runtime filesystem paths are rooted at the semantic context. Prefer
  `panels/chat/package.json` to `/panels/chat/package.json` for clarity.
- Workspace source uses root-relative repository paths such as `packages/`,
  `panels/`, `workers/`, `skills/`, `apps/`, `extensions/`, and `meta/`. Never
  use a host checkout path.
- Use `fs.mktemp` or `fs.mkdtemp` for disposable state and clean it up.

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) before changing managed
source. Build and test the exact working state, commit the complete local
application chain, and publish explicitly.

## Browser and credential safety

Use `handle.cdp.page()` for ordinary browser automation. It returns the
canonical Playwright-style client; do not install a separate Playwright package.
Acquire protocol-level CDP only when needed and close every page/session you
own.

For authenticated HTTP, call the host-mediated credential operation directly.
Resolve or inventory credentials only when credential routing itself is the
question. Never expose credential material or invent authority wildcards. Read
[API integrations](../api-integrations/SKILL.md) for setup and egress rules.

## Completion rules

- Bound eval results; store large reports or handles in scope or files.
- Close temporary panels, CDP clients, workers, and other resources in a
  `finally` path unless the user asked to keep them.
- Let protected operations use their normal authority flow. Do not add
  preflight calls, retries, or alternate transports merely to avoid approval.
- Treat optional missing packages as separate optional probes; do not let one
  failed import obscure otherwise useful results.
