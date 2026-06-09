# Gmail Agent Onboarding

## Detect State

```typescript
import { getGmailAgentSetupStatus } from "@workspace-skills/gmail";

const status = await getGmailAgentSetupStatus();
return status;
```

Stages:

| Stage | Meaning | Next Action |
|-------|---------|-------------|
| `needs-google-workspace` | Google OAuth is missing or unverified | Complete the Google Workspace skill |
| `needs-channel-setup` | Google Workspace is verified, but Gmail is not registered in this workspace | Run `setupGmailAgent({ channelId: chat.channelId })` |
| `ready` | Gmail agent is registered for this workspace | Use the Gmail action bar or `@gmail` |

## Setup

After Google Workspace reports verified, run Gmail setup directly:

```typescript
import { setupGmailAgent } from "@workspace-skills/gmail";

await setupGmailAgent({ channelId: chat.channelId });
```

The setup helper subscribes the Gmail worker and records it for panel reloads.
The Gmail worker then installs its own channel UI: custom message renderers,
the Gmail action bar, and the first-run attention setup turn.

Default incoming-mail attention is conservative: it only starts an agent turn
for unread inbox messages from senders the user has replied to before. During
setup, ask whether the user wants to add or replace that rule with sender,
domain, invoice, scheduling, urgent-mail, attachment, quiet-mode, or wake-all
behavior.

Attention-rule edits should go through the Gmail worker's public DO API. From
eval, resolve the concrete worker with `workers.resolveDurableObject` rather
than registering a userland service in `workspace/meta/natstack.yml`:

```typescript
const target = await workers.resolveDurableObject(
  "workers/gmail-agent",
  "GmailAgentWorker",
  `gmail-${chat.channelId}`,
);
await rpc.call(target.targetId, "upsertAttentionRule", [chat.channelId, {
  rule: {
    id: "customer-domain",
    name: "Customer domain",
    enabled: true,
    scope: "snippet",
    priority: 150,
    match: { any: [{ field: "fromDomain", op: "equals", value: "customer.example" }] },
    actions: ["surface", "summarize"],
  },
}]);
```

## Completion Criteria

- Google Workspace credential is verified.
- The Gmail agent participant is present with handle `gmail`.
- Gmail custom message renderers are registered in the channel by the worker.
- The Gmail action bar is loaded from the worker's channel UI event.
- The user has either accepted the default prior-reply wake rule, installed
  explicit watch rules, chosen quiet mode, or asked for wake-all behavior.
