# Remote transport flow control and panel delivery

## Decision

Iroh QUIC provides the transport scheduler. Vibestudio does not recreate
application lanes, a stream multiplexer, or a second panel connection. Every
RPC request has its own bidirectional QUIC stream, so control messages, user
interactions, uploads, and immutable artifact transfers are independently
flow-controlled by QUIC.

The logical-session control stream and retained request streams (event watches,
CDP, and other subscriptions) may be long-lived. Peer-opened request metadata
has a strict frame limit so admission cannot force an unbounded allocation.
Unary results and server messages use the QUIC send-stream FIN as their payload
boundary: they are transferred in bounded working chunks with native
backpressure and no transport-wide total-size ceiling. Streaming responses use
a bounded metadata head and raw body bytes; uploads apply bounded chunk reads
and propagate cancellation with QUIC reset/stop. A method may own a semantic
limit for its resource, but the transport does not invent one.

Streaming response admission has no implicit elapsed-time deadline. A caller
may supply an explicit response-head deadline; expiry cancels and joins the
upload, its cancellation hook, and the native receive before rejecting. The
first upload or cancellation failure reaches the response caller, including
failures after response headers have arrived. Request ownership remains visible
until cancellation cleanup completes.

## Panel artifact delivery

Immutable panel artifacts retain their content-addressed disk cache. A cold
remote launch fetches missing resources through ordinary streaming RPCs.
Desktop prewarming reads the pinned manifest and starts the initial resources
while the browser evaluates its entry. Demand and prewarming share one upstream
population for each immutable cache key. Every consumer reads from its own
position in the growing disk file, including consumers that join before EOF.
Bytes enter the file before becoming readable; lagging consumers retain disk
bytes rather than an unbounded JavaScript tee queue. Completed responses are
hashed over their received representation and published to the cache.

Each consumer owns its cancellation. Closing the initiating browser does not
cancel a surviving speculative or demanded reader. The last consumer closes
the upstream stream; facade retirement cancels and joins requests, prewarming,
and cache populations. Original stream failures reach every consumer. Asset
requests have no elapsed-time watchdog: cancellation and transport loss are
the terminal boundaries. Failed prewarming is logged and is not recorded as a
completed build. A warm cache hit serves bytes from the device-local loopback
origin and moves no artifact bytes over Iroh.

The growing file adds disk writes and reads to a cold miss. Preserving
speculation and immediate joining avoids a full-download barrier, but does not
prove an end-to-end load-time improvement. Compare the same panel's semantic
readiness on representative disks and WAN paths before claiming a speedup.

## Recovery completion

Physical reconnection precedes workspace readiness. Desktop recovery awaits
watch replay, the native shell snapshot, and recovery completion from every
loaded application renderer and hosted chrome. Each acknowledgement belongs to
an exact WebContents, request ID, and workspace generation. Renderer navigation,
destruction, process exit, workspace retirement, or transport loss settles the
owned wait. Browser views do not participate in application RPC recovery.

An application renderer still evaluating modules waits for runtime recovery
registration. A recorded panel bootstrap failure rejects that wait with its
original error. Renderer recovery handlers are joined before acknowledging;
their errors propagate to the workspace owner. A failed recovery does not
publish `connected`, and recovery coordinators do not retry or turn failures
into successful completion.

Native dial ownership is a separate release dependency. The reviewed patch in
`packages/iroh-transport/native` provides a cancellable, joinable dial handle,
but the currently pinned binding does not expose that API. Application adoption
requires matching published Node and mobile bindings; the local proof binary
does not satisfy that boundary.

## Observability

The client reports the selected Iroh path (`direct` or `relay`), selected remote
address, and RTT when the binding exposes them. Reconnect generation, relay
attempts, recovery result, close source/code, open stream counts, and byte
high-water observations belong to the transport record. Large-message logs name
the RPC operation and encoded byte count without rejecting it. Logs abbreviate
Endpoint IDs and never contain endpoint secrets, refresh tokens, pairing codes,
invite URLs, or RPC bodies.

## Verification surface

The focused suite exercises real native Iroh endpoints, control/session framing,
independent QUIC requests and streams, cancellation, reconnect, relay ordering,
and endpoint-bound authentication. Mobile bridge contract tests cover exact
ALPN and Endpoint ID checks, bounded reads, and reset/stop lifecycle. Packaging
checks require the exact target-native artifact. Physical-device direct,
relayed, failover, cold, and warm measurements remain release gates.
