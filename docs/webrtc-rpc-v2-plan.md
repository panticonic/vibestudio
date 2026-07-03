# WebRTC RPC v2 — Full Redesign Plan

**Status:** Implemented (this pass). Supersedes the fix-list in
`webrtc-rpc-remediation-plan.md` (whose Parts 1–2, the validation register and
findings, remain the evidence base; its incremental Part 3 is replaced by this).
See "Implementation notes" at the end for deviations landed with the build.

**Ground rules.** This is a pre-release, self-contained system: **zero backward
compatibility, zero migration, zero legacy accommodation.** Old rooms, pairing
links, wire formats, and half-built surfaces are deleted outright, never shimmed.
Where v1 hedged ("additive so old peers tolerate it"), v2 just changes the
protocol and bumps the version. Existing paired devices re-pair once; that is the
entire migration story. The design rules from `webrtc-rpc-transport.md` still
bind: fail loud, never mask; one mechanism per job; one server RPC
implementation; test the negative.

---

## 0. Target architecture (one page)

```
 pairing invite ──► fresh room UUID per invite ──► QR: room+fp+code+sig+v=2
                                                        │
 ┌─────────────────────────── Cloudflare ───────────────┼───────────────┐
 │ Signaling DO: one room per paired device / invite    ▼               │
 │  · role-tagged slots (answerer|offerer)      offerer joins           │
 │  · same-role join EVICTS the old socket (ghost/self-replacement)     │
 │  · auto-response ping reaps dead sockets in seconds                  │
 └──────────────────────────────────────────────────────────────────────┘
        ▲  ▲  ▲   one signaling WS per room (server side, lazy peers)
        │  │  │
 ┌──────┴──┴──┴────────── server: WebRTC ingress pool ──────────────────┐
 │ ingress pool supervises N answerer pipes (one per device room),      │
 │ each with its own backoff rejoin loop; RTCPeerConnection created     │
 │ lazily on first offer. Each pipe → attachWebRtcPipe (already N-safe).│
 │ Pipe liveness: ICE failed = down; disconnected = 20 s grace;         │
 │ no client ping for 2× negotiated timeout = down.                     │
 └───────────────────────────────────────────────────────────────────────┘
        ║ control: JSON session frames, fragment-interleaved round-robin
        ║ bulk:    self-describing mux messages, per-stream round-robin,
        ║          bounded queues, drain-aware writes (both directions)
 ┌──────╨──────────────── client (one shared bootstrap) ─────────────────┐
 │ createPairedConnection() — single implementation used by desktop      │
 │ main, mobile, and CLI. Serialized establish, generation-fenced        │
 │ session reopen with timeout+backoff, pending-call rejection on loss,  │
 │ out-of-band keepalive, AppState/NetInfo reconnect triggers (mobile).  │
 └────────────────────────────────────────────────────────────────────────┘
```

Everything below is the spec for those boxes.

---

## 1. Wire protocol v2

Pairing links carry `v=2`; the parser accepts exactly `2` and rejects anything
else loudly (there is no v1 installed base to serve).

### 1.1 `hello` — connection preamble & negotiation

First frame on the control channel in **each** direction, after channels open and
the pin verifies, before any `SESSION_OPEN`:

```jsonc
{
  "t": "hello",
  "proto": 2,
  "maxMsg": 262144, // sender's usable SCTP message size
  "platform": "desktop|mobile|server|headless",
  "keepalive": { "intervalMs": 15000, "timeoutMs": 45000 },
}
```

- Effective chunk size = `min(both maxMsg, 256 KiB)`. The RN adapter advertises
  16 KiB (its corruption limit); node-datachannel ends advertise the measured
  256 KiB. **Desktop↔server stops paying 16× the message + drain-round-trip tax
  for a mobile bug it doesn't have.**
- Keepalive parameters are negotiated (min of both), so the answerer knows
  exactly when silence means death (§3.2).
- Any non-`hello` first frame, or `proto !== 2`, is a protocol violation →
  pipe down, logged with the offending frame type. No tolerant fallback.

### 1.2 Bulk channel — self-describing message mux (replaces the v2 byte-stream codec)

The current design (framed byte stream chunked blindly, decoder reassembles by
offset) forces frame-chunk contiguity, requires a stateful O(n)-concat decoder,
and is why all streams serialize through one FIFO chain. Replaced outright:

**Every SCTP message on the bulk channel is a complete mux unit:**

```
[streamId: u32 BE][flags: u8][payload …]
   flags & 0x07 : 1=HEAD 2=DATA 3=END 4=ERROR
   flags & 0x08 : MORE — continuation (HEAD/ERROR JSON larger than one message)
```

- **DATA needs no reassembly at all**: payload bytes are appended to the
  stream; END/ERROR settle it. A "frame" no longer exists on the wire for DATA —
  the contiguity constraint disappears by construction.
- HEAD/ERROR carry JSON; if oversized they continue via MORE messages (rare).
- Unknown streamId: drop + count (client may have cancelled); unknown flag bits:
  protocol violation → pipe down.
- Deleted: `StreamFrameDecoderV2`, its residual-buffer concat, and both
  `bulkWriteChain`/frame-contiguity machinery.

### 1.3 Bulk scheduler + backpressure (both directions, shared implementation)

One `BulkScheduler` per pipe end, used by server and client alike:

- **Per-stream queues**, round-robin: one message (≤ negotiated chunk) per
  stream per turn. Cross-stream head-of-line stall is bounded to one message
  (~16–256 KB), not one transfer.
- **Bounded**: per-stream queue cap **2 MiB**; per-pipe cap **32 MiB**.
  `enqueue(streamId, flags, bytes): Promise<void>` resolves when the bytes are
  accepted under both caps — a full queue makes the producer's `await` pause,
  which propagates to the upstream `reader.read()` loop. No unbounded promise
  chains anywhere.
- Channel writes honor `bufferedAmount` against a **256 KiB** high-water on both
  ends (the answerer's documented starvation fix, now symmetric).
- The server session shim meters its sessions' queued bulk bytes into
  `bufferedAmount` (`pendingBulkBytes` + `pendingControlBytes`), so the existing
  16/128 MiB `sendToWs` limits finally observe stream traffic.

### 1.4 Control channel — per-session fairness, out-of-band keepalive

- Fragmentation stays (frames are whole JSON documents), but the single FIFO
  `controlWriteChain` is replaced by **per-session queues drained round-robin at
  fragment granularity** (fragment sets are keyed by frameId — interleaving is
  already legal). Per-session order is preserved; one session's 5 MB result no
  longer stalls every other session's RPCs.
- Control drain window raised to **256 KiB** (parity with bulk; kills the
  ~24 KB/s relayed-link crawl on large control frames).
- **`ping`/`pong` bypass all queues** — sent immediately as single whole-tagged
  messages (protocol-safe between fragment sets). A saturated link can no longer
  starve its own keepalive into a spurious teardown.

### 1.5 Session frames — closed semantics and self-healing

- Server, on **any** frame for an unknown sid (rpc, route, event, stream-open):
  reply `{t:"closed", sid, code:4005, reason:"session not open",
terminal:false}` (stream-open additionally gets its bulk ERROR). Events no
  longer vanish silently.
- Client, on non-terminal `closed`: schedule `reopen()` with per-session backoff.
  Terminal codes (the `closeCodes.ts` set) remain terminal and now also **remove
  the session from the map** (today they leak).
- Result: _any_ session-state desync between the two ends self-heals within one
  round-trip + reopen, whatever caused it.

### 1.6 Uploads ride the bulk channel

Client `writeBulk` is currently dead code and request bodies travel as base64
JSON inside control envelopes. v2: a `stream-open` envelope may declare
`bodyStreamId`; the client streams the request body as DATA messages on bulk
(same scheduler), server-side the shim feeds it into the stream-request pipeline.
Applies to `gatewayFetch`/proxyFetch uploads. The facades also start forwarding
request bodies at all (today asset-origin POST bodies are silently dropped).

---

## 2. Server

### 2.1 WebRTC ingress pool (replaces the single-pipe bootstrap)

New `src/server/webrtcIngress.ts`, one instance per server process:

- **One room per pairing invite.** `auth.createPairingInvite` mints a fresh room
  UUID; the invite stores `{code, room}`; the deep link carries them. On
  redemption the room is persisted onto the device record
  (`deviceAuthStore`: `deviceId → room`). The per-server singleton room file
  (`<appRoot>/.vibez1/webrtc/room`, `ensurePersistentRoom`) is **deleted**.
- The pool arms **one answerer pipe per device room + per outstanding invite**,
  and tears pipes down on device revocation / invite expiry.
- **Lazy peers:** the answerer arms signaling only on `connect()`; the
  `RTCPeerConnection` is created on the first inbound offer (descriptions are
  already queued pre-peer). N idle devices cost N WebSockets, zero native peers.
- **Supervised rejoin:** each pipe owns a backoff+jitter loop (1 s·2ⁿ + jitter,
  cap 30 s — the exact `wsClient`/offerer policy) covering both the initial
  join and every signaling drop. The accidental event-driven hot loop and the
  `signalingRecovery ??=` swallow race are deleted with the code that had them.
  Bootstrap failure enters the same loop instead of one `console.warn`.
- Pool status (per pipe: state, room, candidate type, last ping) is exposed on
  the existing metrics/status surface — this is the §12 "relay alarm" landing
  spot.

### 2.2 Pipe liveness (kills the split-brain at the source)

- ICE `failed` → down immediately. ICE `disconnected` → **20 s grace timer**,
  cancelled if ICE returns to `connected`. ICE `closed` and channel
  `onClose`/`onError` (both channels — the answerer currently registers none)
  → down.
- **Ping-based liveness:** the answerer tracks last inbound ping; silence for
  2× the negotiated timeout → down. Symmetric with the client's pong tracking —
  the two ends finally agree on what "down" means.
- `connect()` resolves only when both channels are open (matches its documented
  contract; today it resolves on ICE connected and early writes silently no-op).

### 2.3 Per-session server transport: first-class binary stream surface

Keep exactly one server RPC implementation (the shim reusing
`handleConnection`/`handleAuth` stays), but the stream hot path stops
round-tripping through JSON:

- The per-connection transport surface gains
  `sendStreamFrame(requestId, type, bytes)` / `onStreamFrame(...)`. The WS
  transport implements it with today's base64-JSON encoding (loopback WS wire
  unchanged); the WebRTC shim implements it by mapping `requestId → streamId`
  and enqueueing binary mux messages directly.
- `handleWsStreamRequest`'s emit path and the egress sink call it and **await
  it** (the promise plumbing exists everywhere except the last two links).
- Deleted: the quadruple copy (base64 → JSON.stringify → JSON.parse → base64 →
  frame copy) in both directions.

### 2.4 Stream cancellation actually cancels

- Register the parsed-service stream branch in `wsStreamAborts` exactly like the
  proxyFetch branch — a client cancel stops the server reading/encoding.
- `cancelStream` emits the ERROR mux message **before** reaping the id maps, so
  the far end always settles.

### 2.5 Defragmenter budget

Keep the no-timeout rationale (reliable ordered channel), bound the damage: per
pipe, max **32 concurrent pending sets** and **64 MiB buffered fragment bytes**.
Exceeding either is a protocol violation → pipe down, logged. A conforming peer
can't hit it; a broken one fails loud instead of OOMing the workspace server.

### 2.6 Identity files fail loud

`ensurePersistentCert`: exactly-one-of-two PEM files (or an empty/corrupt file)
→ **refuse to start WebRTC ingress**, naming the file and the consequence
(re-mint = every paired device sees a pin mismatch). Re-mint requires deleting
both files deliberately. First provision and reuse both log the fingerprint.
(The room file is deleted by §2.1, taking its silent-remint clone with it.)

---

## 3. Client — one implementation, three platforms

### 3.1 `createPairedConnection()` — shared bootstrap

Desktop main (`webrtcServerClient.ts`), mobile (`mobile-webrtc/connect.ts`), and
the CLI (`src/cli/webrtcClient.ts`) share one bootstrap helper in `packages/rpc`
so the connect/session-auth failure guards, `onPaired` persistence, and recovery
fan-out cannot diverge:

```ts
createPairedConnection({ pairing, provider, getShellToken, onPaired, connectTimeoutMs })
  → { transport, mainSession, openSession, close }
```

- Owns: connect with timeout, **close-on-any-failure** (including session-auth
  failure after connect), promise-memoized single-flight, keepalive lifecycle,
  onPaired persistence hook. Platforms supply only the peer provider and
  storage callbacks.
- Mobile's `persistShellCredential` is awaited with retry; a persist failure is
  surfaced (event + log), never a void'd rejection.
- Mobile registers AppState/NetInfo listeners: on foreground / network change,
  force an immediate liveness check → reestablish (seconds, not the ~45–60 s
  keepalive lag).
- The CLI keeps remote support by consuming this helper; there is no separate
  offerer-transport implementation or exported compatibility path.

### 3.2 Transport recovery state machine (rewrite of the ladder, same policy)

- **Serialized establish:** one in-flight `establishPeer` per transport, always.
  A down-event during an establish sets a `dirty` flag consumed after the
  attempt settles — never a concurrent teardown/rebuild. The previous peer is
  closed _before_ the new one is assigned. (Same discipline on the answerer.)
- **Candidate buffering, both roles:** inbound candidates queue until a remote
  description is applied to the _current_ peer, then flush — fixes the re-pair
  ordering inversion and the RN in-flight-`setRemoteDescription` drop.
- All void'd async signaling handlers get `.catch` + warn; a failed re-pair
  establish is a down-event, not an unhandled rejection crash.
- Backoff timers are tracked, cancelled, and unref'd on close.
- `hardClose()` fails every session (`onPipeDown`), clears the sessions map, and
  settles everything a caller could be awaiting.
- Keepalive: out-of-band per §1.4; parameters from `hello`.

### 3.3 Session lifecycle

- **Reopen generations:** each `reopen()` takes a generation; a `getToken`
  continuation whose generation is stale is discarded un-sent (a slow grant
  fetch can no longer burn a fresh grant redemption and terminally kill a live
  session).
- **Open deadline:** 20 s per attempt; timeout or non-terminal failure retries
  with backoff. `ready()` can no longer hang on a lost `open-result`.
- Non-terminal server `closed` → auto-reopen (§1.5). Terminal → removed from the
  map; `close()` is identity-checked so a superseded instance can't kill its
  replacement; `openSession` on a live duplicate sid closes the old one
  explicitly first.
- `resubscribe` is emitted on the **first** open too (parity with the WS
  transport, whose consumers were written against that behavior).
- `ensurePanelSession` (desktop dispatcher) recycles only on `isClosed()`;
  transport-level "connecting" is transient and left to auto-reopen.

### 3.4 Pending calls: nothing hangs, ever

Validated fact: responses to direct client→server calls are **never** inboxed —
after any pipe drop they are unrecoverable. Policy:

- On pipe-down and on non-terminal session close: reject all pending
  **direct-server** calls with `CONNECTION_LOST`.
- Routed caller↔caller calls survive a clean reconnect (`resubscribe` — inbox
  replay works for them) and are rejected on `cold-recover` (server state gone).
- **Transport-level re-drive:** inbox replay only covers routed frames the
  server actually received. A routed request OR response that was enqueued but
  never flushed at pipe-down is re-driven by the WebRTC transport on
  `resubscribe` (after the session reopens), keyed by requestId and tracked
  until a confirmed flush / settling response / routed-response-error. A lost
  request strands the local pending; a lost response strands the REMOTE
  caller's (the server's `routedRequestOrigins` entry is only consumed by
  response delivery, and the caller's own pipe never went down — no rejection
  path fires). Duplicate-safe: a partially-sent fragment set is discarded by
  the peer's control-defragmenter reset on reconnect, so a re-driven frame was
  definitionally never delivered; and the server consumes the origin entry on
  first response delivery, bouncing any duplicate back to the responder as
  `routed-response-error` (a no-op there). Cleared on `cold-recover`, terminal
  session close and hard close (the client layer rejects those pendings
  instead).
- **Callee terminal death:** re-drive and inbox replay cannot cover a routed
  request that WAS delivered to a callee that then terminally dies (grace
  expiry — also where token-revoke closes land): no response will ever exist,
  and the caller's own pipe never went down. The server tracks the callee
  connection per in-flight routed request (`routedRequestOrigins[*].callee`,
  recorded when the request is relayed) and, at the callee's terminal
  departure (the same point its own routed origins are dropped), sends each
  stranded caller a `routed-response-error` with `RECONNECT_GRACE_EXPIRED`.
  A mere pipe-down + resubscribe within grace does NOT trigger this (the
  replay/re-drive paths own that case). Exactly-once settle: teardown and a
  concurrently arriving response race on the same map delete — whichever
  consumes the origin entry settles the caller, the loser bounces to the
  responder as a no-op. The map is in-memory per-process: on server death the
  client layer already rejects all pendings (`cold-recover` / disconnect), so
  restart needs no persistence.
- **No implicit RPC deadline** for unary calls. Callers may opt in with a
  positive per-call `timeoutMs`; omitted or non-positive values leave the call
  bounded only by transport/recovery failure.

### 3.5 Streams

- Abort settles locally: `beginStream`'s abort handler fails the local mux entry
  (`inboundMux.fail(streamId, err)`) in addition to sending the cancel; abort
  listeners are removed on END/ERROR (no accumulation on shared signals).
- Receive-side buffer bounded at **8 MiB per stream**: exceeding it errors the
  stream and sends cancel — fail loud. (Credit-based flow control is designed
  but deferred: adopt only if relay-link telemetry shows bounded-buffer aborts
  in practice; it is protocol surface we shouldn't carry speculatively.)

---

## 4. Signaling service

- **Role-tagged joins:** `?role=offerer|answerer` (required; missing → 400).
  Slots are role-keyed, one each.
- **Same-role join evicts the incumbent socket.** This is last-writer-wins as a
  _feature_: with per-device rooms, a same-role joiner is by construction the
  same party reconnecting (its own ghost after an unclean drop, or a server
  restart re-arming the answerer slot — both currently wedge on `room-full`
  until Cloudflare reaps the TCP). `room-full` as a concept disappears.
- **Auto-response ping** (`setWebSocketAutoResponse`, hibernation-compatible) so
  dead sockets reap in seconds regardless.
- Relay uses the throw-safe `send()` everywhere; a failed relay to the sole
  counterpart falls back to the pre-join buffer instead of losing the frame.
- The pre-join frame buffer, hibernation roster, and blind-relay posture are
  unchanged (they validated clean).
- ICE-servers endpoint: unchanged in this plan; TURN credential gating/TTL is
  security surface, explicitly deferred to the out-of-scope security pass.

---

## 5. Pairing & hub mode

- **Invite = code + fresh room** (§2.1). `createConnectDeepLink` emits `v=2`.
  Parser requires `room`, `fp`, `code`, `sig`, `v=2` — anything else rejects
  with a message that says "re-pair with a current link".
- **Hub:** each workspace child gets its **own state dir** (its own cert +
  device store namespace — the shared-appRoot room/cert collision dies with the
  shared room file). Children mint their own invites; the hub surfaces the
  child's pairing link through `workspace.select` / `createPairingInvite`
  responses (the data already reaches `runtime.ready`; it is currently dropped
  there). Pairing codes redeem in the child process, so the in-memory-code /
  stale-device-store cross-process problems never arise. A hub-level answerer
  that routes into children was considered and rejected: it would be a second
  RPC ingress implementation (violates one-mechanism) and would re-serialize
  every workspace behind one pipe.

---

## 6. Asset plane

- **Content-addressed on-disk cache in both facades** (plan §4, finally built):
  keyed by content digest surfaced from the gateway fetch path (artifacts are
  already digest-addressed). Digest hit → serve from disk, zero pipe bytes;
  freshness rides the existing `getBuild` metadata, not byte re-pulls. Desktop:
  app cache dir; mobile: RN file storage. Cache is size-capped (1 GiB, LRU).
- **gzip parity:** desktop facade passes `gzip: true` (today mobile-only).
- **Stable loopback port per install** (persisted, re-bound when free) so the
  webview HTTP cache stops being busted every launch — a free second cache
  layer on top of the digest cache.
- Request bodies forwarded end-to-end (§1.6).

---

## 7. Deletions register

Deleted outright, no shims, no deprecation period:

| What                                                                    | Where                                                                                           | Replaced by                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Per-server singleton room + `ensurePersistentRoom`                      | `src/main/webrtc/cert.ts:94`, `index.ts:3365`                                                   | Per-invite rooms (§2.1)                                         |
| Single-pipe bootstrap `startWebRtcAnswerer`                             | `src/server/webrtcAnswererBootstrap.ts`                                                         | Ingress pool (§2.1)                                             |
| `bulkWriteChain` / `controlWriteChain` FIFO chains                      | `webrtcAnswerer.ts`, `webrtcClient.ts`                                                          | Schedulers (§1.3, §1.4)                                         |
| `StreamFrameDecoderV2` byte-stream parser + frame contiguity constraint | `protocol/streamCodec.ts`                                                                       | Message mux (§1.2)                                              |
| Base64/JSON stream round-trip through the shim                          | `rpcServer.ts:2238`, `webrtcSessionShim.ts:291-316`                                             | Binary stream surface (§2.3)                                    |
| `restartIce()` + adapters + stale comments                              | `webrtcPeer.ts:86`, both adapters                                                               | Nothing — full re-establish is the one recovery path, by design |
| Client dead `writeBulk` + base64-envelope uploads                       | `webrtcClient.ts:254`, `gatewayFetchService`                                                    | Bulk uploads (§1.6)                                             |
| Bespoke per-platform connection bootstraps (3 copies)                   | `webrtcServerClient.ts`, `mobile-webrtc/connect.ts` (transport part), `src/cli/webrtcClient.ts` | `createPairedConnection` (§3.1)                                 |
| "No default deadline" pending-call semantics                            | `client.ts:446`                                                                                 | §3.4                                                            |
| `room-full` handling + 2-anonymous-slot join model                      | `apps/signaling/src/room.ts`, client handlers                                                   | Role-tagged eviction (§4)                                       |
| Silent cert re-mint branch                                              | `cert.ts:67-82`                                                                                 | Fail-loud refusal (§2.6)                                        |
| Accidental signaling retry chain + `signalingRecovery ??=` race         | `webrtcAnswerer.ts:209-240`                                                                     | Supervised loop (§2.1)                                          |

## 8. Behavior-changes register (for explicit review)

No compatibility is kept, but these are the _observable_ semantic changes:

1. **All existing pairings invalidate** — every device re-pairs once (new rooms,
   `v=2` links).
2. **Unrecoverable pending RPCs reject instead of hanging** (`CONNECTION_LOST`
   on direct-server pipe loss or routed cold-recover). Calls without explicit
   `timeoutMs` do not get a clock deadline.
3. **Bulk-heavy sessions can now hit the 16/128 MiB backpressure limits** that
   never fired for them; slow-consumer terminate + auto-reopen replaces silent
   unbounded buffering.
4. **A same-device reconnect evicts its old signaling socket and pipe
   deterministically** (previously: minutes-long `room-full` wedge or eviction
   flip-flop, depending on timing).
5. **Server refuses to boot WebRTC ingress on half-present identity files**
   (previously: silent new identity, all devices pin-fail).
6. **Protocol violations drop the pipe** (bad first frame, defrag budget, bad
   flags) instead of best-effort tolerance.
7. **`resubscribe` fires on first open** (recovery-hook consumers fire once more
   than before).
8. **ICE `disconnected` no longer kills sessions server-side** (20 s grace +
   ping liveness); brief blips are invisible to panels.

## 9. Tests & observability (gates, not chores)

1. **CI runs `pnpm test`** — first commit of the effort, before any redesign
   lands. (Today no workflow or hook runs any test.)
2. **Protocol conformance suite** (fake fabric, default-run): hello negotiation
   incl. reject-on-bad-proto; mux framing round-trip incl. MORE continuation and
   unknown-flag pipe-drop; fragment-interleaving fairness; out-of-band ping
   under a saturated queue; defrag budget violation → pipe down.
3. **Lifecycle regression suite:** ICE `disconnected` flap → sessions survive
   (split-brain); unknown-sid frame → non-terminal `closed` → auto-reopen;
   stale-generation `getToken` discarded; open deadline fires; `hardClose`
   settles a parked `ready()`; abort settles a pre-HEAD stream; pending-call
   rejection matrix (direct vs routed × resubscribe vs cold-recover).
4. **Backpressure suite:** fake channels with real `bufferedAmount` simulation
   (both current fakes hardcode 0); producer pauses at queue cap; shim
   `bufferedAmount` includes bulk bytes; soft/hard limits trip.
5. **Multi-client suite (gates §2.1):** two devices, two rooms → concurrent
   pipes with independent sessions; same-device reconnect → deterministic
   eviction, sessions re-open, other device unaffected.
6. **Auth negative through the real path:** un-authed / replayed-grant
   `SESSION_OPEN` via `attachWebRtcPipe` → real `handleAuth` rejection
   (default-run, not e2e-gated).
7. **Native e2e** (`VIBEZ1_RUN_WEBRTC_E2E=1`) runs nightly in CI.
8. **Relay alarm:** per-pipe candidate type + recovery-path-used logged and
   surfaced on the status route; client `onCandidateType` plumbed through
   `createPairedConnection` / shell clients. Alert when relay rate exceeds
   baseline (plan §12 called this "not optional").

## 10. Sequencing

Four stages; each lands whole (no dual-format interludes — pre-release means the
tree just moves):

1. **CI + harness** — §9.1, plus the fake-channel `bufferedAmount` upgrade the
   other suites need.
2. **Transport core v2** — one coherent change: wire protocol (§1 entire),
   liveness (§2.2), recovery machine + session lifecycle + pending-call policy
   (§3.2–3.5), defrag budget (§2.5), with suites §9.2–9.4. This is the largest
   stage; it rewrites both pipe ends against the new protocol at once.
3. **Multi-client** — ingress pool + per-invite rooms + signaling role/eviction
   - hub child state dirs (§2.1, §4, §5), gated by §9.5. Includes
     `createPairedConnection` (§3.1) since pairing flows change anyway.
4. **Data-plane completion** — binary stream surface (§2.3), cancellation
   (§2.4), uploads (§1.6), asset cache + gzip + stable port (§6), identity
   fail-loud (§2.6), relay alarm (§9.8).

Estimated blast radius: `packages/rpc` (protocol + transports + client),
`src/server` (ingress pool, shim, rpcServer stream path), `apps/signaling`,
`src/main` + `packages/mobile-webrtc` + `src/cli` (converge on the shared
bootstrap), facades. The gateway HTTP surface, grant/lease model, and session
registry are untouched — the per-principal auth design validated clean and
carries over as-is.

## Implementation notes (deviations & decisions landed with the build)

- **Session-not-open close code is `4008`, not `4005`.** The plan's proposed
  `4005` collided with the WS transport's `CLOSE_EXPECTED_AUTH = 4005`
  (`protocol/closeCodes.ts`); `SESSION_NOT_OPEN_CLOSE_CODE` renumbered to
  `4008` (non-terminal — the client auto-reopens the session).
- **Request bodies (§1.6) ship as an upload-only transport hook.** Panel-side
  request bodies ride the bridge via a dedicated `transport.streamBody`
  hook (`packages/rpc/src/types.ts` / `client.ts`) pumping
  `streamBodyChunk { bodyId, seq, … }` messages (`bridgeStream.ts`), rather
  than a fully symmetric body surface on every transport.
- **Mobile asset cache is in-memory only.** No react-native-fs dependency; the
  RN asset cache does not persist across app restarts (re-fetch over the pipe
  on cold start).
- **Hub pairing surfaces via child-proxy invite minting.** The hub does not run
  its own answerer; it mints pairing invites by proxying to the per-workspace
  child server, which owns the room and the DTLS cert.
- **`cancelStream` sends no settle-ERROR frame (final sweep).** The client
  settles its local stream on abort BEFORE sending `stream-cancel`
  (`webrtcClient.beginStream`), so a server ERROR frame would land as
  unknown-streamId and be dropped — and the shim's own
  `dropBulkStream`/`frameScheduler.dropKey` would discard the just-enqueued
  ERROR before it ever left. Cancel is now: drop backlog → reap id maps →
  inward `stream-cancel` (`src/server/webrtcSessionShim.ts`).
- **Dead v1 surfaces deleted (final sweep).** The byte-stream v2 parser/encoder
  variants are gone; `protocol/streamCodec.ts` keeps the shared frame constants
  and HTTP/WS decoder while `protocol/bulkMux.ts` owns WebRTC stream
  multiplexing. The standalone offerer transport file/export is gone after
  `createPairedConnection` convergence. The `VIBEZ1_WEBRTC_ROOM` /
  `VIBEZ1_PAIRING_CODE` env inputs are also gone from smoke scripts and
  onboarding docs; the server mints per-invite rooms and codes itself and prints
  the `v=2` link.
