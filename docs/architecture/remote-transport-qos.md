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

## Panel artifact delivery

Immutable panel artifacts retain their content-addressed disk cache. A cold
remote launch fetches missing records through a normal streaming RPC. The
receiver verifies the response boundary, requested-record coverage, and every
payload digest before atomically publishing the batch. A warm launch serves the
entry, helpers, and immutable records from the device-local loopback origin and
moves no artifact bytes over Iroh.

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
