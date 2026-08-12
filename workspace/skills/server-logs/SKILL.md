---
name: server-logs
description: Query, summarize, or live-follow the workspace server's structured host-process logs, or direct a user to the Server Logs viewer.
---

# Server logs

`serverLog` covers the workspace server process: startup, builds, RPC,
supervision, Git, reconnects, and other host subsystems. For one exact panel,
app, extension, worker, or Durable Object incarnation, use
`runtime.supervision.logs(identity)` instead.

The service is read-only and redacts known secrets at capture time, but callers
still use its normal authority contract. Use live docs for current filters,
fields, bounds, and event schemas.

## Bounded inspection

```ts
const snapshot = await services.serverLog.tail(200);
const warnings = await services.serverLog.query({
  level: "warn",
  sinceSeq: snapshot.latestSeq,
  limit: 100,
});
return { snapshot, warnings };
```

Use `stats()` to discover active subsystem tags before filtering. Compose level,
time, sequence, tag, and text filters instead of fetching the whole buffer.
Responses include a boot identity and latest sequence; reset the cursor when
boot identity changes.

## Live following

For short investigations, prefer repeated bounded queries with `sinceSeq`. A
real live viewer should subscribe to `server-log:append`, establish the watch
before catching up from its last sequence, deduplicate by sequence, and cancel
during teardown. Never leave an unowned background follower.

The `about/server-logs` panel already provides live viewing and is usually
better than dumping raw records into chat.

## Offline and remote logs

Server state keeps structured JSONL logs for post-mortem inspection after
process exit. Desktop supervisors and remote service managers may retain their
own stdout/stderr or journal. Use the remote-access CLI's log command for
deployed servers. Never assume a workspace agent can read host filesystem paths
directly.

Treat the in-memory ring as a current-boot diagnostic surface, not an archive.
Keep queries bounded, preserve boot and sequence coordinates in reports, and
quote only the records needed to explain the incident.
