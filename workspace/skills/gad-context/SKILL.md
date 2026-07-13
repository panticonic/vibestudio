---
name: gad-context
description: Query Vibestudio's canonical trajectory model for conversation context, runtime events, channel envelopes, worktree states, file provenance, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is canonical log-first:

- Agent, channel, and VCS history lives in `log_events` plus `log_heads`; `log_kind`
  on the head distinguishes `trajectory`, `channel`, and `vcs` logs.
- Agent context projections live in `trajectory_messages`,
  `trajectory_message_blocks`, `trajectory_invocations`, `trajectory_approvals`,
  `trajectory_turns`, and usage/checkpoint tables.
- Channel delivery is represented by channel log rows in `log_events`. Published
  trajectory events are joined to transmitted channel messages through the
  channel row's `origin_log_id`, `origin_head`, and `origin_envelope_id` columns;
  do not infer this relationship by matching payload text or timestamps.
- Worktree state lives in `gad_worktree_states`, manifest tables, file versions,
  `gad_state_transitions`, `gad_transition_parents`, `gad_worktree_heads`
  (structured per-`(log_id, head)` state pointers with `commit_event_id`),
  `vcs_context_bases` (durable context base pins), and `gad_worktree_edit_ops`
  (working + committed edit provenance with `actor_id`/`invocation_id`).

Use only the canonical tables above. Older event/session families such as
`trajectory_events`, `trajectory_branches`, `channel_envelopes`,
`trajectory_channel_publications`, `gad_file_mutations`,
`gad_file_observations`, and `gad_file_change_hunks` are not part of this schema.

For live incident work, read [DIAGNOSTICS.md](DIAGNOSTICS.md) first. It explains
the summary-first inspector APIs, current invariants, and context/worktree model.

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
- `gad.listGadBranchFiles({ branchId })`
- `gad.diffGadStates({ leftStateHash, rightStateHash })`
- `gad.readGadFileAtState({ stateHash, path })`
- `gad.getGadStateProducer({ stateHash })`
- `gad.inspectStorageDiagnostics({ rowByteLimit, limit })`

Branch/state lookups are sentinel-based: an unknown branch returns an empty
file list, while missing state files/producers return `null`. During the
inspecting agent's own active turn, `inspectAgentHealth().summary.ok` may be
false solely because that turn/invocation is still open; zero durable issue
counters distinguish this expected in-flight state from corruption. The summary
makes that distinction explicit: `durableIntegrityOk: true` plus
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
- Manifest/state hashes are synchronous SHA-256 over stable JSON.
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

To enumerate logs and their current heads with SQL instead:

```sql
SELECT h.log_id, h.head, h.log_kind, w.state_hash, w.updated_at
FROM log_heads h
LEFT JOIN gad_worktree_heads w ON w.log_id = h.log_id AND w.head = h.head
ORDER BY w.updated_at DESC, h.created_at DESC;
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

Start with the bounded inspector and provenance APIs above. Use raw SQL only
after they identify the exact invocation, state, or envelope that needs deeper
inspection. To connect one tool invocation to its precise file operations:

```sql
SELECT st.event_id, st.invocation_id, st.input_state_hash, st.output_state_hash,
       op.ordinal, op.kind, op.path, op.old_content_hash, op.new_content_hash,
       op.hunks_json
FROM gad_state_transitions st
JOIN gad_worktree_edit_ops op ON op.event_id = st.event_id
WHERE st.invocation_id = ?
ORDER BY st.created_at, op.ordinal;
```

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
