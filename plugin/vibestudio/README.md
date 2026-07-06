# vibestudio Claude Code plugin

Links a Claude Code session to a vibestudio workspace as a **peer channel
agent**: pushed conversation events, `say`/`complete` tools, lifecycle hooks
that mirror the session into the workspace trajectory, and permission relay to
workspace approvals.

## Requirements

- The `vibestudio` CLI on PATH, paired with your workspace
  (`vibestudio remote pair "<invite link>"` — or `/vibestudio:pair`).
- Claude Code ≥ 2.1.81 (channels research preview).

## Install

From a marketplace checkout of this repo:

```sh
claude plugin marketplace add <marketplace-or-repo-ref>
claude plugin install vibestudio
```

Then start sessions with the channel active:

```sh
claude --channels plugin:vibestudio
```

While channels are in research preview, custom marketplaces may additionally
require `--dangerously-load-development-channels`.

## How it connects

At session start the plugin's channel entry spawns
`vibestudio claude channel-host`:

- In a **workspace-launched** terminal (the workspace "Open Claude Code"
  action or `vibestudio claude`), the launch profile env binds it directly.
- Anywhere else it **adopts**: it discovers the context from the cwd-upward
  `.vibestudio-context.json` marker, joins that context's conversation under
  your paired device credential, and asks for a one-time workspace-side
  approval. Outside a context folder it refuses unless an explicit channel is
  given (your local files would diverge from the workspace context tree —
  use `vibestudio context mirror` on remote machines).

## Commands

- `/vibestudio:connect [channel]` — link this session to a conversation.
- `/vibestudio:status` — tier + attachment report.
- `/vibestudio:pair` — guided machine pairing.
