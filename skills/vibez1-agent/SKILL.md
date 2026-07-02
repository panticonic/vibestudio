---
name: vibez1-agent
description: Operate a Vibez1 workspace server from the command line with the vibez1 CLI — durable agent sessions, remote file/VCS access, arbitrary RPC calls, and sandboxed TypeScript eval with a persistent REPL scope. Use when working against a Vibez1 server from a terminal or script — reading/editing workspace context files, committing changes, calling workspace services, or running code on live data.
---

# Vibez1 Agent CLI

The `vibez1` CLI gives an agent full programmatic access to a paired
Vibez1 workspace server. Everything below assumes the CLI is on PATH (in
the repo: `pnpm cli ...`).

## Critical rules

- **Pair once, attach once.** Commands need a device credential
  (`vibez1 remote pair`) and most need an attached agent session
  (`vibez1 agent attach`). Sessions are durable server entities; a session
  named `default` is used when `--session NAME` is omitted.
- **Paths are remote.** `fs`/`vcs`/`eval` operate inside the session's
  *context folder on the server*, not the local filesystem. The context is a
  copy-on-write checkout of the workspace tree (e.g. `panels/notes/...`).
- **JSON is automatic when piped.** Results are human text on a TTY and a
  single JSON document when stdout is piped or `--json` is passed. Errors go
  to stderr (`{"error":..., "exitCode":...}` in JSON mode).
- **Exit codes:** `0` ok · `1` operation/RPC error · `2` usage error ·
  `3` auth/connection (not paired, unreachable) · `4` timeout (eval) ·
  `5` stale session (entity retired, or credential targets another server).
- **Discover, don't guess.** `vibez1 agent services` lists every callable
  RPC service live; `vibez1 agent services NAME --json` returns full
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
  3. **`vcs.push`** is the **only** way to advance `main`, and it is
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
vibez1 remote pair "vibez1://connect?url=...&code=..."   # once per machine
vibez1 agent attach                  # create/reuse session "default"
vibez1 fs ls /                       # list the session context root
vibez1 agent call workspace.listSkills '[]'
vibez1 eval run -e 'return await services.docs.listServices()'
vibez1 agent detach --rm             # retire session + remove its context
```

## Command groups

| Group | Commands | Purpose |
|-------|----------|---------|
| `vibez1 remote` | `pair`, `status`, `invite`, `logout`, `discover`, `start`, `serve` | Device pairing and credentials |
| `vibez1 agent` | `attach`, `status`, `detach`, `sessions`, `call`, `services`, `skills`, `logs`, `skill` | Sessions, raw RPC, introspection |
| `vibez1 fs` | `ls`, `read`, `write`, `rm`, `mv`, `cp`, `mkdir`, `stat`, `grep`, `glob` | Files in the session context |
| `vibez1 vcs` | `push`, `push-status`, `status`, `diff`, `log`, `fork-repo` | Per-repo, build-gated VCS (push). `vcs.edit`/`vcs.commit`/`vcs.merge` are RPCs — see below |
| `vibez1 eval` | `run`, `repl-reset` | Sandboxed TS/JS against the server |

`--help` works at the group level (`vibez1 fs --help`) and per command
(`vibez1 fs write --help`).

There is no dedicated worker command: the workerd service is not
shell-callable, so create workers (and DOs) via RPC —
`vibez1 agent call runtime.createEntity '[{"kind":"worker","source":"workers/NAME"}]'`
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
| [EVAL.md](EVAL.md) | Running code with `vibez1 eval` (bindings, imports, persistent scope) |
| [API.md](API.md) | Looking up which RPC services/methods exist (generated reference) |
| [RECIPES.md](RECIPES.md) | End-to-end workflows (edit→push→fix loop, data analysis, debugging units) |
