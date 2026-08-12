---
name: server-logs
description: Query, summarize, or live-follow the workspace server's structured host-process logs through serverLog, or direct a user to the Server Logs viewer.
---

# Server logs

`serverLog` covers the workspace server process: startup, builds, RPC,
supervision, Git, reconnects, and other host subsystems. Use
`runtime.supervision.logs(identity)` instead for one exact panel, app,
extension, worker, or Durable Object incarnation.

The service is read-only and redacts known secrets at capture time, but callers
still use its normal authority contract. Use live docs for current filters,
record fields, bounds, and event schemas.

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

Use `stats()` to discover active subsystem tags before filtering by exact tag.
Compose level, time, sequence, tag, and text filters instead of fetching the
whole buffer. Responses include a boot identity and latest sequence; reset the
cursor when the boot identity changes.

## Live following

For a short agent investigation, prefer repeated bounded queries with
`sinceSeq`. A real live viewer should subscribe to the documented
`server-log:append` event, establish the watch before catching up from its last
sequence, deduplicate by sequence, and cancel the event response during
teardown. Never leave an unowned background follower.

The human-facing `about/server-logs` panel already provides live viewing and is
usually better than dumping raw records into chat.

## Offline and remote logs

Server state keeps structured JSONL logs for post-mortem inspection after a
process exits. Desktop supervisors and remote service managers may also retain
their own stdout/stderr or journal. Use the remote-access CLI's log command for
a deployed server. Do not assume a workspace agent can read host filesystem
paths directly.

Treat the in-memory ring as a current-boot diagnostic surface, not an archive.
Keep queries bounded, preserve the boot and sequence coordinates in reports,
and quote only the records needed to explain the incident.
