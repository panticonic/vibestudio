---
description: Pair this machine with a vibestudio workspace server
---

Guide the user through pairing this machine with their vibestudio workspace:

1. Check for an existing pairing: `vibestudio remote status`. If already
   paired, report it and stop.
2. Ask the user for a pairing link. They mint one on a paired device with
   `vibestudio remote invite`, or from the workspace UI (Connections → Invite);
   it looks like `vibestudio://connect?room=…&fp=…&code=…&sig=…&v=2`.
3. Run `vibestudio remote pair "<link>"` with the link they provide.
4. Verify with `vibestudio remote status` and `vibestudio remote workspaces`,
   then suggest `/vibestudio:connect` to link this session to a conversation.
