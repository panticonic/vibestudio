---
name: vibestudio-agent
description: Use when operating a Vibestudio workspace server from the command line with the vibestudio CLI — paired direct sessions can use remote file/VCS and sandboxed eval, while linked-agent sessions are read-only for managed state and participate through channels.
---

# Vibestudio Agent CLI

The `vibestudio` CLI gives a paired direct caller programmatic access to a
Vibestudio workspace server. A linked-agent credential is intentionally narrower:
managed authoring and eval require an exact in-process invocation it does not have.
Everything below assumes the CLI is on PATH (in the repo: `pnpm cli ...`).

The credential proves only the exact live session entity. It does not carry a
context, channel, user, scopes, intent, or authorship claim. The host derives the
current context/channel binding and owner from that session entity on authentication;
intent and authorship remain walkable causal-provenance queries. If the entity is
retired, unbound, or no longer has a live owner, authentication fails rather than
falling back to token metadata.

## Critical rules

- **Pair once, attach once.** Commands need a device credential
  (`vibestudio remote pair`) and most need an attached agent session
  (`vibestudio agent attach`). Sessions are durable server entities; a session
  named `default` is used when `--session NAME` is omitted.
- **Paths are remote.** `fs`/`vcs`/`eval` operate inside the session's
  _context folder on the server_, not the local filesystem. The context is an
  exact semantic projection (e.g. `panels/notes/...`). The public
  `.vibestudio-context.json` file identifies only its protocol, workspace, and
  context; it carries no endpoint or semantic head. The host's private,
  disposable materialization receipt tracks the projected basis. A missing or
  stale projection is repaired before filesystem access from a freshly derived,
  exact replacement command for the current semantic head—not by replaying an
  old effect. Discover the tree with `vibestudio fs ls /`.
- **JSON is automatic when piped.** Results are human text on a TTY and a
  single JSON document when stdout is piped or `--json` is passed. Errors go
  to stderr (`{"error":..., "exitCode":...}` in JSON mode).
- **Exit codes:** `0` ok · `1` operation/RPC error · `2` usage error ·
  `3` auth/connection (not paired, unreachable) · `4` timeout (eval) ·
  `5` stale session (entity retired, or credential targets another server).
- **Discover, don't guess.** `vibestudio agent services` lists every callable
  RPC service live; `vibestudio agent services NAME --json` returns full
  argument schemas. `API.md` is the offline snapshot. The workspace's own
  skill library (subagents, testing, panel dev, …) is exposed as MCP
  resources on the `vibestudio` MCP server in linked sessions — each served
  with an addendum mapping its Pi-agent idioms to your CLI surfaces.
- **VCS is one semantic workspace graph.** Before any source comparison,
  mutation, commit, external import, provenance query, or publication, fetch
  `skills/vibestudio-vcs` from the attached workspace with
  `vibestudio agent skills skills/vibestudio-vcs`. It is the only maintained
  protocol source. A context has one committed event and one working head;
  repositories and paths do not own independent history. Every local mutation
  advances the working head with a command ID, commit consumes the complete
  local chain, and protected publication validates semantic ancestry and
  integration, obtains approval, and atomically advances refs. Builds are
  explicit advisory checks or post-publication projections; failed activation
  retains the previous runnable artifact. See [FILES.md](FILES.md) for CLI transport and
  [BUILDING.md](BUILDING.md) for build/publication boundaries.

## Quick start

```bash
vibestudio remote pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2&ice=all" # once
vibestudio agent attach                  # create/reuse session "default"
vibestudio fs ls /                       # list the session context root
vibestudio agent call workspace.listSkills '[]'
vibestudio eval run -e 'return await services.docs.listServices()'
vibestudio agent detach --rm             # retire session + remove its context
```

## Scope resolution & tier probing

Every `fs`/`vcs`/`eval`/`channel`/`context` command resolves **one context +
one credential** with a fixed precedence — so inside a launched session (or a
`context mirror` directory) you need **zero flags**:

1. `--context <id>` / `--session <name>` explicit flags;
2. `VIBESTUDIO_CONTEXT_ID` env — and if `VIBESTUDIO_AGENT_TOKEN` is also set,
   the raw **agent** credential + `VIBESTUDIO_SERVER_URL` are used (caller kind
   `agent`; no device credential or session file involved);
3. cwd-upward search for `.vibestudio-context.json` (its exact `workspaceId` +
   `contextId`; reach comes from the selected paired device credential);
4. the named default session file (`vibestudio agent attach` bookkeeping).

**Probe your tier** (what's available depends on how you were started). Check
in this order and state what's missing:

- `VIBESTUDIO_AGENT_TOKEN` set ⇒ **linked-agent** tier: read-only `fs`/`vcs`
  orientation plus `channel send/history/roster` and live `channel tail`. Managed
  mutations and `eval` fail closed because this external process has no exact
  in-process tool-invocation edge. Native Edit/Write/Bash changes touch projection
  bytes only and are not semantic work; do not use them. Ask an in-process workspace
  agent to implement through `say`. Supported linked sessions are launched only by
  `vibestudio claude`, which OS-confines the context projection read-only; unmanaged
  plugin/adoption sessions are refused.
- else a `.vibestudio-context.json` binding up-tree ⇒ **paired-CLI (Tier 0)**:
  full `fs`/`vcs`/`eval` and `channel send/history` over the device credential,
  but **no vessel presence, no permission relay, and `channel tail` push only
  works if the device credential can hold a WS connection**. Say so.
- else `vibestudio claude status` / `vibestudio remote status` to confirm a
  bare device pairing with no context — you must pass `--context`/`--session`
  or `cd` into a context/mirror directory first.

## Eval is the full-power surface

`vibestudio eval` runs TypeScript **inside the system** (an EvalDO in workerd),
scoped to your entity's context, with a persistent per-entity REPL scope. Prefer
it over stringing together CLI calls for anything programmatic from paired human/device
sessions. Agent-bound linked sessions are refused because they have no canonical
in-process tool invocation; do not fabricate one. Canonical shapes
(see [EVAL.md](EVAL.md) for bindings/imports):

```bash
# Call any service and return a structured value (JSON when piped):
vibestudio eval run -e 'return await services.docs.listServices()'
# Discover the one canonical VCS surface:
vibestudio eval run -e 'return await help("vcs")'
# CLI-owned eval has no chat binding. Use `vibestudio channel send` when the
# current workflow needs to post to a conversation channel.
```

State survives across invocations within a session, so you can build up
intermediate results and inspect `scope` keys between runs.

## Frontend development: SEE what you build

When you edit panel UI code, do not fly blind — screenshot the running panel
and read its console after every meaningful change:

```bash
vibestudio panel list                          # panel ids + sources + contexts
vibestudio panel screenshot <panelId> --out shot.png
vibestudio panel console <panelId> --errors    # render errors, exceptions
```

Screenshots force-paint hidden/unslotted panels, so the panel does not need to
be visible on anyone's screen (a headless renderer serves it if no desktop
shell holds it). **Scope rule:** you may only automate panels in _your own
context_ — a foreign-context panel is denied with guidance, not prompted. That
is the correct loop anyway: your code edits only render in _your_ context's
build, so open your own preview instance and iterate on it:

```bash
# Open a preview of the panel you are editing, in YOUR context, on YOUR build:
vibestudio eval run -e '
  const h = await openPanel("panels/notes", { contextId, ref: "ctx:" + contextId });
  return { panelId: h.id };
'
vibestudio panel screenshot <panelId> --out after-change.png
vibestudio panel console <panelId> --errors
```

Full loop with build preview in [RECIPES.md](RECIPES.md).

## Subagents (linked sessions)

Two directions, both one-way:

- **If you ARE a subagent** (a workspace agent spawned you): your MCP server
  instructions say so explicitly and carry your operating contract. Linked
  subagents are currently reviewers/orienters, not managed-source implementers:
  inspect the exact context, `say` findings or an implementation request to the
  parent, and finish exactly once by calling the `complete` MCP tool. A normal
  final message does not end the run.
- **You cannot spawn subagents from a linked session.** `spawn_subagent` is a
  workspace-side vessel tool with no CLI/eval/RPC surface. If work needs
  delegation, `say` it to the workspace agent in your conversation — it can
  spawn children (including other Claude Code sessions) and supervise them.

## Command groups

| Group                | Commands                                                                                                              | Purpose                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibestudio remote`  | `pair`, `invite-user`, `pair-device`, `add-member`, `remove-member`, `list-users`, `list-devices`, `revoke-device`, `status`, `workspaces`, `select`, `terminal`, `host`, `logout`, `deploy`, `doctor`, `repair-identity`, `serve` | Stable-hub pairing, account/workspace/device administration, and remote clients |
| `vibestudio agent`   | `attach`, `status`, `detach`, `sessions`, `call`, `services`, `skills`, `logs`, `skill`                               | Sessions, raw RPC, introspection                                                                                                              |
| `vibestudio fs`      | `ls`, `read`, `write`, `rm`, `mkdir`, `stat`, `grep`, `glob`                                                          | Files in the session context; use VCS move/copy commands for managed identity changes                                                         |
| `vibestudio eval`    | `run`, `repl-reset`                                                                                                   | Sandboxed TS/JS against the server — **the full-power surface** (see below)                                                                   |
| `vibestudio channel` | `list`, `history`, `send`, `tail`, `roster`                                                                           | Conversation channels: read/post messages, follow live, inspect the roster                                                                    |
| `vibestudio context` | `mirror`                                                                                                              | Export a context snapshot into a local directory and write its identity binding                                                               |
| `vibestudio vcs`     | `status`, `compare`, `integrate`, `revert`, `history`, `blame`, `commit`, `discard`, `move-file`, `copy-file`, `push` | Event/application semantic VCS; read the canonical workspace `skills/vibestudio-vcs` package before use                                       |
| `vibestudio panel`   | `list`, `screenshot`, `console`                                                                                       | Look at running UI: enumerate live panels, capture one to an image file, read its console/errors — the frontend-dev feedback loop (see below) |

`--help` works at the group level (`vibestudio fs --help`) and per command
(`vibestudio fs write --help`).

There is no dedicated worker command: the workerd service is not
shell-callable, so create workers (and DOs) via RPC —
`vibestudio agent call runtime.createEntity '[{"kind":"worker","source":"workers/NAME"}]'`
— and retire them with `runtime.retireEntity`. See
[RECIPES.md](RECIPES.md) for a full example.

For workers/DOs, `contextId` selects both runtime state and the default semantic
working state. Omit `ref` to follow that owning context. Pass `ref: "main"`
only when deliberately pinning protected-main code, or another exact selector
when intentionally running a different state. Panels and apps retain their
explicit build-ref semantics.

## Files in this skill

| File                                   | Read when                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [FILES.md](FILES.md)                   | Remote filesystem behavior, explicit managed move/copy, loading the canonical VCS skill, and generic RPC transport |
| [BUILDING.md](BUILDING.md)             | Explicit context builds, semantic publication, post-publication projections, and activation diagnostics            |
| [EVAL.md](EVAL.md)                     | Running code with `vibestudio eval` (bindings, imports, persistent scope)                                          |
| [API.md](API.md)                       | Looking up which RPC services/methods exist (generated reference)                                                  |
| [RECIPES.md](RECIPES.md)               | CLI transport, eval, unit diagnostics, isolated sessions, channels, and frontend observation                       |
| [SYSTEM_TESTING.md](SYSTEM_TESTING.md) | Running exact headless agentic tests, inspecting trajectories, and iterating through the automatic repair loop     |
