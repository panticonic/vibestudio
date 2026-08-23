# Remote transport QoS and panel delivery

## Decision

A paired device owns one WebRTC `RTCPeerConnection` and one SCTP association per
workspace reach. Logical sessions and panels do not create additional peer
connections. The association exposes three negotiated, reliable, ordered data
channels:

| Lane        | Purpose                                                | Scheduler weight |
| ----------- | ------------------------------------------------------ | ---------------: |
| control     | session lifecycle, keepalive, small RPC envelopes      |                8 |
| interactive | event streams, RPC response bodies, user-visible state |                4 |
| bulk        | immutable artifacts and explicitly bulk transfers      |                1 |

One association-aware scheduler owns all three lanes. It round-robins logical
streams within a lane, applies bounded per-stream and aggregate queues, and
parks only the lane whose native channel is backpressured. A saturated artifact
transfer therefore cannot prevent control or interactive progress. Splitting a
panel into another peer connection is deliberately rejected: it would multiply
ICE, DTLS, NAT, radio, keepalive, and recovery work without removing the need
for application-level prioritization.

The hello handshake negotiates the receiver's safe native buffered window for
each streaming lane. Senders use that value as a hard per-lane ceiling and
adapt their working windows with additive increase and multiplicative decrease;
the association scheduler still owns the aggregate queued-byte cap and send
arbitration. Native runtimes that cannot guarantee a bridge receive window
advertise zero and retain drain-by-drain pacing; Node advertises its bounded
native streaming window.

## Panel artifact delivery

A remote panel entry remains interactive and starts rendering immediately. Its
immutable build key starts one prefetch flight shared by every initial
subresource request:

1. Fetch the build's immutable manifest on the interactive lane.
2. Select only missing artifacts marked `initial` and the exact host runtime
   helper set.
3. Fetch those records in one digest-framed stream on the bulk lane.
4. Verify the complete response boundary, requested-record coverage, and every
   encoded payload digest.
5. Publish the verified records to the content-addressed disk cache as one
   batch. Until every check and write succeeds, no requested path becomes
   visible.

The generated entry addresses `__loader.js` and `__transport.js` with the digest
of the exact helper set. That digest is also folded into the panel build
identity. A warm launch therefore serves the entry, helpers, and immutable
initial artifacts from the stable loopback origin without WebRTC bytes. A
failed prefetch preserves correctness: no partial batch is published, and the
ordinary immutable per-resource path remains the retry mechanism.

## Invariants

- Traffic class is declared by the caller's semantics, never inferred from RPC
  method names.
- All lanes share one scheduler and one bounded association budget.
- Control and interactive work make progress while bulk is writable or blocked.
- A stream never changes lanes after its open frame.
- Protocol peers must agree on the lane and receive-window contract before the
  pipe becomes ready.
- Immutable cache identity derives from exact build/helper content; launch
  context and credentials never fragment it.
- A corrupt, truncated, incomplete, or oversized bundle publishes no paths.

## Verification surface

The focused transport suite covers lane weighting, per-stream fairness,
independent backpressure, zero-window runtimes, adaptive windows, negotiation,
and lane-stable stream routing. Panel server/facade/cache tests cover immutable
helper identity, manifest selection, one-bundle prefetch, warm zero-fetch hits,
and all-or-nothing publication. Native WebRTC and isolated managed-instance
profiles remain the acceptance test for real cold and warm behavior.
