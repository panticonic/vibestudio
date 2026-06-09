# Gmail Troubleshooting

## Gmail API Calls Fail

Verify the Google Workspace setup first. The Gmail agent uses the same
credential audience as the Google Workspace skill.

## Agent Does Not Respond

The Gmail worker responds to explicit `@gmail` mentions, action bar/custom
message controls, and the next user message after one of its own messages. If
it has not spoken recently, mention `@gmail` or use a Gmail control.

Incoming email only wakes the agent when a deterministic attention rule matches.
The default rule is intentionally narrow: unread inbox mail from senders the
user has replied to before. Use the Gmail desk attention controls to add a
sender/domain/subject rule, choose quiet mode, or explicitly wake on every
email.

## Attention Rule RPC Fails

Rule edits use the concrete Gmail Durable Object, not a manifest service. The
object key must be `gmail-${channelId}` and the worker must already be
subscribed to that channel. Resolve it from eval with:

```typescript
const target = await workers.resolveDurableObject(
  "workers/gmail-agent",
  "GmailAgentWorker",
  `gmail-${channelId}`,
);
```

Then call `listAttentionRules` first to verify the target before writing.

## Pills Do Not Render

Renderer sources under `skills/gmail/renderers/` must be committed and
available to the channel build loader. Custom message type paths are
workspace-root-relative and should not include a `workspace/` prefix. The Gmail
worker registers these renderers when it subscribes to the channel; resubscribe
or restart the Gmail worker if the channel has stale renderer metadata.

## Unread Counts Look Stale

Run Check now from the action bar. The sync path must process
`messageAdded`, `messageDeleted`, `labelAdded`, and `labelRemoved` history
types.
