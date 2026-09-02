---
name: vibestudio-agent
description: Operate a Vibestudio workspace server with the vibestudio CLI from a paired direct session or a read-only linked-agent session, including remote files, semantic VCS, eval, channels, panels, builds, Git interop, and system tests.
---

# Vibestudio Agent CLI

The CLI addresses a remote workspace server. In the repository, invoke it as
`pnpm cli`; installed distributions use `vibestudio`.

## Establish identity and scope

Pair a device, attach a durable agent session, and discover the remote context:

```bash
vibestudio remote pair "<complete pairing URL>"
vibestudio agent attach
vibestudio fs ls /
```

Run `vibestudio <group> --help` and per-command help for current syntax. Use
`vibestudio agent services` for the live RPC roster and
`vibestudio agent services <name> --json` for schemas. [API.md](API.md) is only
an offline snapshot.

A session credential authenticates one live server entity. The host derives
its current owner, context, and channel binding; the token does not carry
authorship, intent, semantic heads, or arbitrary scopes. Retired or unbound
entities fail authentication.

Commands resolve scope from explicit context/session flags, an authorized
linked-agent environment, a context binding found above the current directory,
or the default attached session. Use status and command help when the selected
scope is unclear; do not guess an identity file or context.

## Caller tiers

- A **paired direct session** can use its authorized remote filesystem, semantic
  VCS, eval, channels, and panels.
- A **linked-agent session** can inspect managed state and participate through
  channels, but cannot author managed source or run eval because an external
  process has no exact in-process tool-invocation edge. Local edits to a mirror
  are not semantic workspace work. Send findings or an implementation request
  to the parent workspace agent.

Read-only status commands identify the active tier and missing prerequisite.
Do not retry a linked-session refusal through raw RPC or local projection
writes.

## Remote paths and output

Filesystem, VCS, eval, and panel commands operate on the selected server
context, not the local checkout. A `.vibestudio-context.json` binding identifies
the workspace/context protocol but is not a semantic-head authority. The server
repairs disposable projections from semantic state.

Use workspace-root-relative paths and discover them with `fs ls`. Managed moves
and copies must use semantic VCS operations so identity and provenance survive.

Output is human-readable on a TTY and JSON when requested or piped. Errors go to
stderr. Use command help for the current exit-code contract rather than copying
it into automation.

## Managed source and Git

Before editing, comparing, merging, committing, reverting, importing, or
publishing managed source, load the attached workspace's canonical skill:

```bash
vibestudio agent skills skills/vibestudio-vcs
```

One context has one committed event and exact working head across repositories.
Commit consumes the complete local application chain; publication validates
ancestry, integration, the exact candidate, and approval.

External Git is an interchange adapter. Load
`extensions/git-bridge/SKILL.md` before configuring or synchronizing a managed
remote. Publish semantic work before exporting it to Git. A Git pull returns an
unpublished semantic candidate that must be compared and integrated through the
normal VCS workflow. Never repair divergence in the server's operational Git
checkout.

See [FILES.md](FILES.md) for remote file/VCS transport and
[BUILDING.md](BUILDING.md) for exact-context builds and activation.

## Eval

`vibestudio eval` runs TypeScript in the selected context's server-side EvalDO
and retains per-session scope. It is the programmable surface for a paired
direct caller:

```bash
vibestudio eval run -e 'return await help("services")'
vibestudio eval run -e 'return await help("vcs")'
```

CLI eval has no chat binding; use `vibestudio channel send` when a workflow must
post to a conversation. Linked-agent sessions cannot run eval. Read
[EVAL.md](EVAL.md) for bindings, imports, cancellation, and persistent scope.

## Notify a connected user

A paired direct session can show a transient notification in shell chrome:

```bash
vibestudio agent call notification.show \
  '[{"type":"info","title":"Build finished","message":"The requested build is ready."}]'
```

The host returns an opaque id derived from the verified caller and fresh
entropy. Callers cannot choose or reuse notification ids; only the creating
runtime may dismiss one. User actions are reported exclusively by an
authenticated shell and are not an agent operation.

Notifications reach only live shell sessions for the caller's verified account.
Acceptance does not prove that a person saw the banner, and the notification is
not durable. Keep normal progress and completion in the conversation; reserve
shell notifications for brief, time-sensitive attention while the user is
connected.

## Observe frontend work

For panel changes, inspect the panel in the same context and build as the source:

```bash
vibestudio panel list
vibestudio panel screenshot <panel-id> --out panel.png
vibestudio panel console <panel-id> --errors
```

Open a context-pinned preview through eval when needed. Scope rules allow panel
automation only where the caller has the required context relationship. One
panel operation can require several independent protections (for example,
developer-tools access plus entry into another existing workspace branch); the
shell presents those together as one decision and lists every protection it
covers. Use [RECIPES.md](RECIPES.md) for the full
edit/build/open/screenshot/console loop.

## Linked subagents

When the MCP instructions identify the process as a linked subagent, inspect the
provided context, report through the supplied channel tool, and finish exactly
once with the MCP completion tool. A normal final message does not terminate
the linked run. Linked sessions cannot spawn workspace subagents; ask the
parent workspace agent to delegate when necessary.

## Further reference

| File                                   | Read for                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| [FILES.md](FILES.md)                   | Remote files, managed moves/copies, skills, RPC transport       |
| [BUILDING.md](BUILDING.md)             | Context builds, publication, projection, activation diagnostics |
| [EVAL.md](EVAL.md)                     | Eval bindings, imports, scope, cancellation                     |
| [API.md](API.md)                       | Generated offline RPC reference                                 |
| [RECIPES.md](RECIPES.md)               | CLI, eval, diagnostics, sessions, channels, panels              |
| [SYSTEM_TESTING.md](SYSTEM_TESTING.md) | Managed system-test repair loop                                 |
