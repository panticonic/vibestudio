# WebRTC RPC Transport — Validation & Remediation Plan

**Status:** Parts 1–2 (validation register + findings) remain the evidence base.
Parts 3–5 (incremental fix design) are **superseded by `webrtc-rpc-v2-plan.md`**,
the committed no-compat redesign.
**Scope:** Functionality, performance, robustness. Security explicitly out of scope
(security-flavored items are assessed only for their availability/functional impact).
**Inputs:** preliminary agent review + five independent validation passes against the
code as of 2026-07-02.

---

## Part 1 — Validation register

Every finding from the preliminary report was traced through the actual code.
Verdicts: **C** confirmed · **C\*** confirmed with correction · **P** partially confirmed.

| #   | Finding                                   | Verdict             | Evidence / correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Exactly one remote client, structurally   | **C**               | One room per server persisted at `<appRoot>/.vibestudio/webrtc/room` (`src/node/webrtc/cert.ts:94`), one pipe (`webrtcAnswererBootstrap.ts:86-96`), 2-slot cap (`apps/signaling/src/room.ts:130`), re-pairing eviction (`webrtcAnswerer.ts:328-339`). **Nuance:** second device's experience is timing-dependent — `room-full` infinite retry loop (client never treats it as terminal, `webrtcClient.ts:384-390`) or, once device 1's signaling WS idle-closes, last-offer-wins eviction flip-flop. **Key fact for the fix:** `attachWebRtcPipe` is already fully per-pipe (closure-local state, `rpcServer.ts:2874-3010`); the registry keys sessions by `(callerId, connectionId)` and distinct devices get distinct callerIds. The singleton lives only in bootstrap + the shared room. |
| 2   | ICE-disconnected split-brain              | **C**               | Every link verified: answerer fatal on `disconnected` (`webrtcAnswerer.ts:355`) → all shims destroyed (`rpcServer.ts:2911-2916`); client transient (`webrtcClient.ts:417-421`); when ICE recovers, client `tryComplete` early-returns (status never left "connected") so sessions are **never** reopened — that early-return is the exact mechanism blocking self-healing; `SESSION_NOT_OPEN` has zero consumers repo-wide; pings answered at pipe level before shim lookup (`rpcServer.ts:2927`). Client→server **events** on a dead session vanish with no error at all (`rpcServer.ts:2888`). Both native peers do emit `disconnected` distinctly.                                                                                                                                       |
| 3   | Signaling recovery one-shot               | **P**               | Bootstrap one-shot: confirmed (`webrtcAnswererBootstrap.ts:101-106`; `index.ts:3380` abandons failures). But "permanently dead" is overstated for the pipe-up case: `onSignalingClosed` re-fires per close event, giving an **accidental zero-backoff hot rejoin loop** that usually survives. The pipe-down/unpaired case can die permanently via a real race: `signalingRecovery ??=` swallows a close that lands mid-recovery (`webrtcAnswerer.ts:209-240`) and nothing re-arms. Either way: no deliberate backoff loop exists on the answerer side; the offerer has a faithful one (`webrtcClient.ts:494-539`).                                                                                                                                                                         |
| 4   | Hub mode has no answerer                  | **C**               | No answerer in `hubServer.ts`; pairing payload has no `room`/`fp`/`sig` while the link parser hard-requires all three (`packages/shared/src/connect.ts:154-172`). **Worse than reported:** hub-spawned workspace children DO start answerers (they inherit `VIBESTUDIO_WEBRTC_SIGNAL_URL` and run the single-server entry) but all share the hub's `--app-root`, so every child uses the **same room file and cert** — two children fill both slots as double-answerers and any client gets room-full. Child pairing info reaches `runtime.ready` but is never surfaced. Also: pairing codes are in-memory per process (`deviceAuthStore.ts:40`), so a hub-minted code redeems only at the hub.                                                                                             |
| 5   | Head-of-line blocking                     | **C**               | One FIFO `bulkWriteChain` for all streams (`webrtcAnswerer.ts:134,411-417`). Producers never await the sink, so an entire multi-MB body is enqueued up front (`rpcServer.ts:2350-2363`) — net behavior is whole-transfer HOL. Control channel: large fragmented frames serialize through `controlWriteChain` with a 16 KiB drain window; **server pongs ride the same chain**, so sustained control occupancy can convert HOL into a spurious 45 s keepalive teardown. **Load-bearing constraint for the fix:** only a _frame's chunks_ must stay contiguous; ordering across frames is free (each carries its streamId), and control fragment sets are keyed by frameId so even fragment-level interleaving is legal.                                                                      |
| 6   | Backpressure never reaches producer / OOM | **C**               | Shim `bufferedAmount` = control bytes only (`webrtcSessionShim.ts:87-105`); stream DATA → `writeBulk` never metered → the 16 MiB/128 MiB `sendToWs` limits can never trip for streams on a WebRTC session. SCTP buffer is bounded (~256 KiB) but the frame queue is unbounded. The await plumbing already exists end-to-end (`egressProxy.ts` awaits its sink; `PipeChannels.writeControl` already returns a drain promise) — it's missing only at `writeBulk` and `pipeResponseToWsFrames`.                                                                                                                                                                                                                                                                                                |
| 7   | No content-addressed asset cache          | **C**               | Plan §4 promised it; neither facade has any cache. Only mitigation is the webview's own HTTP cache — which is **busted every launch** because both facades bind an ephemeral loopback port (origin changes per run). gzip is mobile-only (desktop facade never passes `gzip: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | Open TURN vending / room-UUID permanence  | out of scope        | Security posture not audited per instruction. Functional aspects folded into the multi-client redesign (per-invite rooms rotate the rendezvous; occupancy-gating falls out of it) and the defrag cap (#12).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Cert single-file silent re-mint           | **C**               | `cert.ts:67` both-or-mint, zero logging; write order (key then cert, `cert.ts:79-81`) means a crash _can_ leave the half-state that triggers silent re-mint. New fingerprint reaches only new pairing surfaces; paired devices hit a client-side-only `DTLS_FINGERPRINT_MISMATCH`. `ensurePersistentRoom` has the same silent-remint shape (empty room file → new room, no log).                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | In-flight RPC hangs forever               | **C\***             | No default timeout (`client.ts:446`, deliberate comment); nothing bulk-rejects pendings on pipe-down (only streams and openPromise are failed). **Correction:** the "3 s grace" doesn't gate inbox replay — `DISCONNECT_GRACE_MS` gates relay-to-disconnected-target waits; inbox replay covers only _routed caller↔caller_ responses within the session TTL (5 min panel / 15 min shell). **Direct server-call responses are never inboxed**: they're sent to the old (closed) shim and dropped silently at any outage length.                                                                                                                                                                                                                                                             |
| 11  | CLI transport leak                        | fixed               | The CLI WebRTC client is live again, but it no longer hand-rolls the leaking setup path: `src/cli/webrtcClient.ts` delegates to `createPairedConnection()`, so connect failure, session-auth failure, and persistence handling share the desktop/mobile bootstrap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | Mobile keychain write swallowed           | **C\***             | The swallow is real (`connect.ts:265-269`, unhandled rejection). **But the trigger is counterfactual: the server never rotates refresh tokens** (`deviceAuthStore.validateRefresh` only compares hashes; `deviceCredential` returned only on the pairing-code path). Worth hardening; not a live-user bug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | Dead ICE-restart surface                  | fixed               | `restartIce()` was removed; recovery is full re-establish by design. Candidate-type observability now lives on the WebRTC transport/shared paired-connection surfaces and is consumed by the shell clients.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | Defragmenter no eviction                  | **C**               | Deliberate + documented (`controlFraming.ts:80-86`), sound for an honest peer. But: ~1 GiB per never-completing set (65535 × ~16 KiB), **unbounded concurrent sets** (u32 id space, no per-pipe byte budget), fed pre-auth (`webrtcAnswerer.ts:263-266` runs before any SESSION_OPEN auth). Process-level OOM = whole-workspace availability loss.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 15  | Test gaps                                 | **C** (understated) | All four named negatives absent from the default suite (unauth-open exists only behind the e2e gate; both transport-test fakes hardcode `bufferedAmount = 0` so drain logic is never exercised; no two-client test). **And default CI runs no tests at all** — `.github/workflows/ci.yml` runs type-check/lint/format only; `pnpm test` is not invoked by any workflow or hook.                                                                                                                                                                                                                                                                                                                                                                                                             |

## Part 2 — New findings (overlooked by the preliminary report)

### High

- **N1. Aborting a WebRTC stream never settles the caller.** `beginStream`'s abort
  handler only sends `SESSION_STREAM_CANCEL` (`webrtcClient.ts:617-629`); the server
  reaps the stream maps _first_, so the handler's eventual ERROR frame finds no
  streamId and is dropped (`webrtcSessionShim.ts:174-191`); locally
  `decodeFramedStream` parks in `reader.read()` forever. The `stream()` promise or
  body hangs and the mux entry leaks until the next pipe-down. The WS path handles
  this; the WebRTC path doesn't, and the `streamIdleTimeoutMs` backstop doesn't
  apply here.
- **N2. Non-terminal server-side session close is a client dead-end.** On
  `SESSION_CLOSED` with `terminal: false` (slow-consumer terminate, 4002
  replacement, shutdown), the client only fails the pending open; nothing ever
  re-sends `SESSION_OPEN` (`webrtcClient.ts:727-730`). Zombie session until the
  whole pipe bounces. The WS transport auto-reconnects on the same codes. (This is
  also the missing self-healing half of the split-brain fix.)
- **N3. Overlapping-recovery race.** `recovering` is cleared _before_
  `await establishPeer()` (`webrtcClient.ts:531,535`); a failure mid-establish
  spawns a second concurrent `reestablish` that splices `unsubs` and can overwrite
  the newer generation's `peer`/`control`/`bulk`, leaking a live PeerConnection.
  The answerer has the same shape (`recoverSignaling`/`connect`/re-pair can each
  call `establishPeer` concurrently; `armSignaling`'s guard races).

### Medium

- **N4. Re-pair candidate ordering inverted.** The answerer's re-pair path drains
  queued ICE candidates at the end of `establishPeer` — _before_ the triggering
  offer is applied (`webrtcAnswerer.ts:280-289` vs `:341`) → native
  "no remote description" → candidates dropped → reconnect can stall until the
  client retries. Mobile offerer has a similar in-flight `setRemoteDescription`
  window (`webrtcClient.ts:383`).
- **N5. Stale-reopen race can terminally kill a live session.** A slow `getToken()`
  from reopen #1 completing after reopen #2 succeeded re-sends `SESSION_OPEN` with
  an already-redeemed one-shot grant → server supersedes the live shim → auth fails
  → shim marks it `terminal` → client sets `sessionClosed` permanently, over a
  healthy pipe. No reopen generation fencing exists.
- **N6. Keepalive shares the FIFO control chain with data.** One large outbound
  control frame over a slow link holds the chain > 45 s → ping never reaches the
  wire → spurious "keepalive timeout" teardown mid-transfer, then repeat. (Server
  pongs queue behind the answerer's chain symmetrically.) Note: out-of-band pings
  are protocol-safe — whole-tagged messages may interleave between fragment sets.
- **N7. Client bulk-channel close is undetected.** Only `control.onClose` triggers
  pipe-down; a bulk-only channel death leaves keepalive green while every stream
  hangs (`webrtcClient.ts:362-376`). Answerer registers no channel close handlers
  at all and ignores ICE `closed`.
- **N8. `hardClose()` strands in-flight session opens** (openPromise never settles;
  `sessions` never cleared) — callers parked in `ready()` hang permanently.
- **N9. Session-open has no timeout and no retry on non-terminal failure** — a lost
  `open-result` or a rejected `getToken` leaves the session dead until the next
  pipe bounce.
- **N10. Signaling-room ghost socket wedge.** No ping/auto-response on room sockets;
  an unclean drop leaves `getWebSockets()` at 2, so the _same peer's_ rejoin gets
  `room-full` until Cloudflare reaps the dead TCP (minutes). Stalls pipe recovery
  entirely.
- **N11. Void'd remote-description handlers have no `.catch`** →
  `setRemoteDescription`/`createAnswer` rejections (which the re-pair comment
  itself documents happening) become unhandled rejections → process crash on
  Node ≥ 15 (server answerer, CLI).
- **N12. Quadruple serialization on the stream hot path.** Per chunk:
  base64-encode → JSON envelope stringify → shim JSON.parse → base64-decode →
  frame copy (`rpcServer.ts:2238` → `webrtcSessionShim.ts:132,306,308`). ~4 copies
  - a JSON escape of a megastring, in-process, both directions.
- **N13. `gateway.fetch` streams aren't cancellable server-side.** Abort
  registration exists only on the proxyFetch branch (`rpcServer.ts:2307-2313`);
  the parsed-service branch registers nothing — after a client cancel the server
  keeps reading/encoding the entire remaining body (DATA frames then dropped at
  the shim).
- **N14. `ensurePanelSession` recycles healthy sessions on transport blips** —
  liveness check uses transport `status()` instead of `isClosed()`
  (`src/main/ipcDispatcher.ts:379-383`) → terminal close + grant re-mint during
  routine reconnects, widening the panel outage window.

### Low

- **N15.** Client receive-side stream buffering ignores `desiredSize` — slow
  consumer buffers the whole body in JS (receive-side mirror of #6).
- **N16.** Reestablish backoff `setTimeout` neither cancelled nor unref'd on close
  (holds a Node process up to 30 s).
- **N17.** Recovery-signal divergence: WS emits `resubscribe` on _first_ connect,
  WebRTC only on re-opens — consumers ported from WS never get their bootstrap
  signal.
- **N18.** Duplicate-sid footgun: `openSession` silently overwrites; `close()` of a
  superseded instance kills its replacement (not identity-checked).
- **N19.** Answerer `connect()` resolves on ICE connected, before channels open,
  contradicting its own contract; writes silently no-op in the gap.
- **N20.** Room relay uses bare `other.send()` (`room.ts:183`) — a throw on a dead
  socket loses the frame instead of buffering.
- **N21.** Mobile has no AppState/NetInfo trigger — recovery after
  backgrounding/network-switch waits for the keepalive to notice (~45-60 s) where
  an event-driven reestablish would take ~1-2 s.
- **N22.** Abort-listener accumulation on shared AbortSignals (never removed on
  stream END/ERROR).
- **N23.** Client `writeBulk` is dead code; uploads ride the control channel as
  base64 JSON. Facades also drop request bodies entirely (asset-origin POSTs
  silently lose their body).
- **N24.** `StreamFrameDecoderV2.push` does O(n) buffer concat per 16 KiB message —
  degrades on large frames spanning many chunks.
- **N25.** CLI `ensureSession` isn't promise-memoized — concurrent first calls
  build duplicate transports; the loser leaks its keepalive + reconnect loop.

---

## Part 3 — Fix design

Six workstreams, ordered by dependency. P0 makes the current single-client system
sound; P1 delivers the actual product goal (N clients); P2 makes it fast; P3 is
hygiene that can land anytime.

### W1 (P0) — Lifecycle correctness: kill the split-brain, make sessions self-healing

The split-brain has two independent causes (server drops sessions too eagerly;
client can't recover a dropped session). Fix both — each is also a fix for other
findings:

1. **Symmetric down-detection on the answerer.** Treat only ICE `failed` as
   immediately fatal. On `disconnected`, start a grace timer (~20 s); cancel if ICE
   returns to `connected`. Add answerer-side liveness from the traffic it already
   receives: track last inbound ping in `attachWebRtcPipe` and declare pipe-down
   after `KEEPALIVE_TIMEOUT_MS` + grace with no pings. Register channel
   `onClose`/`onError` on both ends (client bulk channel included — N7) as
   additional down triggers.
2. **Self-healing sessions (fixes split-brain residue + N2 + #2c).** Server: for
   any frame on an unknown sid (including events), reply
   `{t:"closed", sid, terminal:false, code:4005}` alongside the existing
   per-request error. Client: on non-terminal `closed`, schedule `reopen()` with
   per-session backoff — mirroring `closeCodes.ts` semantics ("any other code is a
   transient drop the client re-establishes"). This single client change also
   heals slow-consumer terminates, 4002 replacements, and any future desync cause.
3. **Reopen hardening (N5, N9).** Per-session reopen generation: a `getToken`
   continuation whose generation is stale is discarded (never sent). Arm a ~20 s
   timeout on each open; on timeout or non-terminal failure, retry with backoff.
4. **Serialize establish (N3).** One in-flight `establishPeer` promise per
   transport; a pipe-down during establish sets a `dirty` flag that re-runs the
   loop after the current attempt settles, instead of spawning a concurrent one.
   Same pattern on the answerer (covers `recoverSignaling`/`connect`/re-pair).
   Close the previous peer _before_ assigning a new one.
5. **Candidate buffering (N4).** Both roles: queue inbound candidates until a
   remote description has been applied to the _current_ peer, then flush. Removes
   the re-pair ordering inversion and the RN in-flight-setRemoteDescription drop.
6. **Settle everything on close (N8, #10).** `hardClose()` fails all sessions
   (`onPipeDown`) and clears the map. In `client.ts`: reject all pending unary
   calls for a session on pipe-down / non-terminal close with `CONNECTION_LOST`
   (server-call responses are provably unrecoverable — they are never inboxed).
   Keep routed-call pendings alive through the TTL/inbox path that does work.
   Unary calls have no implicit deadline; callers may still pass an explicit
   per-call `timeoutMs` when the operation itself should be time-bounded.
7. **Unhandled rejections (N11):** `.catch` + warn on the two void'd
   remote-description call sites; a failed re-pair `establishPeer` triggers
   `onDown`, not a crash.
8. **Shell/desktop consumers:** `ensurePanelSession` recycles only on
   `isClosed()` (N14); move `mainSession.ready?.()` inside the transport
   try/catch in `webrtcServerClient.ts` (#11).

### W2 (P0) — Signaling resilience

1. **Deliberate answerer rejoin loop.** Replace the accidental event-driven retry
   with the same backoff+jitter loop the offerer has (capped 30 s), owned by the
   answerer: on signaling close _or_ initial `connect()` failure, loop until
   joined or closed. Fixes the `signalingRecovery ??=` swallow race by re-checking
   for a pending close after each attempt. Bootstrap supervises: initial failure
   enters the same loop instead of one log line (#3).
2. **Ghost-socket reaping (N10).** Enable the DO WebSocket auto-response ping
   (hibernation-compatible) so dead sockets reap in seconds. Add a `role=offerer|answerer`
   join param; on a full room, a new _offerer_ join evicts the existing offerer
   socket (last-writer-wins is exactly the wanted semantic once rooms are
   per-device — a device's fresh connection replaces its own ghost). Answerer slot
   is never evicted by an offerer.
3. **Client `room-full` handling.** Treat as retryable with capped backoff and a
   loud status (not the current hot reconnect loop); after the eviction policy
   lands it should effectively never persist.
4. **Small fixes:** safe `send()` + buffer fallback in the relay path (N20);
   answerer `connect()` resolves only when both channels are open (N19).

### W3 (P1) — Multi-client architecture (the product goal)

The server side is already N-pipe capable; the redesign is confined to pairing +
bootstrap + room policy:

1. **Ephemeral routed rooms.** `hubControl.pairDevice` asks the selected child to
   arm a fresh room and returns it with a hub-owned one-time code. Redemption
   promotes the runtime room to the device. Identity storage never carries room
   coordinates; returning devices route again after a restart.
2. **Lazy peers.** Change the answerer to arm _signaling only_ on `connect()` and
   create the `RTCPeerConnection` on the first inbound offer (it already queues
   pre-peer descriptions). N idle paired devices then cost N WebSockets, not N
   native peers. (Rooms hibernate on the CF side; cost is negligible.)
3. **Attach per pipe.** `startWebRtcAnswerer` becomes `startWebRtcAnswererPool`:
   one `createWebRtcAnswererPipe` + `attachWebRtcPipe` per room. No rpcServer
   changes needed (validated: closure-per-pipe, registry keyed by
   `(callerId, connectionId)`, duplicate replaced with 4002 — same as concurrent
   WS clients today).
4. **Re-pairing eviction becomes correct by construction:** with per-device rooms,
   a "new offer on a used peer" is the same device reconnecting — exactly when
   last-offer-wins is right.
5. **Hub mode.** Give each workspace child its own state dir (fixes the shared
   room/cert collision — #4), have children mint their own invites, and plumb the
   child's `ready.pairing`/deep link through `workspace.select` and the hub's
   `createPairingInvite` response. Pairing then redeems in the child process,
   sidestepping the in-memory-code staleness. (A hub-level answerer that routes to
   children was considered and rejected: it would re-introduce a parallel RPC
   ingress and violate the one-implementation rule.)
6. **Two-client contention test** (see W6) gates this workstream's completion.

Rotating rooms per invite also incidentally addresses the permanent-room-handle
concern from the out-of-scope list, without doing security work per se.

### W4 (P2) — Data plane: fairness, backpressure, and the byte tax

1. **Round-robin frame scheduler (fixes HOL without a wire change).** Load-bearing
   fact: only a frame's _chunks_ must be contiguous; frames are freely
   interleavable (bulk frames carry streamIds; control fragment sets are keyed by
   frameId). Replace the two FIFO chains with per-stream (bulk) and per-session
   (control) queues drained by a round-robin scheduler that keeps each frame's
   chunks contiguous. Producer frames are one upstream read (~16-64 KB), so
   cross-stream stall drops from whole-transfer to one frame. Keepalive
   ping/pong bypass the queues entirely (N6 — safe: whole-tagged messages
   interleave legally).
2. **End-to-end backpressure (fixes the OOM).** Bound each per-stream queue
   (~1-2 MiB). `writeBulk` returns a promise that resolves when the frame is
   _accepted_ into a non-full queue; the shim meters those bytes into
   `bufferedAmount` (a `pendingBulkBytes` twin of `pendingControlBytes`) so the
   existing 16/128 MiB limits finally see stream traffic; `pipeResponseToWsFrames`
   and the egress sink await the send (the promise plumbing already exists
   everywhere except these two spots). Result: fast-upstream/slow-relay pauses the
   upstream read via ordinary await-chains instead of accumulating.
3. **Chunk-size negotiation.** Add a `hello` control frame exchanging
   `maxMessageSize`/platform limits at pipe establish; desktop↔server uses
   min(measured, 256 KiB) — 16× fewer messages and drain round-trips; mobile stays
   at 16 KiB. Raise the control drain window to match the bulk side's 256 KiB
   high-water (the answerer comment already documents the ~24 KB/s starvation this
   causes).
4. **Cancel propagation (N13):** register the parsed-service stream branch in
   `wsStreamAborts` exactly like the proxyFetch branch. Server stops producing on
   client cancel. Also: server `cancelStream` should emit the ERROR frame _before_
   reaping the id maps so the client-side stream settles (pairs with N1's
   client-side fix: fail the local mux entry on abort; remove abort listeners on
   END/ERROR — N22).
5. **Content-addressed asset cache (plan §4, unbuilt).** Both facades get a
   persistent on-disk cache keyed by content digest (artifacts are already
   digest-addressed; surface the digest via a response header from the gateway
   fetch path). Serve-from-cache on digest hit; validate freshness via the
   existing `getBuild` metadata rather than re-pulling bytes. Also: pass
   `gzip: true` from the desktop facade (one-line parity fix), forward request
   bodies (N23 facade bug), and persist the loopback port per install so the
   webview HTTP cache survives restarts as a second layer.
6. **Binary fast path (N12).** `sendToWs`'s stream-frame path detects the shim and
   hands it `(requestId, frameType, bytes)` directly, skipping
   base64→JSON→parse→base64. In-process only; wire format unchanged.
7. **Deferred (flagged, not designed here):** credit-based per-stream flow control
   for the receive side (N15/L9) and moving uploads onto the bulk channel (N23).
   Both are protocol additions; do them after the scheduler + backpressure land
   and only if measurements say they matter.

### W5 (P3) — Hardening & hygiene

- **Cert/room half-state fails loud (#9):** if exactly one of cert/key exists (or
  the room file is empty), refuse to start WebRTC ingress with an error naming the
  file and the consequence (re-mint = every paired device sees a pin mismatch);
  require an explicit flag or file removal to re-mint. Always log the fingerprint
  - room at startup.
- **Defragmenter budget (#14):** cap concurrent pending sets (~8) and total
  buffered bytes per pipe (~64 MiB); exceeding either is a protocol violation →
  drop the pipe (fail loud), never silently evict. Keeps the honest-peer
  no-timeout rationale while bounding a broken peer's damage.
- **`restartIce` removal (#13):** delete from the provider interface and both
  adapters; recovery is full re-establish by design and it works. Also delete the
  stale comment. Wire `candidateType`/`onCandidateType` through the shared
  WebRTC client surfaces (see W6 — it's the relay alarm's missing plumbing).
- **CLI client (#11, N25):** keep it wired through `createPairedConnection()`, not
  through a bespoke transport bootstrap.
- **Mobile keychain (#12):** await + retry + surface persist failures (and note
  the server doesn't rotate today — this is future-proofing).
- **Timers:** cancel + unref the reestablish backoff timer on close (N16).
- **Recovery-signal parity (N17):** emit `resubscribe` on first open (match WS) —
  audit the few `onRecovery` consumers first.
- **Duplicate-sid safety (N18):** identity-checked `close()`; `openSession`
  closes/rejects a live duplicate.
- **Mobile reconnect triggers (N21):** AppState/NetInfo listeners force an
  immediate keepalive check / reestablish on foreground/network-change.

### W6 (P0 for CI, ongoing) — Tests & observability

1. **Make CI run tests.** Add `pnpm test` to `ci.yml`. This is the single highest
   ROI item in the whole plan — today no workflow or hook runs any test.
2. **Default-suite negatives** (fake-fabric, no native dep):
   un-authed `SESSION_OPEN` through the _real_ `handleAuth` is rejected; ICE
   `disconnected` flap does **not** destroy sessions (split-brain regression);
   non-terminal `closed` triggers client reopen; keepalive survives a saturated
   control chain; backpressure engages (fake channel with a real
   `bufferedAmount` simulation — both transport fakes currently hardcode 0);
   two offerers: same room → deterministic eviction, two rooms → two concurrent
   pipes with independent sessions (gates W3).
3. **Relay alarm (plan §12, "not optional"):** answerer records
   `selectedCandidateType` per pipe on connect + logs recovery path used; counter
   surfaced via the existing metrics/status route; client's `onCandidateType`
   plumbed through `createPairedConnection` / shell clients so relay-mode is
   visible.
4. **Native e2e in CI:** run the `VIBESTUDIO_RUN_WEBRTC_E2E=1` suite on a schedule
   (nightly) or label-gated job, so the native path is exercised by machines, not
   memory.

---

## Part 4 — Breaking-changes register (for explicit review)

Per project policy, changes that tighten/alter existing surfaces, however
internal-looking:

| #   | Change                                                                                                      | Surface                                 | Impact                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Room-per-invite (W3)                                                                                        | Pairing links, persisted mobile pairing | Existing paired devices hold the old shared-room pairing → they must re-pair. (Pre-release, plan's zero-compat rule applies, but this is user-visible.)    |
| B2  | Signaling `role` param + offerer eviction + auto-response ping (W2)                                         | Signaling protocol                      | Old clients joining a new room service: tolerated (param optional), but eviction changes multi-join semantics deliberately.                                |
| B3  | `hello` frame + negotiated chunk size (W4)                                                                  | Control protocol                        | Additive; old peers that never send `hello` stay at 16 KiB defaults.                                                                                       |
| B4  | Non-terminal `closed` for unknown-sid frames (W1)                                                           | Control protocol                        | Additive; old clients ignore unknown frames by design.                                                                                                     |
| B5  | Pending unary RPCs now **reject** on unrecoverable pipe loss; explicit per-call timeouts remain opt-in (W1) | `client.ts` behavior                    | Direct-server callers that relied on transport drops leaving promises pending now see `CONNECTION_LOST`. Calls without `timeoutMs` have no clock deadline. |
| B6  | `PipeChannels.writeBulk` returns a promise; shim `bufferedAmount` includes bulk bytes (W4)                  | Internal interface                      | Bulk-heavy sessions can now trip the 16/128 MiB limits that previously never fired for them — intended, but a behavior change under load.                  |
| B7  | `restartIce()` removed from `RtcPeerConnectionLike` (W5)                                                    | Internal interface                      | Both adapters + tests updated; any out-of-tree provider breaks.                                                                                            |
| B8  | `resubscribe` emitted on first open (W5/N17)                                                                | Recovery hook semantics                 | `onRecovery` consumers fire once more than before.                                                                                                         |
| B9  | Cert/room half-state now refuses startup instead of silently re-minting (W5)                                | Operational                             | A previously "self-healing" (silently identity-breaking) boot now requires operator action.                                                                |
| B10 | `WebRtcRpcClient` rewritten (W5/follow-up)                                                                  | CLI transport                           | The CLI now uses the shared `createPairedConnection()` bootstrap. There is no separate offerer-transport API or compatibility path.                        |
| B11 | Defragmenter budget: protocol-violating peers get the pipe dropped (W5)                                     | Wire tolerance                          | A conforming peer never hits it; a buggy one now fails loud instead of OOMing the server.                                                                  |

## Part 5 — Suggested sequencing

1. **W6.1** (CI runs tests) — immediately, independent of everything.
2. **W1 + W2** — the current single-client pipe becomes actually reliable
   (split-brain, recovery races, signaling supervision). Land with W6.2's
   regression tests.
3. **W3** — multi-client. Gated by the two-client contention test.
4. **W4** — performance (scheduler + backpressure first; cache + negotiation next;
   binary fast path last).
5. **W5** — hygiene batch, opportunistically alongside the above.
