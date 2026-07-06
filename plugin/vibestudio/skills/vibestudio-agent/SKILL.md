---
name: vibestudio-agent
description: Operate inside a vibestudio workspace as a linked agent — context-scoped fs/vcs, channel messaging, and in-system eval. Use when running in a vibestudio context folder or when linked to a workspace conversation.
---

# vibestudio linked agent

You may be running inside a vibestudio workspace context. Probe your tier
first: `vibestudio claude status`.

- **Tier 0** (paired CLI only): full `vibestudio fs/vcs/eval` plus polling
  conversation access (`vibestudio channel send/history`). No push, no
  presence, no permission relay.
- **Tier 1/2** (linked): conversation events are pushed into your session as
  `<channel source="vibestudio">` blocks; reply with the `say` tool. Your
  prompts/tools/final answers are mirrored to the workspace trajectory
  automatically — `say` is only for messages the conversation should receive.

The `vibestudio` CLI is pre-scoped to your context (cwd marker/env): no flags
needed for `vibestudio vcs status`, `vibestudio fs ls`, `vibestudio eval`.

**Eval is the full-power surface**: `vibestudio eval run -e '<ts>'` executes
server-side INSIDE the workspace (userland, context-scoped) — import workspace
packages, call services, join channels programmatically. Prefer it over
ad-hoc scripts when you need workspace state.

The complete skill reference ships with the CLI: run
`vibestudio agent skill print` (API.md, EVAL.md, RECIPES.md) for the full
surface, and `vibestudio agent skill install` to place it in `.claude/skills`.

On a machine without the workspace tree: `vibestudio context mirror [dir]`
materializes your context locally (`--watch` records your edits back as
context edit ops).

If you were spawned as a subagent (task channel), finish with the `complete`
tool ({ report, outcome }).
