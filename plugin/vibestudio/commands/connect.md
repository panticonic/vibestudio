---
description: Link this session to a vibestudio workspace conversation
argument-hint: "[channel-id]"
---

Link this Claude Code session to a vibestudio workspace conversation as a peer
agent (requires a restart if the channel connection isn't already loaded —
channels load at session start).

1. Run `vibestudio claude status` and report the current tier.
2. If a channel id was given ($ARGUMENTS), verify it with the user; otherwise
   determine the conversation from the context marker (the status output shows
   it). If there is no context marker and no channel id, explain that they must
   either `cd` into a context folder, run `vibestudio context mirror` on a
   remote machine, or supply an explicit channel id.
3. If the session is already channel-connected (tier 1 or 2), confirm the link
   is live via `vibestudio claude status` and stop.
4. Otherwise instruct the user to restart with the channel active:
   `claude --channels plugin:vibestudio` from inside the context folder (add
   `--channel <id>` semantics by exporting `VIBESTUDIO_CHANNEL_ID=<id>` or
   passing `--channel` where supported). The first adoption prompts a
   workspace-side approval — tell the user to approve it in the workspace UI.
