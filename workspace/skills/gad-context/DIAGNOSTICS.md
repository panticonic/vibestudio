# GAD Diagnostics And Runtime State

Use this guide when an agent, channel, turn, invocation, eval, or worktree state
looks inconsistent. Prefer bounded inspector APIs first. Hydrated history APIs
are for targeted follow-up after you know the exact event, envelope, digest, or
state hash you need.

If the suspected failure is in host orchestration rather than GAD state itself
— server startup/shutdown, projection scheduling, RPC dispatch, workerd
supervision, reconnects, or build/reload events — inspect the workspace server
host logs with `services.serverLog.query(...)` or the `about/server-logs` live
viewer. See `../server-logs/SKILL.md` for querying and live following.

## Perspective First

For agent eval, `chat.channelId` names the channel where the agent is currently
responding. It does not name a parent panel's chat or a sibling panel's chat.
Server-side eval runs in the agent's EvalDO; `panelTree.self()` is that EvalDO,
while `parent`/`getParent()` is the owner agent's nearest visible panel ancestor
when one exists.

When the user asks about a visible panel:

1. Inspect the visible panel tree with `panelTree.list()/roots()/children()`.
2. Pick the target panel from the user's perspective.
3. Read `await target.stateArgs.get()` and extract `channelName` or `channelId`.
4. Run `gad.inspectAgentHealth({ channelId })`, `gad.inspectTurnState({ channelId })`,
   and related inspectors against that target channel.

If the target is ambiguous, render an `inline_ui` panel/channel picker rather
than guessing from the eval runtime's own position.

Do not query raw branch tables such as `trajectory_branches`; that table is not
part of the current public GAD schema. If an inspector points you to a specific
artifact and SQL is still necessary, first discover the current schema with a
bounded read and then query only the exact rows you need.

## Current Diagnostic APIs

### Publication Integrity

Use `gad.inspectPublicationIntegrity({ channelId, branchId })` to validate the
trajectory-to-channel publication invariant.

It distinguishes:

- `expectedMappings`: publications declared by `external.envelope_published`
- `missingMappings`: declared publications without persisted publication joins
- `orphanMappings`: join rows whose event or envelope no longer exists
- `sequenceMismatches`: join rows whose `channel_seq` disagrees with the envelope
- `channelOriginAgenticEnvelopes`: agentic channel envelopes that were not
  trajectory-published; these are usually expected and are not automatically bugs

Do not count every unjoined channel log row as an error. Only
trajectory-published envelopes referenced by `external.envelope_published` must
have join rows.

### Turn State

Use `gad.inspectTurnState({ branchId, channelId })` for stuck typing, open turn,
or streaming assistant-message investigations.

It reports:

- open projected turns
- nonterminal projected messages (`started`/`streaming`; `completed` and
  `failed` are both terminal)
- nonterminal projected invocations
- duplicate `turn.opened` invariant failures

Duplicate `turn.opened` is not a recoverable compatibility case. New appends are
rejected, and projection should fail loudly if a corrupt duplicate reaches the
log.

### Invocation State

Use `gad.inspectInvocationState({ invocationId, transportCallId, branchId })`
when method suspension state, trajectory invocation projection, and channel
terminal events appear to disagree.

It reports the projected invocation row plus counts of started and terminal
trajectory events. This tells you whether you are looking at:

- a transport/suspension issue
- a projection issue
- a real nonterminal invocation
- a terminal event that never reached the projection

Agent DO method suspensions are stored in the agent worker, not GAD. Standard
agent workers expose `inspectMethodSuspensions` as a participant method; it
returns local suspension rows joined with `gad.inspectInvocationState(...)` for
the matching branch, invocation id, and transport call id.

```ts
const joined = await chat.callMethod(
  agentParticipantId,
  "inspectMethodSuspensions",
  {},
  { timeoutMs: 15_000 }
);
```

`chat.callMethod` only works for participants in `chat.channelId`. To inspect a
standard agent debug method for another channel, resolve the channel DO and call
its read-only `inspectAgent` method:

```ts
const channel = await workers.resolveService("vibestudio.channel.v1", targetChannelId);
const debug = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "getDebugState",
]);
const suspensions = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "inspectMethodSuspensions",
]);
```

The channel DO target is an RPC target, not a channel participant. Do not pass
`channel.targetId` to `chat.callMethod(...)`: that API is intentionally scoped
to live participants in `chat.channelId` and will reject the channel DO with a
"not joined to channel" error. Use the direct `rpc.call(...)` form above for a
different channel.

`inspectAgent` is intentionally limited to standard read-only debug methods:
`getDebugState`, `getAgentSettings`, and `inspectMethodSuspensions`.

### Channel Envelope Inspection

Use `gad.inspectChannelEnvelopes({ channelId, window, limit, payloadKind })` for
normal log inspection. It returns:

- compact payload summaries
- per-column byte counts
- stored blob-ref digests and sizes
- sender metadata summaries

Use `gad.readChannelEnvelopes(...)` only after you know you need hydrated
semantic envelopes. Broad hydrated reads can pull large blob refs back into eval
returns and obscure the useful diagnostic data.

Both projections intentionally use the same paging contract:

- Omit `window` or use `{ kind: "tail" }` for the newest page.
- Use `{ kind: "after", seq }` for ascending forward paging.
- The first forward page reports `snapshotLastSeq`; pass it back as
  `{ kind: "after", seq: returnedToSeq, throughSeq: snapshotLastSeq }` on every
  continuation page. This keeps the read on one stable high-water mark while
  newer envelopes remain on the live channel path.
- Use `{ kind: "before", seq }` for the page immediately before a sequence.
- `limit` is the exact requested page size: it defaults to 50, may be zero for
  metadata-only reads, and must not exceed 500. Oversized requests fail instead
  of returning a silently truncated page.
- Both calls return `{ items, pageInfo }`; `pageInfo` includes `totalCount`,
  `firstSeq?`, `lastSeq?`, `snapshotLastSeq?`, `returnedFromSeq?`, `returnedToSeq?`,
  `hasMoreBefore`, and `hasMoreAfter`. It also echoes the normalized
  `{ window, limit, payloadKind? }` under `pageInfo.request` and reports
  `returnedCount`, so callers can verify the page contract directly.
- `payloadKind` filters both items and paging statistics.

Follow `returnedToSeq` plus the original `snapshotLastSeq` with an `after`
window, or `returnedFromSeq` with a `before` window, while the corresponding
`hasMore*` flag is true. A true flag without a returned cursor is an integrity
error, not an instruction to retry the same request.

Use `(await call()).items`, not `await call().items`; JavaScript member access
binds before `await`, so the latter reads `items` from the Promise.

### Storage Diagnostics

Use `gad.inspectStorageDiagnostics({ rowByteLimit, limit })` to find oversized
inline rows or missing blob metadata.

Large payload fields should be encoded as stored refs. If a huge eval/tool result
appears inline in `log_events` or `trajectory_invocations`, treat that as a
storage-boundary bug.

### Channel Roster

Use `gad.inspectChannelRoster({ channelId })` to inspect projected join/update
leave state from presence envelopes without raw SQL. It returns active and
inactive counts plus bounded roster rows.

### Agent Health

Use `gad.inspectAgentHealth({ channelId, branchId })` as the first-pass incident
summary for a channel. It combines:

- publication integrity
- turn state
- invocation state
- roster
- recent channel envelopes
- storage diagnostics

The `summary.ok` flag is false when durable publication, turn, invocation, or
storage invariants need attention.

The more specific fields are the decision boundary:

- `durableIntegrityOk` covers publication, duplicate-turn, and storage
  integrity.
- `activity` is `idle` or `in-flight`.
- `inFlightOnly` is true when activity exists but no durable integrity problem
  was found.

The combined health response contains only compact evidence: problematic/open
turn and invocation rows, active roster rows, a small recent-envelope sample,
and storage issues. Use the dedicated inspector only after that evidence names
the exact artifact needing follow-up.

When an agent calls this inspector during its own active turn,
`summary.openTurns` and `summary.nonterminalInvocations` can make `summary.ok`
false even though publication/storage/hash issue counters are all zero. That is
an expected in-flight observation, not durable corruption. Judge the named
issue counters and the specific turn/invocation rows; do not treat the aggregate
boolean alone as a failure while the inspecting turn is still open.

For that self-observation case, take exactly one health snapshot. If
`summary.inFlightOnly` is true and the only open evidence is the currently
executing diagnostic turn/invocation, stop and report “pending / expected
in-flight.” Do not poll it: the invocation cannot become terminal until the eval
returns, and each poll appends another diagnostic invocation. Do not use raw SQL
or hydrate blobs to re-prove the same fact.

### Branch And State Lookups

The bounded lookup APIs use ordinary not-found sentinels: an unknown branch in
`gad.listGadBranchFiles(...)` returns `[]`; an unknown state/file in
`gad.readGadFileAtState(...)` and an unknown producer in
`gad.getGadStateProducer(...)` return `null`. These are successful lookups with
no match. If a test deliberately probes them, label the result as expected data
instead of throwing or inventing an API error.

### Build Provenance

Use the build service to check what source artifact the runtime can actually
see. From `eval`, `rpc` is injected — call it directly (no import):

```ts
const provenance = await rpc.call("main", "build.inspectBuildProvenance", [
  "@workspace-skills/system-testing",
]);
```

The response includes the resolved unit, effective version, sourcemap and
production build keys, and cached artifact metadata.

### Eval And Method Result Caps

Durable method terminal events cap oversized results before publication. Large
`payload.result` / `payload.error` values are replaced with an omitted-result
summary and a blobstore pointer to the full JSON. The channel stored-value
encoder may still store that summary by reference because `payload.result` is a
forced stored path; hydrate targeted envelopes when you need the bounded
summary.

## Current Invariants

- `log_events` is the private, branchable agentic trajectory and channel log
  storage.
- Publication inspectors join only trajectory-published channel envelopes to
  their private source events.
- `payload_ref_json` is the storage column name even when JSON is inline; there
  is no `payload_json` column.
- Presence envelopes project into `channel_roster`.
- Read-only CTEs are allowed through `gad.query`; write CTEs are rejected.
- Manifest/state hashes are synchronous SHA-256 over stable JSON. They are
  content-addressed identifiers, not compatibility placeholders.

## Contexts And Worktrees

Agent contexts behave like isolated workspace checkouts. Each context can have a
different HEAD, index, branch, and pushed state.

When a source edit appears ignored:

1. Inspect the context's git status and branch.
2. Confirm the workspace repo was published from that context.
3. Confirm the runtime build/reload consumed the published artifact.
4. Only then assume the running code path is still broken.

The build system builds workspace units from git, not from uncommitted working
tree files.

## System Testing Self-Diagnostics

`@workspace-skills/system-testing` automatically attaches
`execution.diagnostics` when a test errors. The packet includes build
provenance and, when a headless channel exists, `gad.inspectAgentHealth(...)`.
For failures that happen outside an individual test, call
`runner.collectDiagnostics({ channelId, error })` directly.
