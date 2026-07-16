---
name: server-logs
description: Inspect and live-tail the workspace server's own host logs (every console/dev-log line the server process emits) via the serverLog service — query with filters, aggregate stats, and stream new records over the server-log:append event.
---

# Server logs — inspect and tail the host log stream

The workspace server captures **its own process logs** (startup, builds, git,
RPC, panel runtime, workerd supervision, third-party output — everything that
goes through `console.*`, which includes every `createDevLogger` subsystem)
into a per-boot ring buffer with structured metadata, and exposes it through
the read-only **`serverLog`** service. This is the host-process complement to
per-unit logs (`workspace.units.logs`, which cover _your_ panels/extensions/
workers): use `serverLog` when you need to see what the **server itself** is
doing — why a build failed to schedule, what happened around a crash or
reconnect, when the idle-exit fired, and so on.

Secrets (pairing codes, admin/gateway tokens) are redacted at capture time,
so the surface is safe to read from any caller kind (panel, worker, DO,
agent eval).

## The record shape

```ts
{
  seq: number;        // monotonic per-boot cursor — dedupe/catch-up key
  timestamp: number;  // epoch ms
  level: "verbose" | "info" | "warn" | "error";
  tag?: string;       // subsystem, parsed from the "[Tag]" log prefix (e.g. "Server", "BuildV2", "webrtc-ingress")
  message: string;
  fields?: unknown[]; // structured trailing log args, JSON-safe
  pid: number;
}
```

Every `query`/`tail` response is wrapped in an envelope with process
metadata: `{ records, latestSeq, workspaceId, serverBootId, pid, startedAt }`.
A change of `serverBootId` between calls means the server restarted and all
`seq` cursors reset.

## Reading logs

```ts
// Last 200 records (ascending seq) — the starting snapshot for a tail.
const snap = await services.serverLog.tail(200);

// Filtered query: most recent matches, ascending order.
await services.serverLog.query({ level: "warn", limit: 100 });
await services.serverLog.query({ tag: "BuildV2", contains: "failed" });
await services.serverLog.query({ since: Date.now() - 60_000 });

// Catch up after a gap: everything newer than a cursor you already have.
await services.serverLog.query({ sinceSeq: snap.latestSeq });

// What's in the buffer: counts by level + the live subsystem tag list.
await services.serverLog.stats();
```

Filters compose: `sinceSeq`/`since`/`until` bound the range, `level` is a
minimum (verbose < info < warn < error), `tag` is an exact subsystem match
(discover tags via `stats().byTag`), `contains` is a case-insensitive
substring. `limit` (default 500, max 5000) keeps the **most recent** matches.

## Live tailing (streaming)

New records are pushed as batched **`server-log:append`** events
(`{ records: ServerLogRecord[] }`). The pattern (same as `vcs.subscribeHead`):

```ts
// 1. Listen BEFORE subscribing, keyed by seq to dedupe.
const off = rpc.on("event:server-log:append", (ev) => {
  const { records } = ev.payload as { records: ServerLogRecord[] };
  for (const r of records)
    if (r.seq > lastSeq) {
      lastSeq = r.seq;
      render(r);
    }
});

// 2. Server-side subscription for this connection.
await rpc.call("main", "events.subscribe", ["server-log:append"]);

// 3. Seed/catch up (also after any reconnect):
const snap = await rpc.call("main", "serverLog.query", [{ sinceSeq: lastSeq }]);

// 4. ALWAYS pair with an unsubscribe on teardown:
off();
await rpc.call("main", "events.unsubscribe", ["server-log:append"]);
```

From eval'd agent code, `services.serverLog.*` works for queries; for
streaming prefer polling `query({ sinceSeq })` in a loop — it is cheap
(in-memory) and avoids leaking push subscriptions from short-lived runs.

## Where else these logs live

- `<workspace>/state/logs/server-log.jsonl` — the same structured records,
  appended per boot (rotated once to `.1`); read this for post-mortems of a
  server that already exited.
- Deployed remote boxes use the systemd user unit:
  `vibestudio remote deploy logs <user@host>` or
  `ssh <host> journalctl --user -u vibestudio-server -f`. Pairing, doctor,
  identity, and WebRTC ingress failures should be visible there.

## Good citizenship

- The buffer holds the last ~20k records of the current boot only; don't
  treat it as an archive — use the JSONL file for history.
- Poll with `sinceSeq` cursors instead of re-fetching full tails.
- The **Server Logs** about page (`about/server-logs`) is a ready-made live
  viewer for humans; point users there instead of dumping raw logs at them.
