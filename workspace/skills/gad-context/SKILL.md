---
name: gad-context
description: Query Vibestudio's canonical trajectory model for conversation context, runtime events, channel envelopes, provenance links, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is canonical log-first:

- Agent and channel delivery history lives in `log_events` plus `log_heads`.
- Agent context projections live in `trajectory_messages`,
  `trajectory_message_blocks`, `trajectory_invocations`, `trajectory_approvals`,
  `trajectory_turns`, and usage/checkpoint tables.
- Channel delivery is represented by channel log rows in `log_events`. Published
  trajectory events are joined to transmitted channel messages through the
  channel row's `origin_log_id`, `origin_head`, and `origin_envelope_id` columns;
  do not infer this relationship by matching payload text or timestamps.
- Semantic version-control state is a separate, walkable graph exposed by the
  canonical `vcs` runtime namespace. Use `vcs.status`, `vcs.listFiles`,
  `vcs.compare`, `vcs.inspect`, `vcs.neighbors`, `vcs.history`, and `vcs.blame`; do not recover
  a second worktree/state model from GAD SQL. Read
  [the VCS skill](../vibestudio-vcs/SKILL.md) before semantic VCS work.

Use only the canonical tables above. Older event/session families such as
`trajectory_events`, `trajectory_branches`, `channel_envelopes`,
`trajectory_channel_publications`, `gad_file_mutations`,
`gad_file_observations`, and `gad_file_change_hunks` are not part of this schema.

For live incident work, read [DIAGNOSTICS.md](DIAGNOSTICS.md) first. It explains
the summary-first inspector APIs and current trajectory/channel invariants.

Useful APIs:

- `gad.getTrajectoryBranchHead({ trajectoryId, branchId })`
- `gad.listTrajectoryEvents({ trajectoryId, branchId, cursor, limit })`
- `gad.inspectChannelEnvelopes({ channelId, window, limit, payloadKind })` for normal debugging; it returns compact payload summaries, byte counts, and stored-ref digests.
- `gad.readChannelEnvelopes({ channelId, window, limit, payloadKind })` only when code needs hydrated semantic envelopes. Do not use it for broad exploratory dumps inside an agent turn.
- `gad.inspectPublicationIntegrity({ channelId, branchId })` to distinguish real missing trajectory publication joins from expected channel-origin envelopes.
- `gad.inspectTurnState({ branchId, channelId })` to summarize open turns, nonterminal messages, pending invocations, and duplicate turn-open invariant failures. Failed messages are terminal, not streaming.
- `gad.inspectInvocationState({ branchId, invocationId, transportCallId })` to join projected invocation status with started/terminal trajectory events.
- `gad.inspectChannelRoster({ channelId })` to read projected presence/roster state without raw SQL.
- `gad.inspectAgentHealth({ channelId, branchId })` for a one-call bounded channel health report.
- Both channel reads use one paging contract: `window` is `{ kind: "tail" }`,
  `{ kind: "after", seq }`, or `{ kind: "before", seq }` (tail is the default),
  and the result is `{ items, pageInfo }`. `pageInfo` contains `totalCount`, the
  complete matching `firstSeq`/`lastSeq`, the returned range, and truthful
  `hasMoreBefore`/`hasMoreAfter` flags. `limit` defaults to 50 and is a strict
  per-page maximum of 500; larger reads must follow the returned cursors rather
  than asking for an oversized page. `pageInfo.request` echoes the normalized
  request and `pageInfo.returnedCount` must equal `items.length`. Forward
  continuation pages must preserve the first page's `snapshotLastSeq` as the
  `after` window's `throughSeq`, so paging does not chase a moving live tail.
- `gad.getTrajectoryForEnvelope({ envelopeId })`
- `gad.listPublishedEnvelopesForTrajectory({ trajectoryId, branchId, eventId, turnId, channelId, limit })`
- `gad.inspectStorageDiagnostics({ rowByteLimit, limit })`

During the inspecting agent's own active turn, `inspectAgentHealth().summary.ok`
may be false solely because that turn/invocation is still open; zero durable
issue counters distinguish this expected in-flight state from corruption. The
summary makes that distinction explicit: `durableIntegrityOk: true` plus
`inFlightOnly: true` means that the snapshot found activity but no durable
integrity failure.

When the target is `chat.channelId`, the diagnostic eval is itself the newest
open invocation. Take one snapshot. If it is `inFlightOnly` and the only open
row is the diagnostic call/turn, report it as expected current activity and
stop. Never poll the same channel waiting for that invocation to close: it
cannot close until the eval that is observing it returns, and every repeated
probe creates another invocation. Do not fall through to hydrated history or
raw SQL for this self-observation case.

Current implemented hardening:

- Duplicate `turn.opened` events are rejected at append time and should fail
  projection loudly if corrupt data reaches the log.
- `trajectory_turns.opened_at` is no longer silently overwritten by duplicate
  opens.
- Presence envelopes project into `channel_roster`.
- `gad.query` accepts read-only CTEs and still rejects write CTEs, but it is a
  schema-level escape hatch after bounded inspectors have found the exact table
  or artifact you need.
- Stored values are content-addressed; semantic event, application, work-unit,
  change, and decision identities are validated by the canonical VCS
  graph integrity checker.
- Standard agent workers expose `inspectMethodSuspensions` to join local
  suspension rows with GAD invocation state.
- Oversized method/eval results are capped before durable terminal invocation
  publication and replaced with an omitted-result summary plus blobstore pointer.
- Inspector APIs return summaries and byte counts so agents do not need to dump
  hydrated history into eval results.

Perspective rule: in agent eval, `chat.channelId` is only the current response
channel. For a parent/sibling/other panel, inspect the visible panel tree with
`panelTree`, read the target panel's state args, extract `channelName`/`channelId`,
and run GAD inspectors against that channel. If needed, resolve the channel DO
with `workers.resolveService("vibestudio.channel.v1", channelId)` and call its
read-only `inspectAgent` method for standard agent debug methods.

For first-pass diagnostics from eval, prefer inspectors and let
`inspectAgentHealth` derive the default channel branch:

```ts
const channelId = chat.channelId;
const health = await gad.inspectAgentHealth({ channelId });
console.log({
  channelId: health.channelId,
  branchId: health.branchId,
  summary: health.summary,
  openTurns: health.turnState.rows,
  openOrInconsistentInvocations: health.invocationState.rows,
});
```

Most `inspect*` calls return objects with `summary` and/or `rows`. Channel
inspection and hydrated channel reads deliberately share `{ items, pageInfo }`,
so paging code does not change when switching projections. Keep parentheses
around awaited calls before reading a property:
`(await gad.inspectChannelEnvelopes(input)).items`.

For another visible panel's chat:

```ts
const target = (await panelTree.list()).find((panel) => panel.id === "panel-slot-id");
const args = target ? await target.stateArgs.get<Record<string, unknown>>() : {};
const channelId = String(args.channelName ?? args.channelId ?? "");
const health = await gad.inspectAgentHealth({ channelId, limit: 50 });
```

To enumerate trajectory and channel log heads with SQL instead:

```sql
SELECT h.log_id, h.head, h.log_kind, h.created_at
FROM log_heads h
ORDER BY h.created_at DESC;
```

Do not query `trajectory_branches`; it is not a public table in the current GAD
schema. If you need SQL after an inspector points to a concrete artifact, first
confirm the table exists with a bounded schema read and keep the result small.

```sql
SELECT seq, envelope_id AS event_id, hash AS event_hash, prev_hash,
       payload_kind AS kind, causality_json, appended_at
FROM log_events
WHERE log_id = ? AND head = ?
ORDER BY seq DESC
LIMIT 100;
```

To connect what an agent privately did to what users or other agents actually
received, use `gad.inspectPublicationIntegrity(...)` first; when you need the
raw rows, join channel log rows back to their origin trajectory rows:

```sql
SELECT c.log_id AS channel_id, c.seq AS channel_seq, c.envelope_id,
       t.log_id AS trajectory_id, t.head AS branch_id,
       t.turn_id, t.payload_kind AS kind, t.envelope_id AS event_id
FROM log_events c
JOIN log_heads ch ON ch.log_id = c.log_id
                 AND ch.head = c.head
                 AND ch.log_kind = 'channel'
JOIN log_events t ON t.log_id = c.origin_log_id
                 AND t.head = c.origin_head
                 AND t.envelope_id = c.origin_envelope_id
ORDER BY c.log_id, c.seq;
```

Keep the distinction clear:

- trajectory log rows are private, branchable agentic history.
- channel log rows are transmitted PubSub history.
- the `origin_*` columns make published trajectory events queryable from channel
  rows without making them the same record.

Large values are stored by reference. Do not run broad hydrated reads and return
them from `eval`; use `inspect*` APIs first, then fetch one digest or envelope
only when the exact artifact is needed. `payload_ref_json` is the durable column
name even when the value is inline JSON; there is no `payload_json` column.

Contexts behave like isolated workspace state views. A source edit affects the
running app only after the relevant context commits and the runtime build
reloads that artifact. When a fix appears ignored, inspect VCS status, build
events, and runtime build provenance before assuming the code path is still
broken.

## Reviewing code provenance

Start with the bounded inspector APIs above. For code provenance, switch to the
canonical semantic graph: begin with the exact event/application state or a
typed file, change, work-unit, decision, command, or trajectory root. Use
`vcs.inspect` for one node, `vcs.neighbors` for immediate edges, `vcs.history`
for a chronological projection, and `vcs.blame` for content coordinates. GAD
SQL contains trajectory delivery facts, not a parallel file-history authority.

Do not treat every channel envelope without `origin_*` columns as a publication
bug. User- and channel-origin envelopes are expected to have no trajectory
origin; only rows that publish private trajectory events point back to an origin
log, head, and envelope.

Review posture:

- Prefer fail-loud invariant checks over defensive projection code that hides
  corrupt logs.
- Treat unexpectedly large inline payloads as storage-boundary bugs.
- Treat empty rosters, open turns, nonterminal messages, or mismatched
  invocation reports as system-state issues until the inspector APIs explain
  them. A projected `failed` assistant message is terminal, not streaming.
- When a code fix appears ineffective, verify context VCS state and running
  build provenance before changing the fix.
