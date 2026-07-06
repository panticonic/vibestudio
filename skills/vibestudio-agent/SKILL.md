---
name: vibestudio-agent
description: Operate a Vibestudio workspace server from the command line with the vibestudio CLI — durable agent sessions, remote file/VCS access, arbitrary RPC calls, and sandboxed TypeScript eval with a persistent REPL scope. Use when working against a Vibestudio server from a terminal or script — reading/editing workspace context files, committing changes, calling workspace services, or running code on live data.
---

# Vibestudio Agent CLI

The `vibestudio` CLI gives an agent full programmatic access to a paired
Vibestudio workspace server. Everything below assumes the CLI is on PATH (in
the repo: `pnpm cli ...`).

## Critical rules

- **Pair once, attach once.** Commands need a device credential
  (`vibestudio remote pair`) and most need an attached agent session
  (`vibestudio agent attach`). Sessions are durable server entities; a session
  named `default` is used when `--session NAME` is omitted.
- **Paths are remote.** `fs`/`vcs`/`eval` operate inside the session's
  *context folder on the server*, not the local filesystem. The context is a
  copy-on-write checkout of the workspace tree (e.g. `panels/notes/...`).
  Context folders are **sparse**: repos materialize on disk on demand, so a
  fresh checkout can look almost empty to local `ls`/glob. Discover the tree
  with `vibestudio fs ls /` (server-side, authoritative); `fs` operations
  materialize the repos they touch.
- **JSON is automatic when piped.** Results are human text on a TTY and a
  single JSON document when stdout is piped or `--json` is passed. Errors go
  to stderr (`{"error":..., "exitCode":...}` in JSON mode).
- **Exit codes:** `0` ok · `1` operation/RPC error · `2` usage error ·
  `3` auth/connection (not paired, unreachable) · `4` timeout (eval) ·
  `5` stale session (entity retired, or credential targets another server).
- **Discover, don't guess.** `vibestudio agent services` lists every callable
  RPC service live; `vibestudio agent services NAME --json` returns full
  argument schemas. `API.md` is the offline snapshot.
- **VCS is per-repo and the loop is edit → commit → push.** Each repo
  (`panels/notes`, `packages/ui`, `projects/vault`, `meta`) versions itself with
  three distinct layers:
  1. **`vcs.edit`** records tracked **WORKING** changes on your context head —
     durable, full provenance, projected to disk — but it is **not** a commit:
     no commit-log entry, no head advance, no build, never in `vcs.log`.
     (`fs write` and the `fs.*` write methods route through `vcs.edit`.)
  2. **`vcs.commit(message)`** folds your uncommitted edits into one deliberate,
     **messaged** snapshot **per repo** (`message` is mandatory; `exclude` holds
     paths back). This is what shows up in `vcs.log`.
  3. **`vibestudio vcs push`** is the **only** way to advance `main`, and it is
     **fast-forward-only** and **build-gated**. It rejects if you still have
     uncommitted edits (commit first). On divergence — `main` moved past your
     base — it does **not** force; it returns a structured `diverged` error
     (`upstreamCommits` + `mergeable` + `conflictPaths`) and you reconcile with
     an explicit `vcs.merge`. A push that returns `build-failed` did **NOT**
     advance `main` — its structured diagnostics (`file:line:col`) are your next
     task. Fix them and re-push; never leave a repo red.
  Builds happen **at push** (use `vcs.previewBuild` for a dev preview without
  committing). The push report is the **primary build signal** — prefer it over
  polling diagnostics after the fact. See [BUILDING.md](BUILDING.md).

## Quick start

```bash
vibestudio remote pair "vibestudio://connect?url=...&code=..."   # once per machine
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
3. cwd-upward search for `.vibestudio-context.json` (its `contextId` +
   `serverUrl`, over the paired device credential);
4. the named default session file (`vibestudio agent attach` bookkeeping).

**Probe your tier** (what's available depends on how you were started). Check
in this order and state what's missing:

- `VIBESTUDIO_AGENT_TOKEN` set ⇒ **linked-agent** tier: full `fs`/`vcs`/`eval`
  auto-scoped, plus `channel send/history/roster` and live `channel tail` (WS
  push). This is a launched or plugin session.
- else a `.vibestudio-context.json` marker up-tree ⇒ **paired-CLI (Tier 0)**:
  full `fs`/`vcs`/`eval` and `channel send/history` over the device credential,
  but **no vessel presence, no permission relay, and `channel tail` push only
  works if the device credential can hold a WS connection**. Say so.
- else `vibestudio claude status` / `vibestudio remote status` to confirm a
  bare device pairing with no context — you must pass `--context`/`--session`
  or `cd` into a context/mirror directory first.

## Eval is the full-power surface

`vibestudio eval` runs TypeScript **inside the system** (an EvalDO in workerd),
scoped to your entity's context, with a persistent per-entity REPL scope. Prefer
it over stringing together CLI calls for anything programmatic. Canonical shapes
(see [EVAL.md](EVAL.md) for bindings/imports):

```bash
# Call any service and return a structured value (JSON when piped):
vibestudio eval run -e 'return await services.docs.listServices()'
# VCS operations against your own context tree:
vibestudio eval run -e 'return await services.vcs.status("panels/notes","ctx:"+contextId)'
# Post to the bound conversation channel from inside the system:
vibestudio eval run -e '
  await chat.send("done - see the diff");
  return { channelId };
'
```

State survives across invocations within a session, so you can build up
intermediate results and inspect `scope` keys between runs.

## Command groups

| Group | Commands | Purpose |
|-------|----------|---------|
| `vibestudio remote` | `pair`, `status`, `invite`, `logout`, `discover`, `start`, `serve` | Device pairing and credentials |
| `vibestudio agent` | `attach`, `status`, `detach`, `sessions`, `call`, `services`, `skills`, `logs`, `skill` | Sessions, raw RPC, introspection |
| `vibestudio fs` | `ls`, `read`, `write`, `rm`, `mv`, `cp`, `mkdir`, `stat`, `grep`, `glob` | Files in the session context |
| `vibestudio vcs` | `push`, `push-status`, `status`, `diff`, `log`, `fork-repo` | Per-repo, build-gated VCS (push). `vcs.edit`/`vcs.commit`/`vcs.merge` are RPCs — see below |
| `vibestudio eval` | `run`, `repl-reset` | Sandboxed TS/JS against the server — **the full-power surface** (see below) |
| `vibestudio channel` | `list`, `history`, `send`, `tail`, `roster` | Conversation channels: read/post messages, follow live, inspect the roster |
| `vibestudio context` | `mirror` | Materialize a context's repos into a local dir (`--watch` writes local edits back as context edit ops) |

`--help` works at the group level (`vibestudio fs --help`) and per command
(`vibestudio fs write --help`).

There is no dedicated worker command: the workerd service is not
shell-callable, so create workers (and DOs) via RPC —
`vibestudio agent call runtime.createEntity '[{"kind":"worker","source":"workers/NAME"}]'`
— and retire them with `runtime.retireEntity`. See
[RECIPES.md](RECIPES.md) for a full example.

For workers/DOs, omitted `ref` means the main build. `contextId` selects runtime
state/files only; if the worker/DO code was created or edited on the current
context branch, pass both `contextId` and an explicit build ref such as
`"ref":"ctx:<contextId>"`.

## Files in this skill

| File | Read when |
|------|-----------|
| [FILES.md](FILES.md) | Doing file or VCS operations (`fs`/`vcs` flags, binary handling, repo paths, the edit→commit→push loop, `vcs.edit`/`vcs.commit`/`vcs.merge`/`vcs.discardEdits`, provenance queries, creating/forking a repo, `VcsPushResult`) |
| [BUILDING.md](BUILDING.md) | A push returned `build-failed` or `diverged`, or you need a dev preview (`vcs.previewBuild`) or to read a package's multi-target report — how the push gate builds, esbuild vs tsc diagnostics, group pushes, first push |
| [EVAL.md](EVAL.md) | Running code with `vibestudio eval` (bindings, imports, persistent scope) |
| [API.md](API.md) | Looking up which RPC services/methods exist (generated reference) |
| [RECIPES.md](RECIPES.md) | End-to-end workflows (edit→push→fix loop, data analysis, debugging units) |
