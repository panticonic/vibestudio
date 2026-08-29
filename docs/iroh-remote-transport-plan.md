# Iroh Remote Transport Replacement Plan

**Status:** Repository cutover implemented on 2026-08-28 across the host and
Base worktrees. Iroh is the only remote transport and the retired transport
infrastructure has been deleted. Focused protocol, product, packaging, Base
mobile, type, lint, formatting, dependency, native-artifact, and absence checks
are green. Shipment remains blocked on the explicitly external gates recorded
below: production relay provisioning/failover/load proof, retained-platform
packaged and physical-device validation, and a repeated startup sample proving
the remaining delta is not a credible regression. Managed system-test bootstrap now reaches a paired ready
workspace, but the configured test model is unavailable locally (`needs-setup`).

**Decision date:** 2026-08-28

## Decision

Replace Vibestudio's remote WebRTC transport with Iroh and delete the WebRTC
stack in the same cutover.

There will be exactly one remote transport implementation: an Iroh endpoint
carrying Vibestudio's RPC protocol over QUIC. There is no WebRTC fallback,
feature flag, dual-read pairing schema, compatibility adapter, sidecar, or
parallel mobile transport. Co-located desktop/server operation remains on
loopback WebSocket because it is a different topology, not a remote fallback.
The public HTTPS callback relay remains because OAuth callbacks and webhooks
come from third parties and cannot use a device-to-server transport.

This is a pre-release cutover. Existing WebRTC pairing links and stored remote
reach records become invalid and users pair again. We do not translate old
rooms, fingerprints, signaling URLs, ICE policies, or DTLS certificates into
Iroh state.

The official bindings currently omit macOS x86_64 for Node. Vibestudio will
remove macOS x64 from its supported desktop/release matrix. It will not build a
custom binding or retain WebRTC for that target.

## Why Iroh is the right abstraction

The WebRTC implementation is solving transport problems that QUIC and Iroh
already own:

- key-addressed encrypted connections;
- direct UDP paths, NAT traversal, path changes, and relay fallback;
- independent ordered streams with connection-level and stream-level flow
  control;
- stream cancellation without a custom multiplexer;
- maintained Node, Swift, and Kotlin bindings over one Rust core;
- an open-source, self-hostable, stateless relay.

Vibestudio should continue to own application semantics: pairing, users,
device revocation, logical sessions, RPC envelopes, event replay, leases,
workspace routing, and panel asset policy. Iroh Endpoint IDs are pipe identity,
not user authorization. Iroh streams are transport primitives, not a reason to
adopt an unrelated RPC framework.

The result removes the custom SCTP association scheduler, three DataChannels,
control fragmentation and sequencing, binary stream mux, receive-window/AIMD
logic, signaling rooms, DTLS certificate plumbing, ICE/TURN policy, and the
React Native WebRTC module. It does not merely rename them.

## Non-negotiable design rules

1. **One implementation per job.** No WebRTC/Iroh selection and no remote
   WebSocket fallback.
2. **Use one verified upstream release set.** Package version numbers are not
   assumed to equal the embedded Rust-core version. Pin every binding artifact,
   its digest, the exact `iroh`/`iroh-base` version embedded by those bindings,
   and the matching `iroh-relay` release. Do not depend on `latest`, Git
   branches, a Vibestudio fork, or visually matching version labels.
3. **No default production preset.** JavaScript `Endpoint.bind()` enables n0's
   public discovery and relays by default. Product code must construct an
   explicit endpoint configuration. A test-only fixture may use the n0 public
   preset.
4. **No transport reinvention above QUIC.** Every request owns a QUIC stream.
   Backpressure is awaiting that stream's writes. Cancellation is QUIC
   reset/stop. We do not rebuild lanes, ACKs, fragment sets, sequence windows,
   or a weighted byte scheduler, and we do not multiplex unrelated requests
   onto one shared ordered stream.
5. **Nothing crosses an unverified connection.** Use only the bindings' normal
   full-handshake `connect`/`accept` completion APIs. Never call or expose a
   0-RTT/early-data API; if a selected binding later enables early data through
   configuration, disable it explicitly and test that setting. A pairing
   redemption, refresh credential, grant, or mutating RPC can therefore never
   be replayed into the server ahead of the handshake. Neither side sends or
   processes application bytes until the completed handshake has verified the
   peer's Endpoint ID; that includes the server's 0.5-RTT window, which would
   otherwise write to a peer whose identity is not yet proven. Application
   authentication then happens over the verified connection.
6. **Bound allocation and ownership, not legitimate transfer size.** Control
   frames, pre-auth work, concurrent admissions, retained requests, queues,
   timeouts, and diagnostic retention have explicit limits. Payload transfer
   uses bounded working chunks and QUIC backpressure. A total-body ceiling
   exists only when the RPC method understands and owns that resource; the
   transport does not impose an arbitrary one.
7. **Direct versus relayed is observable.** Relay use is expected behavior, but
   never invisible behavior. Connection diagnostics and metrics state the
   active path, relay, path changes, RTT, close cause, and reconnect outcome.
8. **No performance claims without the native profiler.** Capture the current
   WebRTC baseline before deletion, then repeat the exact user-visible
   experiments on Iroh. Cold and warm states remain distinct.

## Provisional Phase 0 release set

The upstream packages called `1.1.0` do not embed Iroh core `1.1.0`.
`iroh-ffi` `v1.1.0` was released first and its checked-in lockfile pins
`iroh`, `iroh-base`, and `iroh-relay` `1.0.2`. Phase 0 therefore starts with
this internally aligned set rather than mixing FFI/core/relay releases by
their display version:

| Component                          | Provisional exact pin                                                                  | Verification                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node/Electron/server/CLI           | `@number0/iroh@1.1.0` plus its exact per-platform optional package                     | npm integrity and packed native artifact checksum recorded per target                           |
| Shared FFI source identity         | `n0-computer/iroh-ffi` tag `v1.1.0`, commit `5e451092dba0c1a09ee83ff6e5be37b1152a5c58` | tag commit plus checked-in `Cargo.lock`                                                         |
| Embedded Rust core                 | `iroh@1.0.2`, `iroh-base@1.0.2`                                                        | exact versions and crates.io checksums from the FFI lockfile                                    |
| iOS                                | official `IrohLib.xcframework.zip` `v1.1.0`                                            | SHA-256 `ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776`                      |
| Android                            | official `computer.iroh:iroh-android:1.1.0` AAR                                        | SHA-256 `ed747f627da6dad314b25b9ff17d38232d8d75cb31e663af348368e6be845ab8` and Maven provenance |
| Relay fixture/production candidate | stock `iroh-relay@1.0.2`                                                               | official release-asset digest for the exact deployment target                                   |

The JavaScript package's registry integrity is
`sha512-DlrJ4Sza5MiI+WwQg63lg+7eSbxlfQR2Bd+wVDjo7XTqenALD2OCRoSfPTuD12IhcvDbVHr4l7qH48DilocqYA==`.
WP1 records the optional native-package integrities and relay binary digest for
every retained target before those artifacts enter CI or packaging.

This set is a spike input, not a promise to ship an older core. If a gate fails
because of a fixed upstream defect or missing binding surface, evaluate the
newest official mutually aligned release set and rerun the entire Phase 0
matrix on that set. Never mix successful results from different release sets.

## Scope boundaries

### Replaced

- remote desktop, mobile, CLI, hub-control, and workspace-child transport;
- remote pairing/reconnect reach grammar;
- WebRTC signaling and ICE/TURN deployment;
- DTLS reach certificates and fingerprint pinning;
- WebRTC-specific session framing, stream mux, QoS, recovery, diagnostics,
  packaging, tests, and documentation.

### Preserved

- `EnvelopeRpcTransport` and service clients above it;
- loopback WebSocket for co-located mode;
- hub control reach plus a distinct direct workspace-child reach;
- device credentials, users, membership, revocation, logical caller/session
  identities, event delivery, inbox replay, leases, and cold recovery;
- the local panel HTTP facade and durable mobile asset store;
- the callback relay for OAuth and webhooks.

### Explicitly not introduced

- Iroh's higher-level blobs, gossip, or RPC protocols;
- n0 address lookup as a production dependency;
- a browser/WASM remote client;
- Cloudflare Worker reimplementation of `iroh-relay`;
- a Cloudflare-Container-specific relay path;
- a custom Rust transport core, N-API addon, or macOS x64 build;
- React Native New Architecture as an incidental part of this change;
- background-always-connected mobile operation. Mobile reconnects when the app
  becomes active unless a separately justified foreground-service product
  requirement is approved.

## Target topology

```text
                         public HTTPS only
              OAuth / webhook callback relay (unchanged)
                               |
                               v
  desktop/mobile/CLI       Vibestudio server machine
  one Iroh Endpoint        hub Endpoint + child Endpoints
       |   |                    ^             ^
       |   +--- workspace QUIC -+-------------+
       +------- control QUIC ---+
            \                  /
             \-- direct UDP --/
              \               /
               +-- E2E relay -+   Iroh public relays in Phase 0/test;
                                   stock self-hosted relays in production
```

Each client process/app owns one Iroh `Endpoint` for its lifetime and uses it
for both the stable hub-control connection and the selected workspace-child
connection. Each server process owns one persistent endpoint identity. The hub
does not proxy workspace data; `hubControl.routeWorkspace({workspaceId})`
returns the child's Iroh reach exactly as it returns the child's WebRTC reach
today.

The hub and child remain separate security and failure boundaries. Combining
them into one endpoint or turning the hub into a generic relay would make the
transport migration silently alter process isolation and data routing.

## Physical identity and durable state

An Iroh `EndpointId` is the public half of an Ed25519 key. Its secret key must be
stable across ordinary restarts.

### Server

- Persist one endpoint secret for the hub and one for each workspace child in
  their existing owned state directories, mode `0600` under a mode `0700`
  directory.
- Write atomically and fsync before advertising the corresponding Endpoint ID.
- Treat a missing secret plus an existing reach record, or a malformed secret,
  as state corruption. Fail loud; never generate a replacement identity behind
  a saved reach.
- A deliberate server-identity reset is an explicit destructive operation that
  invalidates all saved reaches and requires re-pairing.

### Client

- The endpoint secret belongs to the device credential, not to the install. A
  paired record stores exactly one Iroh secret beside its device credential, in
  the same encrypted credential boundary. Desktop and CLI already pair
  separately into separate credential stores, so they own separate endpoint
  identities and run concurrently without coordination.
- Exactly one live process binds a given credential's endpoint. The CLI's
  existing cross-process connection lock is re-scoped from the signaling room to
  the endpoint identity, so concurrent CLI invocations serialize exactly as they
  do today. Binding one secret from two processes would advertise one Endpoint
  ID from two endpoints and make relay routing and dial delivery ambiguous.
- iOS stores it in Keychain. Android stores it with the platform's encrypted
  credential facility.
- On mobile background, shut down the endpoint cleanly; on foreground, bind a
  new endpoint instance using the same secret. This follows Iroh's documented
  mobile lifecycle and keeps the Endpoint ID stable.
- A lost endpoint secret is equivalent to a lost device credential: clear the
  incomplete remote record and require fresh pairing.

### Bind endpoint identity to the device credential

The clean model uses both factors rather than leaving the Iroh client identity
as diagnostic decoration:

- fresh pairing observes the client's Endpoint ID only after the completed QUIC
  handshake;
- `DeviceRow` stores an explicit transport binding when the credential is
  issued: either `{ kind: "local" }` for the co-located loopback topology or
  `{ kind: "iroh", endpointId }` for remote transport;
- refresh authentication succeeds only when both the refresh secret and the
  live connection's Endpoint ID match;
- because the secret is owned by the credential rather than by the install,
  this stays one Endpoint ID per device row: there is no set-valued binding, no
  per-process identity, and no way for two credentials to share an endpoint;
- workspace children perform the same comparison through the shared read-only
  identity database;
- revocation remains device-credential revocation and immediately covers all
  reaches for that endpoint.

This is one credential-binding rule, not a second login channel. It makes a
copied refresh token insufficient by itself and prevents a local credential
from being replayed over Iroh. Represent the binding with an unambiguous SQL
kind plus an Endpoint ID constrained to be present only for `iroh`; do not use a
nullable Endpoint ID whose absence could mean either local or legacy. Because
the product is pre-release, change the current schema contract directly rather
than writing a legacy-device migration. The same endpoint binding must be
available to every auth entry point; if any path cannot prove the peer Endpoint
ID, that path is not remote authentication and must not accept an Iroh-bound
device credential.

## Reach and pairing protocol

Do not use raw Iroh `EndpointTicket` as the Vibestudio invite. Iroh tickets are
reusable by default, while Vibestudio invites are one-time, expiring security
capabilities.

Replace the current WebRTC reach with one strict schema:

```ts
interface IrohReach {
  endpointId: string;
  relays: readonly string[];
  v: 4;
}

interface ConnectPairing extends IrohReach {
  code: string;
  exp: number;
}
```

The exact protocol version is provisional until the Phase 0 wire spike freezes
it. The final codec must be canonical, bounded, reject unknown flags/fields,
and round-trip in TypeScript, Swift, and Kotlin tests.

- `endpointId` replaces room plus DTLS fingerprint. TLS authenticates possession
  of the corresponding key.
- `relays` is the ordered set of stable relay URLs appropriate for this server.
  It contains no secret and no n0 address-lookup dependency.
- `code` remains the independent one-time pairing secret.
- `exp` remains locally preflighted and authoritatively checked by the hub.
- There is no signaling URL, ICE policy, room derivation, or direct-address list.
  Ephemeral direct addresses are learned by Iroh and must not become durable
  pairing state.

The official `1.1.0` bindings expose a multi-entry `RelayMap` for endpoint
configuration but only one relay URL in each `EndpointAddr`. That is a physical
API shape, not a reason to weaken the durable reach:

- configure the endpoint with the complete ordered `relays` set and production
  address lookup disabled;
- for each dial attempt, construct an `EndpointAddr` from `endpointId` and one
  relay URL, selected from the ordered reach;
- allow only one connection attempt and one resulting physical connection at a
  time; on failure, the single reconnect coordinator advances to the next relay
  under one overall attempt deadline;
- remember the last successful relay only as a reconnect hint. It does not
  replace or reorder the durable advertised reach;
- once QUIC connects, Iroh remains free to discover and upgrade to a direct
  path. No ephemeral direct address is persisted or added to the link codec.

Cycling the addresses of one Iroh reach is connection establishment, not a
fallback transport, compatibility shim, or parallel path. The selection and
deadline algorithm lives once in the shared TypeScript connection owner; native
adapters receive one opaque dial operation at a time. Executable vectors assert
identical ordering, cancellation, and failure results for Node, Swift, and
Kotlin adapters.

The compact QR/deep-link representation stays a Vibestudio codec so its size and
security properties are under our control. A default production relay set may
be represented by a small relay-set identifier only if the identifier resolves
locally from shipped configuration and old identifiers remain intentionally
served. It must never silently select n0 infrastructure.

Pairing flow:

1. The hub creates the existing one-time invite and advertises its stable Iroh
   reach.
2. The client binds its persisted endpoint and the shared connection owner dials
   the hub Endpoint ID through the ordered advertised relay set.
3. Both sides wait for the complete TLS handshake.
4. The client opens the connection-control stream and redeems the pairing code.
5. The hub atomically consumes the code, creates a device credential bound to
   the client Endpoint ID, and returns the credential plus exact `workspaceId`.
6. The client durably stores endpoint secret, device credential, control reach,
   and workspace selection before declaring pairing complete.
7. Over the stable hub connection it calls `hubControl.routeWorkspace`; the
   returned child reach replaces only the saved workspace reach.

If durable storage fails after code redemption, report that the invite was
consumed and require a new invite. Do not retain a half-paired in-memory escape
path.

## QUIC application protocol

Use one versioned ALPN, provisionally `vibestudio-rpc/4`. ALPN mismatch rejects
the connection before application authentication. RPC contract compatibility
is still exact-matched at logical-session open; transport byte compatibility
does not imply service compatibility.

### Connection admission

Room arming disappears with signaling, so who may connect becomes an explicit
accept rule instead of an emergent property of the old rendezvous. Today a
workspace child accepts a connection only into a room the hub armed for one
device; an Iroh child endpoint is dialable by anyone who learns its Endpoint ID,
from any network, through the relays.

- A workspace child accepts only Endpoint IDs that appear as a device transport
  binding in the shared read-only identity database. The check runs when the
  handshake completes and before any stream is accepted; an unrecognized peer is
  closed with a QUIC application error code and never reaches the control
  stream.
- The hub is the only endpoint that accepts an unknown Endpoint ID, and only
  while at least one invite is open. Those connections stay under the pre-auth
  connection, stream, byte, and time budgets until a pairing code is redeemed.
- Revoking a device removes its binding, so admission and authorization revoke
  together.

This is admission, not authorization. An admitted connection still proves the
endpoint-bound device credential before any RPC is served, and admission alone
grants nothing.

### Connection-control stream

The dialing side opens the first bidirectional stream immediately after the
completed handshake. It is the only long-lived ordered control stream on the
connection, and it carries connection and session lifecycle only:

- connection hello and exact protocol/RPC contract versions;
- logical session open/result/close/closed;
- route metadata needed by existing logical-session recovery.

Frames use a fixed-width length prefix plus canonical compact payload encoding.
Every frame here is small and fixed in shape, so the maximum control-frame size
is a property of the lifecycle messages themselves rather than a budget that
application payloads must fit inside. Reject a frame before allocating its
declared body if the prefix exceeds the maximum. Nothing is ever fragmented onto
control.

Requests never travel on this stream. A unary RPC, a streaming RPC, and an event
watch each own a QUIC stream. One ordered stream shared by every logical session
would reintroduce the head-of-line blocking QUIC exists to remove, and would
turn each method's maximum response size into a transport concern enforced at
run time.

Remove transport keepalive `PING`/`PONG` unless the Phase 0 lifecycle test proves
that Iroh/QUIC cannot provide the required idle failure detection. Prefer Iroh's
connection closure and keepalive configuration. Do not retain an application
heartbeat by habit.

### One QUIC stream per request

Either peer may open a bidirectional stream. The sender writes a bounded header:

```ts
interface RpcStreamHeader {
  kind: "rpc-stream";
  sessionId: string;
  request: RpcEnvelope;
  hasBody: boolean;
}
```

If present, raw request-body bytes follow on the send half. Streaming RPCs use a
bounded response head followed by raw response-body bytes on the reverse half.
Unary results are FIN-delimited JSON payloads on that reverse half: reads and
writes use bounded working chunks, but there is no transport-wide total-size
ceiling. End of stream is the payload terminator. Errors use the same unary
payload, a bounded streaming response head, or a QUIC application error code;
cancellation maps to `reset`/`stop`. There are no application stream IDs,
DATA/END frames, bulk mux, base64 wire data, or shared-channel drain thresholds.

One shape covers every request:

- a unary RPC is the degenerate case: a bounded request header with
  `hasBody: false`, a FIN-delimited result, and no fixed result ceiling. A QUIC
  stream is cheap, so this costs a stream rather than a slot in a shared ordered
  queue, and a large unary response can never stall an unrelated session;
- an upload carries a request body; a finite response stream carries a response
  body; a duplex RPC carries both;
- an event watch is an RPC whose response body stays open. Its stream is the
  watch: per-watch ordering is the stream's ordering, and cancelling the watch
  is `reset`/`stop` on that stream;
- server-initiated direct delivery (`emitToCaller` and `emitToConnection`) uses
  an independent server-opened message stream. Its preamble is bounded; its
  envelope is FIN-delimited, so a large message cannot inherit the request
  header's allocation ceiling or block another session.

Response-body idle deadlines remain application semantics. Long-lived watches
opt out explicitly as they do now. Total-body limits remain owned by the RPC
method that understands the resource, not by the transport.
Concurrent-stream limits are set from the measured per-connection session and
request concurrency in WP1, not left at a binding default.

### Post-cutover stream-admission correction (2026-08-29)

The first cutover accidentally shipped the Phase 0 fixture value of 64 as the
physical connection's bidirectional-stream window. That confused two different
bounds. Long-lived event/CDP responses legitimately retain QUIC streams, so an
ordinary desktop could consume that provisional window; later panel assets and
short RPCs then blocked in `openBi()` and never reached the server. Increasing
the value only until the observed startup passed would preserve the design
error.

The corrected contract separates the layers:

- each physical connection admits at most 64 logical sessions;
- each logical session retains at most 256 active requests, a memory-abuse
  boundary deliberately above the desktop's complete expected fan-out;
- at most 128 streams per connection may remain in bounded-header admission at
  once; a successfully parsed request immediately leaves that budget even when
  its response is a long-lived watch;
- the native QUIC window is twice the complete application fan-out
  (`2 * 64 * 256 = 32768`), leaving control, cancellation, handoff, and stream
  retirement headroom. It is transport capacity, not a scheduler or the DoS
  boundary.

The native regression opens 96 retained streaming responses on one real QUIC
connection and proves that a concurrent burst of short RPCs still completes.
It failed with the escaped Phase 0 limit and passes with the separated bounds.
No shared mux, second connection, priority lane, or compatibility path is
introduced.

### Post-cutover payload-boundary correction (2026-08-29)

The first cutover also reused the 8 MiB request-header allocation bound for
unary results and server messages. A legitimate 19,378,028-byte chat bootstrap
response therefore reset its request stream; the adapter then compounded that
local failure by closing the entire logical panel session. Raising the number
would only move the defect to the next large result.

Wire version 5 separates those jobs. Peer-opened request headers remain bounded
and are rejected before allocation. Unary results and server-opened messages
are written in 256 KiB working chunks and terminated by QUIC FIN, with no fixed
total-size ceiling. The receiver reads incrementally under QUIC flow control and
assembles only the result its caller requested. A failed stream is request-local
and never closes its logical session. Large-result observations name the RPC
operation and byte count without logging the payload or rejecting it.

The native regression returns a 20 MiB unary result over real local Iroh while
an independent short RPC completes on another QUIC stream. This is both the
former ceiling regression and the head-of-line independence proof.

### Scheduling and fairness

Do not port the WebRTC 8:4:1 scheduler. QUIC provides independent streams and
flow control. Product-level priority remains at the work issuer:

- visible/interactive requests may start immediately;
- prefetch and background asset work has bounded lower concurrency;
- cancellation stops obsolete work at its source and resets its QUIC stream.

Only use a native QUIC stream-priority API if the same supported behavior is
proven in Node, Swift, and Kotlin. The current release set does not expose that
portable contract, so `trafficClass` remains producer-local and is absent from
the Iroh wire. A platform-specific priority path would recreate divergent
semantics and is rejected.

## Logical sessions and recovery

The transport replacement must preserve the contracts in
`docs/architecture/transport-sessions.md`:

- `callerId` is durable application identity;
- `connectionId` identifies one logical session incarnation and is never
  persisted;
- one physical connection carries multiple authenticated panel/shell/worker
  sessions;
- watched broadcast, caller-wide direct delivery, and connection-specific
  direct delivery remain distinct;
- resubscribe is state recovery; cold-recover is an edge-triggered server
  restart event;
- hub control reach stays stable while workspace reach changes.

Recovery layers are deliberately separated:

1. Iroh owns path changes and direct/relay transitions inside a live QUIC
   connection.
2. Physical connection loss fails all owned streams and logical-session
   instances exactly once.
3. A single reconnect coordinator dials the same reach with bounded exponential
   backoff and jitter.
4. After a new connection handshake, the existing logical-session manager
   reopens desired sessions and resubscribes state.
5. A changed `serverBootId` emits one cold-recover edge; a same-boot reconnect
   does not.

There is no application ICE restart, signaling-room refresh, or second physical
transport. Unknown/stale logical-session frames still fail the affected session
or connection according to the existing protocol invariant; they never cause a
WebRTC-shaped repair path.

## Platform integration

### Node/Electron/server/CLI

- Add pinned `@number0/iroh` N-API binaries for supported Node targets.
- Package the native artifact through the existing Electron and server native
  dependency pipeline; verify signing, notarization, ASAR unpacking, pnpm
  deployment, installed CLI startup, and source checkout startup.
- Construct endpoints with a fixed secret, exact ALPN, explicit relay mode, and
  production address-lookup disabled. Never call the default `Endpoint.bind()`
  path from product code.
- Create one small physical adapter around endpoint/connection/stream lifecycle.
  The shared session protocol above remains TypeScript and is used by server,
  desktop, and CLI.
- Remove macOS x64 artifacts and targets from Electron Builder, CI, download
  metadata, updater policy, and documentation in the same cutover.

### iOS

- Add the official pinned `IrohLib` XCFramework/Swift package and
  `Network.framework` linkage.
- Implement the same narrow native endpoint/connection/stream adapter used by
  the React Native app, with the endpoint secret in Keychain.
- Verify physical device and simulator builds, foreground/background shutdown
  and rebind, network-interface changes, direct path, relayed path, cancellation,
  and app termination during an active stream.

### Android

Use the official pinned `computer.iroh:iroh-android` AAR from Maven Central.
The inspected `1.1.0` artifact contains `arm64-v8a`, `armeabi-v7a`, `x86`, and
`x86_64` native libraries, so a repository-owned rebuild of unchanged upstream
source would add supply-chain machinery without adding trust. Gradle dependency
verification pins the artifact digest and provenance; CI verifies the required
ABIs from a clean cache and the app loads it on physical arm64 hardware.

Unacceptable outcomes:

- a Vibestudio fork of Iroh;
- an unpinned prebuilt binary copied from a developer machine;
- rebuilding or republishing the official AAR without a demonstrated upstream
  artifact defect;
- JavaScript N-API inside React Native;
- WebRTC retained only on Android;
- a second protocol implemented natively for mobile.

If the official verified AAR is missing a required ABI, cannot load reliably,
or cannot be traced to the pinned FFI release, stop the migration and reassess
Iroh. Do not patch around the failed platform boundary with an opaque or
Vibestudio-built substitute.

### React Native bridge contract

Iroh does not automatically solve React Native bridge copying. Keep one shared
TypeScript logical-session protocol and expose only a narrow pull-based native
physical API:

- bind/shutdown endpoint;
- dial/accept connection and report authenticated peer Endpoint ID;
- open/accept stream;
- bounded read/write/finish/reset/stop by opaque handle;
- connection/path/close events;
- no unsolicited body-chunk flood into JavaScript.

Small control frames may cross the existing bridge normally. Stream reads are
pulled under JavaScript backpressure with bounded chunks. The durable mobile
asset store keeps warm asset delivery native-to-loopback and therefore at zero
remote bytes; the cold path is measured on physical devices.

Phase 0 must prove that this one bridge contract meets memory, throughput,
latency, cancellation, and backgrounding gates on the current React Native old
architecture. If it does not, the result is a design blocker. Do not add a JSI
fast path beside it or duplicate the session protocol in Swift/Kotlin. A future
New Architecture migration would be a separately justified prerequisite, not a
hidden fallback in this transport change.

## Relay and discovery deployment

### Phase 0 and automated testing

Use Iroh's existing public relays for the initial cross-network spike and
developer test environments. They require no account or service setup and are
explicitly recommended upstream for development/testing. Tests must record
which public relay was used and must not make production readiness claims from
public-relay availability or performance.

Unit and deterministic integration tests may also launch the exact pinned
`iroh-relay` binary as an owned local fixture. This exercises the real relay
protocol, not a fake relay or transport mock. The fixture is always terminated
and awaited in cleanup.

### Production

Run the stock pinned `iroh-relay` binary on conventional public compute: a small
VM or a normal container host with public IP/DNS, inbound TCP 443, TCP 80 when
using its built-in HTTP-01 ACME flow, and the configured UDP/QUIC
address-discovery port. Start with at least two stateless relays in different
regions; use different providers only when the added operational surface is
justified. Use stable DNS names, health checks, per-client
bandwidth/connection limits, metrics, logs, and an explicit capacity/runbook
owner.

This avoids an Iroh Services subscription or user account setup; it does not
pretend production relay compute and bandwidth are free. Those are ordinary
Vibestudio-operated infrastructure costs.

Cloudflare may host DNS records in **DNS-only** mode. It is not the relay data
plane:

- Workers cannot run the native Rust server or accept arbitrary inbound TCP/UDP;
- Cloudflare Containers are reached through Worker HTTP/WebSocket ingress and
  currently do not accept end-user UDP;
- a WebSocket-only Container deployment would be a paid, provider-specific,
  degraded topology and is not the production design;
- Cloudflare Tunnel also requires an origin process and does not replace the
  public UDP listener.

The relay remains end-to-end blind and stateless, but an unauthenticated public
relay can be abused. Before production, choose and prove one supported admission
model using stock `iroh-relay` facilities:

1. preferred: its HTTP access-control hook authorizes Endpoint IDs against a
   minimal Vibestudio-operated registry, including a coherent bootstrap flow;
2. temporary public beta only: open relay with strict connection/byte limits,
   abuse monitoring, and an explicit capacity ceiling.

Do not embed one global long-lived relay token in every application. Do not let
relay authorization become application authorization: the hub still validates
the endpoint-bound device credential. The registry's initial-admission flow must
be designed as an explicit bootstrap protocol; it must not smuggle application
RPC, assets, or a second remote transport through the callback relay. If the
stock hook cannot support fresh pairing and returning devices without that
architectural split, authenticated production relay deployment is blocked even
though Phase 0 can continue on public relays.

### No production address lookup dependency

Disable n0 address lookup and public-relay presets in production. Persist the
server Endpoint ID and its stable ordered relay set. The shared connection owner
dials one advertised relay address at a time, while Iroh learns and upgrades to
direct addresses dynamically after connection. A server endpoint may keep only
one active home relay and may need time to select another after a sustained
outage; the reconnect bound must include and expose that behavior rather than
assuming seamless live migration. Phase 0 must prove restart, readdressing, NAT
traversal, and multi-relay reconnection with no n0 address lookup before this
reach schema is frozen.

## Observability and operations

Replace ICE/signaling diagnostics with one Iroh connection record:

- local and remote Endpoint IDs (safe abbreviated form in ordinary logs);
- reach role: hub control or exact workspace ID;
- connect attempt/generation and timing phases;
- active path: direct or relayed;
- relay URL/region when relayed;
- path transitions and RTT where exposed;
- authenticated device/caller only after auth succeeds;
- open stream counts and bounded byte totals by RPC method/category;
- close source, QUIC/application error code, retry delay, recovery result;
- endpoint online/offline and relay registration state.

Never log endpoint secret keys, refresh tokens, pairing codes, full invite URLs,
relay capabilities, RPC bodies, or full trajectory artifacts. Metrics labels
must not contain user, device, endpoint, workspace, or request IDs.

Add a remote-transport doctor that verifies:

- endpoint-secret existence/permissions and derived advertised ID;
- explicit production relay configuration and absence of n0 defaults;
- relay registration and ALPN acceptance;
- device credential endpoint binding;
- one bounded direct/relayed probe where the environment permits it;
- native artifact availability for the running target;
- no installed WebRTC/signaling/TURN dependencies or config.

Relay fallback must emit a normal structured event/metric, not a warning that
teaches operators to treat valid restrictive-network behavior as failure.
Failure to reach any configured relay is an error.

## Performance evidence plan

Static complexity is the reason to replace the architecture, not evidence that
the new path is faster. Use the repository-native performance system and
measure exact user-visible boundaries.

### Baseline before deleting WebRTC

On one owned, isolated managed instance and fixed hardware/network profiles,
capture:

1. cold fresh pairing: link activation to usable workspace shell;
2. warm launch: app activation to usable selected workspace;
3. control latency: a representative interactive RPC to visible completion;
4. cold panel open: action to panel ready, including remote asset miss;
5. warm panel open/reload: durable asset hit to panel ready;
6. large asset download and upload throughput with concurrent control RPCs;
7. reconnect after Wi-Fi/interface change;
8. reconnect after relay loss and after server restart;
9. Electron/server CPU, RSS, heap, event-loop, and native process resources
   over those bounded operations;
10. physical Android and iOS cold/warm startup, peak memory, JS/native bridge
    traffic, and asset transfer.

Record whether each run is direct or relayed. Direct and relayed results are
different experiments. Do not combine them into an average.

### Repeat after Iroh

Run the exact same semantic actions and completion conditions. Use panel
profiling for visible panel boundaries, startup profiles for startup phases,
host profiling for server resources, Electron snapshots for client resources,
and the mobile build/readiness/native tools described by the performance skill.

Minimum acceptance:

- no statistically credible regression in interactive RPC or warm panel-ready
  latency on either direct or relayed paths;
- control progress remains bounded during a saturated asset transfer;
- memory remains bounded under concurrent and cancelled streams;
- warm mobile asset delivery remains zero remote bytes;
- reconnect correctness is unchanged and path-change recovery improves or is
  neutral;
- cold mobile transfer has no dropped/corrupted chunks and meets a threshold
  fixed from the WebRTC baseline before implementation tuning;
- startup/native-load cost is attributed and accepted explicitly.

After the architectural cutover is correct, profile any regression, rank its
measured contributors, fix the owner, and repeat the same experiment. Do not
add a lightweight alternate path.

### Recorded startup evidence

The native startup profiler captured the same fresh isolated-server boundary
before and after the cutover on 2026-08-28:

| Measurement            | WebRTC baseline | Initial Iroh | Overlapped Iroh | Latest change |
| ---------------------- | --------------: | -----------: | --------------: | ------------: |
| Semantic activation    |     3327.196 ms |  4072.102 ms |     3605.855 ms |         +8.4% |
| Semantic lifecycle     |     3518.522 ms |  4193.212 ms |     3770.473 ms |         +7.2% |
| Reconciliation         |           26 ms |        45 ms |           27 ms |               |
| Responsiveness p99     |        106.9 ms |      59.9 ms |         81.7 ms |               |
| Responsiveness maximum |        469.8 ms |     401.1 ms |        359.4 ms |               |
| Event-loop utilization |           0.662 |        0.564 |           0.614 |               |

The post-cutover run used the explicit ordered Phase-0 public relay set because
the future Vibestudio production DNS names are intentionally not provisioned
yet. Attribution measured approximately 13 ms to load the native binding, 21 ms
to bind, and 726 ms to become online through the public relays. The initial
implementation serialized that network wait after the service graph. Iroh
ingress is now an ordinary service depending only on `rpcServer`, so relay
registration overlaps the longer semantic/build critical path while readiness
still waits for it; the service report proves it completed about 900 ms after
its dependency and long before the 76-service graph finished.

The optimized single run is materially better but cannot establish statistical
equivalence to a single historical baseline: its remaining time is dominated by
semantic snapshot import, which varied independently of Iroh. Concurrent
responsiveness also remains better than the baseline. The release gate is now a
repeated cold/warm sample on fixed source/hardware/network state; investigate
only a credible residual delta. This evidence does not support adding an
alternate transport path.

## Phase 0: feasibility spike and go/no-go gates

This phase is throwaway evidence, not a product dual stack. It may live on a
short-lived branch and must be deleted or folded into the final implementation.
It uses public Iroh relays where a remote relay is needed.

Build a minimal protocol fixture from the complete provisional release set
above. It connects the actual supported platform pairs and exercises raw
bidirectional streams. It does not route Vibestudio RPC yet. Record both the
distribution version and embedded Rust-core version in every artifact and test
result so a package-label match can never masquerade as core-version parity.

All gates must pass:

| Gate                       | Required evidence                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node packaging             | Electron/server/CLI load the pinned N-API binary from packaged artifacts on macOS arm64, Linux x64/arm64, and Windows x64/arm64.                                                                                                                                           |
| Android supply chain       | Official AAR provenance/digest verifies from a clean cache, contains every supported ABI, and loads in the packaged app on physical arm64 hardware.                                                                                                                        |
| iOS packaging              | Pinned XCFramework builds for simulator/device, signs, launches, and survives archive/export.                                                                                                                                                                              |
| Shared protocol primitives | Every binding can bind with a fixed secret/ALPN, dial/accept, report peer ID, open/accept bidi streams, perform bounded reads/writes, finish/reset/stop, observe closure, and shut down.                                                                                   |
| Mobile bridge              | Pull-based handles remain bounded and lossless under slow JS, cancellation, 100+ MiB transfer, background/foreground, and process restart.                                                                                                                                 |
| No n0 address lookup       | The ordered two-relay reach plus Endpoint ID reconnects after server/client restart and IP change by dialing one binding-compatible relay address at a time, with n0 lookup disabled.                                                                                      |
| Direct path                | At least the current required home/mobile network matrix upgrades to direct where expected and reports the path correctly.                                                                                                                                                 |
| Restrictive path           | Outbound HTTPS-only conditions establish and sustain the relayed path.                                                                                                                                                                                                     |
| Relay failover             | Before the test, fix a maximum outage/reconnect bound from product recovery requirements. Killing the active/home relay reconnects the one physical connection through the second relay within it; record whether live migration occurred and regression-test issue #4319. |
| Auth timing                | No binding early-data API is called or exposed; both peers await full-handshake completion and verified peer ID before application I/O; replay attempts cannot consume an invite.                                                                                          |
| Resource bounds            | Connection/stream flood, oversized prefix/header, stalled reader/writer, and cancellation stay within fixed memory/task limits.                                                                                                                                            |

Go only when all platform and network gates pass on one exact release set. A
failure triggers evaluation of one newer aligned upstream set, a first-principles
redesign, or rejection of Iroh; it does not earn a platform exception and
results from different sets are never combined.

### Phase 0 and implementation execution record

The transport kernel lives in `packages/iroh-transport` and the product cutover
uses the provisional release set. As of 2026-08-28 it proves on local Linux:

- explicit endpoint construction with fixed secrets, the exact
  `vibestudio-rpc/4` ALPN, no default n0 relay/discovery preset, and full
  handshake peer-ID verification;
- one bidirectional stream per request, bounded big-endian control/request-head
  framing, FIN-delimited result payloads, rejection before allocation for an
  oversized header declaration, stream reset/stop, and
  progress on an unrelated stream while another stream is stalled;
- executable ordered-relay vectors for one sequential attempt, one overall
  deadline, and a nondurable last-success hint;
- exact npm wrapper and optional-package integrities, mobile artifact digests,
  embedded core version, and relay binary digests in an executable release-set
  manifest;
- absence of an exposed early-data method in the selected JavaScript binding.

The focused transport suite passes 71 tests across 16 files, with another 16
tests across the deployment/doctor/pairing operational surfaces. The pinned
stock relay integration command launches and owns `iroh-relay@1.0.2`, registers
two real endpoints, proves bidirectional traffic traversed the relay, exchanges
a QUIC stream, and terminates the relay in cleanup. Package TypeScript,
formatting, dependency ownership, native-artifact checks, host/Base boundary
checks, and the retired-transport absence guard also pass. These are local
Linux results, not substitutes for the retained cross-platform and physical
device matrix.

`@number0/iroh@1.1.0` publishes root
`index.js` and `index.d.ts` files, but its manifest declares nonexistent
`iroh-js/index.js` and `iroh-js/index.d.ts` entries. Node falls back with a
deprecation warning; strict static resolvers reject the package. A registry
check on 2026-08-28 found no release newer than `1.1.0`, so the plan's one-newer-
aligned-set evaluation cannot yet be run. Vibestudio's existing host-native
external loader now resolves the immutable package coordinate to the published
root entry in both ESM tests and bundled CJS, while deliberately keeping native
code outside static bundles. Staged server/app npm packages build without the
fallback warning, both publish dry-runs pass, and packaged import/executable
smokes prove the native binary is copied and loadable on the current target. No
manifest rewrite or package fork is introduced. The other retained OS/ABI
package loads remain release gates.

The binding exposes no per-attempt cancel method, so cancellation belongs to
the one process-wide endpoint-generation owner. When a dial deadline expires it
closes the current endpoint, which deterministically rejects the real native
dial, closes every connection in that generation, and then rebinds the same
secret before reconnecting the owned hub/workspace sessions. This is one atomic
recovery transition, not an abandoned promise or parallel attempt. The local
fixture proves cancellation plus stable identity after rebind; the observed
close/cancel duration becomes part of the measured reconnect bound.

The repository implementation completes the code-owned workstreams in two
separate branches/worktrees:

- host: shared QUIC RPC/session/reconnect kernel, endpoint-bound identity and
  auth, hub/child ingress and reaches, desktop/CLI/mobile host adapters,
  Swift/Kotlin native modules, packaging, deployment tools, doctor, endpoint
  rotation, relay fixture, observability, and bounded relay-online startup;
- Base: mobile connection owner and lifecycle integration, endpoint/relay
  schemas, direct concurrent QUIC asset streams, desktop diagnostics, and all
  current mobile/operator/developer guidance;
- deletion: signaling Worker/rooms, TURN/ICE/DTLS state, WebRTC clients and
  servers, DataChannel framing/multiplexing/QoS, React Native WebRTC, obsolete
  smoke/deployment scripts and superseded transport documents—over 42,000 lines
  removed rather than retained behind flags or adapters;
- verification: host and Base semantic type checks, 317 Base mobile tests,
  lint/format, dependency and native-host contracts, staging/build/import and
  npm dry-run packaging, and host-plus-Base cutover absence checks are green.

The managed system-test owner now injects the explicit ordered public Phase-0
relay set and no longer inherits unprovisioned product DNS. Its isolated doctor
run provisioned and paired a ready workspace; startup preparation then stopped
at the configured Codex model with `needs-setup`. The exact managed instance was
stopped. Deeper agentic product tests require that external model credential.

The remaining gates are deliberately not papered over by repository code:

1. provision two real production relays and prove TLS/DNS, admission, limits,
   metrics, load, outage, and ordered failover with public n0 infrastructure
   disabled;
2. build/load/sign/archive on every retained desktop/server target and run the
   physical Android/iOS lifecycle, network-change, pressure, cancellation, and
   performance matrix (Android SDK and Apple/Xcode hardware are unavailable in
   this Linux environment);
3. repeat the identical native startup profile enough times to distinguish the
   residual semantic-import variance from a credible regression, then repair
   any measured owner or accept the result explicitly;
4. provide a usable managed-system-test model credential and run the smallest
   exact remote behavior tests.

## Implementation workstreams

### WP1 — Freeze contracts and baseline

1. Capture and archive the WebRTC performance baseline above.
2. Inventory every remote call and classify it unary, finite stream, upload,
   duplex/long-lived, or event watch.
3. Measure current lifecycle-frame sizes and per-connection session/request
   concurrency to set the control-frame bound and the concurrent-stream limit
   before coding.
4. Freeze supported OS/ABI matrix without macOS x64.
5. Freeze the successful binding distribution versions, embedded Iroh core
   versions, relay version, source identities, and artifact checksums as one
   indivisible release-set manifest.
6. Write the wire protocol, error-code registry, connection state machine,
   shutdown ownership, and threat model as executable test vectors.

Exit: bounds and behavior are evidence-backed; dependency/package gates pass.

### WP2 — Shared Iroh transport kernel

1. Replace WebRTC-specific session negotiation with a transport-neutral remote
   session protocol containing only live logical-session semantics.
2. Implement canonical lifecycle control framing and the per-request stream
   header codec; no request or event rides the control stream.
3. Implement one connection lifecycle/reconnect owner and adapt it to
   `EnvelopeRpcTransport`.
4. Map stream cancellation, deadlines, connection closure, server boot changes,
   resubscribe, and cold recovery.
5. Delete QoS lanes from the model; retain only producer-side bounded
   concurrency where product semantics require it.
6. Add protocol/property/fuzz tests for malformed and partial input.

Exit: an in-process Node client/server passes all logical-session and streaming
contract tests over real local Iroh QUIC, with no WebRTC modules imported.

### WP3 — Server, hub, and workspace reaches

1. Persist hub/child endpoint secrets and publish readiness only after endpoint
   bind, relay online state, ALPN accept loop, and authenticated ingress are
   ready.
2. Replace room arming/routed-room files with stable typed Iroh reach records
   plus the accept-time admission rule: children admit only bound Endpoint IDs
   from the read-only identity database, and only the hub admits an unknown
   endpoint while an invite is open.
3. Accept one control stream per connection and enforce pre-auth limits.
4. Thread the authenticated peer Endpoint ID into every remote auth decision.
5. Add the checked `DeviceRow` transport-binding union and enforce local versus
   endpoint-bound refresh validation in hub and read-only workspace child.
6. Return child Iroh reach from `routeWorkspace`; retain exact workspace ID
   routing and no hub data proxy.
7. Replace server health/doctor/ready records and supervisor diagnostics.

Exit: hub pairing, route, child auth, restart, revocation, and workspace switch
pass over Iroh on an isolated managed instance.

### WP4 — Desktop and CLI

1. Replace desktop/CLI WebRTC clients with the shared Iroh connection owner.
2. Replace stored remote schema atomically; an old WebRTC record produces a
   clear re-pair state and is removed, never translated.
3. Persist the per-credential endpoint secret and its endpoint-bound device
   credential as one valid/invalid unit, and re-scope the CLI's cross-process
   connection lock from the signaling room to the endpoint identity.
4. Replace connection UI, diagnostics, pair-link parsing, CLI output, and
   deployment configuration terminology.
5. Package/sign/notarize the pinned native library and remove macOS x64.

Exit: fresh pairing, warm reconnect, workspace switching, panels, streaming,
revocation, updates, and installed CLI work on every retained desktop target.

### WP5 — Mobile native adapters

1. Remove `@vibestudio/mobile-webrtc` and `react-native-webrtc` from the Base
   mobile application and native projects.
2. Integrate the pinned Swift XCFramework and verified official Android AAR.
3. Implement the one pull-based endpoint/connection/stream bridge contract on
   both platforms with identical JS semantics and conformance tests.
4. Persist endpoint secrets securely and make foreground/background lifecycle
   explicit.
5. Adapt the shared TypeScript transport owner; do not fork the wire/session
   protocol by platform.
6. Preserve the durable asset store and native warm-hit socket write path;
   replace only its remote miss source.
7. Run physical-device loss, pressure, cancellation, network-change, lifecycle,
   and cold/warm performance tests.

Exit: iOS and Android pass the same remote behavior suite and the physical
mobile performance gates.

### WP6 — Relay, deployment, and operations

1. Add an owned local relay fixture pinned to the application dependency.
2. Provision two production-class stock relays on conventional public compute;
   configure stable DNS-only names, TLS, UDP/QUIC, limits, metrics, and logs.
3. Prove the chosen stock relay admission model, including first pairing,
   returning device, rotation, revocation timing, and abuse limits.
4. Add direct/relayed/failover diagnostics and alerts.
5. Replace WebRTC deployment docs and scripts; retain callback-relay deployment
   independently.
6. Add capacity, upgrade, rollback-before-cutover, outage, and key-rotation
   runbooks. Relay upgrades roll one stateless region at a time.

Exit: the self-hosted two-relay topology passes the Phase 0 network gates and
load/capacity test with n0 infrastructure disabled.

### WP7 — Atomic cutover and deletion

Merge only after WPs 1–6 are green. In the cutover change:

1. make Iroh the sole remote transport;
2. invalidate/remove WebRTC stored reach state with explicit re-pair UX;
3. delete all WebRTC production, test, deployment, build, and documentation
   surfaces listed below;
4. remove signaling and TURN deployment from the application infrastructure;
5. remove macOS x64 release metadata;
6. run the focused conventional, managed-system, platform, packaging, security,
   and performance verification;
7. stop every owned managed instance, relay fixture, mobile inspector, page,
   and profiler in cleanup.

There is no post-merge WebRTC rollback path. Before cutover, rollback means
revert the branch. After cutover, repair Iroh or revert the entire cutover while
the product is still pre-release; never ship both transports.

## Verification matrix

### Protocol and security

- exact ALPN and RPC contract match; unknown versions fail before invite use;
- Endpoint ID/key persistence and mismatch handling;
- one-time invite expiry, atomic redemption, replay rejection, storage failure;
- refresh token plus live Endpoint ID required at hub and child;
- local-bound credentials rejected over Iroh and Iroh-bound credentials rejected
  by the local loopback authentication surface;
- revoked device rejected on new sessions and active-session policy unchanged;
- unauthenticated connection/stream/byte/time budgets;
- oversized, truncated, reordered-at-application, unknown, and malformed frames;
- stream reset/stop in both directions; deadline and body-idle behavior;
- no 0-RTT/early-data API called or exposed, and no application bytes sent or
  processed before full-handshake completion and peer Endpoint ID verification;
- child rejects an unbound Endpoint ID at handshake completion; hub admits an
  unknown endpoint only while an invite is open; revocation removes admission;
- head-of-line independence: a saturated stream does not delay an unrelated
  unary RPC, watch, or session lifecycle frame on the same connection;
- log/metric secret and cardinality audit.

### Network and recovery

- same LAN, ordinary NAT, carrier NAT, symmetric/restrictive NAT, IPv4-only,
  IPv6-only/dual-stack where supported, corporate HTTPS-only egress;
- direct, relayed, and direct-to-relayed/relayed-to-direct path changes;
- Wi-Fi to cellular, sleep/wake, laptop interface changes;
- first relay loss, second relay loss, relay recovery, and both-relays-down;
- client restart, hub restart, child restart, server identity corruption/reset;
- concurrent hub and workspace connections from one client endpoint;
- same caller on multiple live client connections;
- resubscribe without false cold-recover; exact one cold-recover on boot change.

### RPC and product behavior

- unary RPC, finite response stream, upload body, cancellation, long-lived event
  watch, server-to-client event, caller-wide and connection-specific delivery;
- fresh pairing, warm reconnect, switching workspace, invitation target routing,
  device rename/revoke/sign-out;
- panel bootstrap, build, assets, blobstore, proxy fetch, large artifacts;
- OAuth and webhooks still use the unchanged callback relay;
- local co-located loopback mode remains isolated from Iroh configuration.

### Resource and packaging

- stream/connection flood limits, stalled peer, slow JS/native consumer,
  concurrent large transfers, cancellation cleanup, long soak;
- Electron packaged apps, installed server/CLI, dev checkout, auto-update on all
  retained targets;
- Android supported ABIs and physical arm64; iOS simulator/device/archive;
- native dependency license/SBOM, checksums, signing/notarization, clean install;
- absence tests ensure forbidden WebRTC packages, globals, permissions, URL
  schemes, environment variables, and build artifacts are gone.

Use the smallest exact managed system tests first. On failure, inspect the run
and trajectory as required by `AGENTS.md`, repair the owning layer, and rerun
only affected coverage. Always stop the exact managed instance afterward.

## Deletion register

The implementation inventory must be refreshed immediately before cutover, but
the deletion is organized by responsibility rather than preserving file names.

### RPC and session transport

- `packages/rpc/src/transports/webrtc*`;
- DataChannel contracts and channel I/O;
- control fragmentation/defragmentation/sequencing;
- bulk mux and stream-ID maps;
- weighted frame scheduler, receive-window/AIMD, channel lanes, WebRTC QoS;
- WebRTC signaling client and SDP/ICE types;
- WebRTC answerer/client tests and WebRTC-only session shim.

Any genuinely transport-neutral logical-session logic is renamed and moved
before deletion. A candidate that still depends on DataChannels, SCTP, ICE,
signaling rooms, DTLS fingerprints, or WebRTC is not transport-neutral.

### Host clients and servers

- `src/server/webrtcIngress.ts`, `src/server/webrtcSessionShim.ts`, and tests;
- `src/main/webrtcServerClient.ts` and WebRTC session/client wiring;
- CLI WebRTC clients, flags, URL handling, and test harness. The cross-process
  connection lock survives as an endpoint-identity lock: it is renamed and
  re-keyed from the signaling room, not deleted;
- `src/node/webrtc/` and all native WebRTC loading/packaging helpers;
- stable DTLS certificate state and fingerprint advertisement;
- routed signaling-room state and room arming;
- signaling/ICE/TURN health and readiness fields.

### Mobile

- host `packages/mobile-webrtc`;
- Base dependency `@vibestudio/mobile-webrtc`;
- `react-native-webrtc` dependency, pods, Gradle/autolink outputs, permissions,
  keep rules, patches, and native setup;
- DataChannel push-event bridge and WebRTC-specific mobile transport tests;
- comments/policies that name WebRTC as the allowed mobile boundary.

The durable asset store and `react-native-tcp-socket` warm-hit behavior are not
WebRTC and remain unless separately redesigned with evidence.

### Infrastructure, config, and docs

- the signaling Worker/Durable Object app and deployment;
- TURN credential minting and Cloudflare Realtime TURN setup;
- `DEFAULT_SIGNAL_URL`, `--signal-url`, local-signaling switches,
  `VIBESTUDIO_WEBRTC_*`, ICE/relay-only flags, and compatibility aliases;
- `webrtc://` pseudo-URLs and WebRTC reach records;
- WebRTC native packaging scripts and platform artifacts;
- WebRTC deployment, local E2E, ICE restart, remediation, QoS, implementation
  log, and superseded plan docs after useful historical decisions are either
  incorporated here or moved to an explicitly archival location.

The callback relay, its Durable Objects, OAuth landing, webhook buffering, and
public `vibestudio.app` link host are retained. Their coexistence with Iroh does
not make them a transport fallback.

### Required absence checks

At cutover completion, repository-wide checks must find no live production or
build references to:

```text
WebRTC RTCPeerConnection RTCDataChannel react-native-webrtc node-datachannel
SCTP webrtc://
VIBESTUDIO_WEBRTC DEFAULT_SIGNAL_URL
```

Historical changelogs may retain prose only if they are clearly archival and
excluded from current operator/developer guidance. Package lockfiles, native
projects, generated manifests, deployment config, CI, release metadata, and the
external Base mobile application are part of the absence check. Separate schema
tests assert that current reach/config records contain no `room`, `fp`, `sig`,
`ice`, SDP, STUN, TURN, or signaling fields; those generic words are not used as
repository-wide text patterns because they have unrelated meanings elsewhere.

## User-visible and operator-visible behavior changes

| Area                    | New behavior                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Existing remote pairing | Old WebRTC pairings are unsupported; the app explains that re-pairing is required.                                       |
| Pair link               | Carries server Endpoint ID, relay set, one-time code, expiry, and protocol version; no fingerprint/signaling/ICE fields. |
| Connection status       | Shows connecting/direct/relayed/reconnecting/offline plus relay region when useful, not ICE states.                      |
| Network changes         | Iroh path management handles live changes; physical reconnect preserves logical recovery semantics.                      |
| Security                | Returning auth requires refresh credential and the originally paired client Endpoint key.                                |
| Mobile background       | Endpoint shuts down and reconnects on foreground; no promise of indefinite background reachability.                      |
| macOS Intel             | No build, updater artifact, or support claim.                                                                            |
| Developer setup         | Public Iroh relays are sufficient for the spike/tests; no signaling/TURN account setup.                                  |
| Production operations   | Two stock self-hosted Iroh relays on ordinary public compute; Cloudflare is DNS/callback infrastructure only.            |

## Risks and stop conditions

| Risk                                                                              | Stop condition / required response                                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Android AAR is incomplete, unverifiable, or fails to load                | Stop; do not retain WebRTC, rebuild upstream casually, or ship an opaque binary. Evaluate one newer aligned official release set or reassess Iroh. |
| React Native bridge cannot meet bounded cold-path performance                     | Stop and re-derive the mobile architecture; no JSI side channel or native protocol duplication.                                                    |
| Multi-relay failover stalls or loses reachability                                 | Stop production adoption until one exact upstream release set and topology passes the forced outage gate.                                          |
| Endpoint ID plus relay URLs cannot reconnect without n0 lookup after readdressing | Redesign the durable reach/discovery model before freezing the pairing codec; do not silently enable public lookup.                                |
| Stock relay admission cannot cleanly support initial and returning clients        | Phase 0 may use public relays, but production is blocked. Do not embed a global application token.                                                 |
| Iroh native load/startup materially regresses user-visible readiness              | Profile and repair ownership/laziness. Reject the cutover if the single implementation cannot meet the agreed bound.                               |
| A required RPC cannot map cleanly to control or one QUIC stream                   | Re-derive that RPC boundary. Do not add a mux lane or secondary transport.                                                                         |
| Callback relay is mistaken for a transport fallback                               | Keep its third-party HTTP purpose and deployment ownership explicit; no app RPC or assets may flow through it.                                     |

## Completion criteria

The migration is complete only when:

1. every retained platform passes Phase 0 and the full behavior/security matrix
   on one exact binding/core/relay release set;
2. desktop, mobile, CLI, hub, and child use the same logical protocol and Iroh is
   the sole remote physical transport;
3. production works through two self-hosted stock relays with n0 lookup/public
   relays disabled, or production shipment remains explicitly blocked;
4. direct/relayed paths, failover, recovery, resource bounds, and endpoint-bound
   auth are observable and tested;
5. native performance measurements meet the precommitted gates;
6. every item in the deletion register and absence checks is satisfied;
7. macOS x64 release/support surfaces are removed;
8. current architecture, deployment, CLI, mobile, security, state-directory,
   build, and operator docs describe only the surviving design;
9. all owned test instances, relay fixtures, pages, inspectors, profilers, and
   mobile sessions are closed in final cleanup.

## Upstream references checked for this plan

- Iroh endpoints and persistent identity:
  <https://docs.iroh.computer/concepts/endpoints>
- QUIC streams, cancellation, and early-data warning:
  <https://docs.iroh.computer/protocols/using-quic>
- JavaScript bindings and platform matrix:
  <https://docs.iroh.computer/languages/javascript>
- Kotlin/Android bindings and lifecycle:
  <https://docs.iroh.computer/languages/kotlin>
- Swift/iOS XCFramework and persistence:
  <https://docs.iroh.computer/languages/swift>
- custom/self-hosted relay configuration:
  <https://docs.iroh.computer/deployment/dedicated-infrastructure>
- official relay server and access/rate-limit configuration:
  <https://github.com/n0-computer/iroh/blob/main/iroh-relay/src/main.rs>
- provisional matching relay release `1.0.2`:
  <https://github.com/n0-computer/iroh/releases/tag/v1.0.2>
- Iroh core release `1.1.0` (not embedded by FFI `1.1.0`):
  <https://github.com/n0-computer/iroh/releases/tag/v1.1.0>
- official FFI/binding release `1.1.0` and its pinned lockfile:
  <https://github.com/n0-computer/iroh-ffi/releases/tag/v1.1.0>
  <https://github.com/n0-computer/iroh-ffi/blob/v1.1.0/Cargo.lock>
- official Android AAR:
  <https://repo1.maven.org/maven2/computer/iroh/iroh-android/1.1.0/>
- FFI `EndpointAddr` single-relay surface and core multi-address type:
  <https://github.com/n0-computer/iroh-ffi/blob/v1.1.0/src/net.rs>
  <https://github.com/n0-computer/iroh/blob/v1.1.0/iroh-base/src/endpoint_addr.rs>
- forced relay-failover regression to cover:
  <https://github.com/n0-computer/iroh/issues/4319>
- Cloudflare Worker protocol constraints:
  <https://developers.cloudflare.com/workers/reference/protocols/>
- Cloudflare Container ingress constraint:
  <https://developers.cloudflare.com/containers/platform-details/architecture/>

These references establish feasibility and known constraints. The Phase 0 tests,
not upstream documentation alone, decide whether the pinned implementation is
fit for Vibestudio.
