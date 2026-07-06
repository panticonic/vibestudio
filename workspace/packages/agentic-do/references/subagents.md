# Subagents

Use this guide when delegating work to a child agent, inspecting a child
agent's work, merging or cherry-picking work back, or reasoning about
conversation forks versus subagent task channels.

The parent-side tool surface is defined in `src/agent-worker-base.ts`. The run
mechanics and child context orchestration live primarily in `src/agent-vessel.ts`
and `src/subagent-runs.ts`.

## Vocabulary

- Conversation fork: an alternate chat branch. It is user-facing chat lineage,
  not a source repo fork.
- Repo fork: `vcs.forkRepo(fromPath, toPath)`, a source-control operation that
  copies a repo to a new path while preserving history.
- Context fork: the VCS/runtime state copied for an isolated workspace context.
  Subagents use child contexts so their edits are isolated until the parent
  merges or picks them.
- Subagent: a child agent spawned by `spawn_subagent`. It has its own task
  channel transcript and child context. The parent supervises it through the
  `*_subagent` tools.

## When To Spawn

Spawn a subagent when the work is meaningfully separable:

- independent investigation or cross-checking
- parallel workstreams
- isolated edits that may be merged or picked later
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
   `diff`, `log`, or a file path.
7. Decide what to take:
   - `merge_subagent` takes everything from the child context.
   - `pick_from_subagent` takes selected commits or paths.
   - `close_subagent({ discard: true })` records that you intentionally dropped
     the child's work.
8. Close the run once you no longer need the child context.

Example:

```ts
spawn_subagent({
  mode: "fresh",
  label: "API audit",
  task: [
    "Audit the workspace API docs for stale VCS merge examples.",
    "Read relevant skills/docs first.",
    "Use say only for meaningful milestones.",
    "When finished, call complete with a concise report and list uncertainties."
  ].join("\n")
})
```

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

If you are the spawned subagent:

1. Do the assigned task in the child context.
2. Read required skills/docs yourself.
3. Use `say` sparingly for parent-visible progress.
4. Commit child-context edits when the task asks for durable work.
5. Finish exactly once with:

```ts
complete({
  outcome: "success",
  report: "What changed, verification run, uncertainties, and any recommended merge/pick."
})
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
- `inspect_subagent({ runId, query })` reads the child context's workspace
  state. Use `query: "status"`, `"diff"`, `"log"`, or a file path.

Use `read_subagent` for what the child said. Use `inspect_subagent` for what
the child changed.

## Merge, Pick, Or Discard

Before taking child work, inspect it:

```ts
inspect_subagent({ runId, query: "status" })
inspect_subagent({ runId, query: "diff" })
```

Use `merge_subagent` when the whole child branch should come back. It is
commit-gated: parent and child work should be committed first. If it reports a
dirty side, commit deliberately in that context and retry.

Use `pick_from_subagent` when only part of the child work is useful:

```ts
pick_from_subagent({
  runId,
  picks: [{ kind: "paths", paths: ["packages/foo/src/fix.ts"] }]
})
```

After merge or pick, verify in the parent context. Then close the child run
when inspection is no longer needed.

## Failure And Cleanup

- If a child reports failure, read its report and inspect status/diff before
  deciding whether to salvage partial work.
- If the work is not useful, `close_subagent({ runId, discard: true })`.
- If you merged or picked useful work, close the run once the parent has
  verified and no longer needs the child context.
- Do not leave subagents running as background memory. They are task workers,
  not permanent collaborators.
