# Subagents

Use this guide when delegating work to a child agent, inspecting a child
agent's work, integrating committed changes, choosing between the
in-process Pi engine and an external engine (Claude Code), or reasoning about
conversation forks versus subagent task channels.

The parent-side tool surface is defined in `src/agent-worker-base.ts`. The run
mechanics and child context orchestration live primarily in `src/agent-vessel.ts`
and `src/subagent-runs.ts`.

## Vocabulary

- Conversation fork: an alternate chat branch. It is user-facing chat lineage,
  not a source repo fork.
- Context fork: an isolated semantic workspace state. Subagents use child
  contexts so their changes remain isolated until the parent adopts them.
- Subagent: a child agent spawned by `spawn_subagent`. It has its own task
  channel transcript and child context. The parent supervises it through the
  `*_subagent` tools.

## When To Spawn

Spawn a subagent when the work is meaningfully separable:

- independent investigation or cross-checking
- parallel workstreams
- isolated work whose committed changes can be integrated later
- long-running or exploratory work where a separate transcript is useful

Do not spawn for small linear tasks you can do directly in the current turn. A
subagent adds coordination overhead: task design, progress reading, inspection,
and closeout.

## Parent Workflow

1. Create a precise task and short label.
2. Call `spawn_subagent`.
3. Track the returned `runId`.
4. Steer with `send_to_subagent` only when the child needs correction or new
   information.
5. Use `read_subagent` to read the task-channel transcript when you need the
   child's messages directly.
6. Use `inspect_subagent` for child-context files and VCS state: `status`,
   parent-relative `diff`, `log`, or a file path. For an extension-owned child,
   `runtime` returns bounded provider process state and its log tail. Diff and
   history log are paged; follow `nextCursor` only when more detail changes your
   decision.
7. Call `integrate_subagent` to adopt every currently applicable child change.
   Conflicting or blocked changes remain explicit and require focused
   adopt/reconcile/decline decisions through the canonical `vcs` service.
   - `close_subagent({ discard: true })` records that you intentionally dropped
     the child's work.
8. Close the run once you no longer need the child context.

Example:

```ts
spawn_subagent({
  mode: "fresh",
  agentKind: "pi",
  label: "API audit",
  task: [
    "Audit the workspace API docs for stale VCS integration examples.",
    "Read relevant skills/docs first.",
    "Use say only for meaningful milestones.",
    "When finished, call complete with a concise report and list uncertainties.",
  ].join("\n"),
  config: {
    model: "openai-codex:gpt-5.6-luna",
    thinkingLevel: "minimal",
  },
});
```

Pi uses `thinkingLevel`, never the external-launcher field `effort`. The tool
schema exposes both because `config` is shared across engines; choose the field
for the selected `agentKind`. Runtime selection belongs in `config`: writing a
model name in `task` only gives the already-launched child an instruction and
cannot change which model is executing. The spawn result and later inspection
report `launchConfig`, so supervisors can verify the effective selection rather
than inferring it from prose.

## Fresh Versus Fork

- `mode: "fresh"` starts a child with only the task prompt. Prefer this for
  independent research, audits, extraction work, or isolated implementation.
- `mode: "fork"` starts a child from your current trajectory. Prefer this when
  the child needs the conversation context you already built, and repeating
  that context in the task would be expensive or lossy. Forked subagents can
  save a lot on tokens because the child starts from the parent's existing
  trajectory and the context window cache is shared.

When you choose `mode: "fork"`, the child is told that the parent owns the main
line of work and that its job is to focus only on the task you gave it. Make
the task narrow enough that the child does not try to take over the whole
project.

Always include `task`. It should be self-contained enough that the child can
recover after compaction or a tool retry.

The child runtime source is not configurable. A Pi child always inherits the
parent vessel's executable identity; the disposable package or repository being
edited is task context, not runnable agent code. Choose a different reasoning
engine with `agentKind` instead of trying to substitute a source package.

## External Engines (`agentKind`)

`spawn_subagent` defaults to `agentKind: "pi"` — an in-process child of your own
vessel class. Any other value names an extension-owned external launcher
(`@workspace-extensions/<agentKind>`); `"claude-code"` runs a headless Claude
Code session in the child context. Everything about supervision stays the same:
the run gets a task channel and child context, progress is pushed into your
channel, the run card badges the engine, and `send_to_subagent` /
`inspect_subagent` / `integrate_subagent` /
`close_subagent` all work identically. Depth and fan-out gates are shared.

```ts
spawn_subagent({
  mode: "fresh",
  agentKind: "claude-code",
  label: "repo audit",
  task: "Audit packages/foo for stale contracts. Make no edits; complete with exact findings.",
  config: { model: "opus", effort: "high" },
});
```

When to choose which engine:

- **pi** (default): the child shares your loop machinery and model settings;
  `mode: "fork"` gives it your full trajectory with a shared context-window
  cache — the cheap option when the child needs context you already built.
- **claude-code**: the child is a Claude Code session with its own harness,
  skills, and a `vibestudio` CLI pre-scoped to the child context. Its operating
  system view of managed workspace source is deliberately read-only. Choose it
  for independent audits, diagnosis, log inspection, visual review, or a
  second-model opinion. Its native file tools cannot author attributable
  semantic workspace changes; attempted managed-source writes fail with
  `EROFS`. Use a Pi child for edits and integration.

  Claude may write ephemeral artifacts only under
  `$VIBESTUDIO_LINKED_SCRATCH`. For frontend/UI diagnosis,
  `vibestudio panel screenshot` writes a running own-context panel capture
  there; Claude can read that image and pair it with
  `vibestudio panel console --errors`.

  Each launch also receives a disposable writable `CLAUDE_CONFIG_DIR` seeded
  from the host login. Claude can refresh OAuth state and create session-hook
  files without weakening the read-only workspace mount. On release, a changed
  credential is promoted back only if the host credential still matches the
  launch's starting snapshot; concurrent host changes win. All other
  launch-specific config is removed with the materialized profile.

This is a provenance boundary, not a temporary permission-mode limitation.
Native external-process writes do not carry the exact in-process
invocation-to-change causality required by semantic VCS. Do not loosen the
filesystem sandbox to make them work. A future write-capable external engine
must mutate through a causal MCP/CLI gateway that records the authenticated
run, invocation, work unit, and resulting Change.

External-engine specifics:

- **`task` is always required** (both modes) and must be fully self-contained:
  an external child never inherits your conversation trajectory — even with
  `mode: "fork"` it starts from just your task text (plus the child context's
  files). Prefer `mode: "fresh"` and write the task accordingly.
- **`config` maps to the launcher CLI** (whitelisted; unknown keys and
  flag-shaped values are dropped). For claude-code:

  | key              | CLI flag            | values                                                                                                  |
  | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
  | `model`          | `--model`           | alias (`"opus"`, `"sonnet"`, `"haiku"`) or full model name                                              |
  | `effort`         | `--effort`          | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                               |
  | `permissionMode` | `--permission-mode` | `"auto"` (default) \| `"acceptEdits"` \| `"bypassPermissions"` \| `"manual"` \| `"dontAsk"` \| `"plan"` |
  | `fallbackModel`  | `--fallback-model`  | model name                                                                                              |
  | `maxBudgetUsd`   | `--max-budget-usd`  | positive number                                                                                         |

- **Permissions default to `auto`**: your spawn is the authorization, and a
  headless run blocked on interactive prompts would hang. Override
  `permissionMode` only when you deliberately want the child's tool use relayed
  as workspace approvals.
- **The child gets the same task-channel etiquette** as a Pi child (`say`
  sparingly; make one actionable final report), delivered through its session
  instructions. A Pi child settles with the `complete` tool. A supervised
  external print-mode child settles from the launcher's typed terminal result;
  text that merely looks like `complete({...})` has no lifecycle meaning. The
  commit-before-completion rule applies only to an engine with a causal mutation
  path. Claude Code is currently read-only and must report findings without
  claiming edits.
- **Crashes cannot dangle the run**: a successful typed result settles with its
  report; a missing/malformed result, signal, or non-zero exit settles as
  `failed` with process evidence. Treat a failed child like any other — inspect
  status/diff for partial work before discarding.
- Cancellation (`close_subagent`) kills the external process and releases its
  session credential.

## Writing Good Tasks

A good subagent task says:

- goal and expected output
- source files, docs, credentials, or constraints already known
- required skills/docs to read
- allowed and disallowed tools or side effects
- how to report progress
- what counts as done
- what to do if blocked

Avoid vague tasks like "look into this". Use bounded instructions like "inspect
these three files, identify the failing contract, propose or implement a fix,
run this test, and complete with findings plus residual risk."

## Progress And Chattiness

Subagents should keep the task channel quiet by default.

- Use `say` for meaningful milestones: "I found the failing contract", "OCR is
  required", "tests pass", or "blocked on missing credential".
- Do not use `say` for every internal step.
- Ordinary child messages and `say` updates are progress. They are not
  terminal.
- The parent should not assume the run is finished until the child calls
  `complete`.

## Child-Side Rules

If you are the spawned subagent (these rules apply whatever your engine — Pi
children get them as a runtime prompt, external children like Claude Code get
them in their session instructions, with `say`/`complete` as MCP tools and the
`vibestudio` CLI for workspace access):

Managed Claude subagents use `--strict-mcp-config`: only the linked Vibestudio
bridge is loaded. User/project MCP servers are intentionally not inherited
because they would add unreviewed tools, processes, and startup latency outside
the launch contract.

1. Do the assigned task in the child context.
2. Own execution in that context. When the task asks for edits, inspect and
   apply them with your own file tools; do not send the parent a plan or code
   block to copy. Return advice only for an analysis task or a concrete blocker.
3. Read required skills/docs yourself.
4. Use `say` sparingly for parent-visible progress.
5. If your engine has a causal workspace mutation path, run focused
   verification and commit child-context
   edits when the task asks for durable work — the parent integrates your
   committed changes from this context. Do not push `main` yourself; the
   parent owns integration and publication decisions. The current Claude Code
   launcher is read-only: do not attempt or claim managed-source edits.
6. Finish exactly once with:

```ts
complete({
  outcome: "success",
  report: "What changed, verification run, uncertainties, and any integration considerations.",
});
```

Use `outcome: "failed"` when the task cannot be completed. Include the blocking
condition, what you tried, and whether partial work exists.

Do not treat normal final text, idle, or turn closure as completion. Only
`complete` ends the subagent run.

If you are a forked subagent, you inherited the parent's trajectory and the
context window cache is shared. Assume the parent will do the main work. Stay
focused on the particular task the parent assigned; do not broaden the scope or
redo parent work unless it is necessary for that task.

## Reading Versus Inspecting

`read_subagent` and `inspect_subagent` answer different questions:

- `read_subagent({ runId, afterSeq })` reads the task-channel transcript since
  a cursor and returns `nextSeq`. Keep the cursor if you will poll again.
- `inspect_subagent({ runId, query, limit?, cursor? })` reads the child
  context's workspace state. Use `query: "status"`, `"diff"`, `"log"`, or a
  file path. For an external engine, `query: "runtime"` reads its bounded
  provider-owned process state and log tail without leaking a host path. Diff
  compares the child's committed event to the parent's current working state
  and returns at most `limit` change records (20 by default).
  When the child is dirty, `workingCounts` makes the uncommitted remainder
  explicit instead of expanding the whole semantic graph into the transcript.
  Qualify a file with its repository path, such as
  `projects/example/src/index.ts`, whenever the same relative path may exist in
  multiple repositories. An ambiguous run abbreviation or file path returns a
  typed `InvalidReference` refusal with candidate repository paths and performs
  no read; select the exact returned identity and retry.

Use `read_subagent` for what the child said, semantic inspection for what it
changed, and `runtime` to decide whether an external child is still working.
Never close a running external child merely because its task channel is quiet;
suspend the parent and let the completion or exit event wake it.

## Integrate Or Discard

Before taking child work, inspect it:

```ts
inspect_subagent({ runId, query: "status" });
inspect_subagent({ runId, query: "diff" });
```

For read-only external runs, inspect semantic `status` and provider `runtime`,
then close only after completion; there is nothing to integrate. For editing
runs, `integrate_subagent` compares the parent's exact working state with the child's
committed event and adopts each currently applicable child Change as an
ordinary local application. It does not commit the parent, publish `main`,
create marker files, or create a hidden pending-merge state. Parent work and
adopted child work remain one local incremental chain until the parent commits.
Several children may be integrated before that commit; the resulting event
records every child source as an additional semantic parent.

```ts
integrate_subagent({ runId });
```

If the result reports conflicts or dependency blocks, use `vcs.compare` with
the `changes` view and record explicit
`vcs.integrate` adopt/reconcile/decline decisions. Paths are inspection
coordinates, never a substitute for Change identity. Keep the child open while
doing this: its context relationship is what makes unresolved source events
reachable. Call `integrate_subagent` again after the decisions; only a
`working` or `unchanged` result marks the child fully integrated. Verify the
result in the parent context, then close it. `close_subagent` refuses
never-integrated or unresolved work unless `discard:true` explicitly drops it.
These precondition refusals are typed, no-effect lifecycle results:
`IntegrationIncomplete` for unresolved source changes,
`WorkingChangesPresent` for an uncommitted child, and `InvalidReference` when
the parent relationship cannot be recovered. Treat them as instructions to
repair lifecycle state, not as evidence that teardown partially happened.

## Failure And Cleanup

- If a child reports failure, read its report and inspect status/diff before
  deciding whether to salvage partial work.
- If the work is not useful, `close_subagent({ runId, discard: true })`.
- If you integrated useful work, close the run once the parent has
  verified and no longer needs the child context.
- Do not leave subagents running as background memory. They are task workers,
  not permanent collaborators.
