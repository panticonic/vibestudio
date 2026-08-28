# Iroh transport sessions and recovery

Remote Vibestudio uses one authenticated Iroh QUIC connection per reach. The
server Endpoint ID is authenticated during the QUIC handshake; the client keeps
one durable native endpoint identity across reconnects. Loopback clients use the
existing WebSocket transport and never expose a remote network surface.

## Hub control and workspace reaches

A paired device keeps two logical reaches:

- the stable hub-control reach, used for account, device, invitation, and
  workspace-routing operations;
- the selected workspace reach, returned by
  `hubControl.routeWorkspace({ workspaceId })` and replaced when selection
  changes.

Each reach contains only the server Endpoint ID, an ordered explicit HTTPS relay
set, and the protocol version. Direct addresses are learned by Iroh and are not
persisted. The pairing code and expiry exist only in the one-time invite.

## Physical connection and logical sessions

The physical connection owns exactly one control stream. Session `open`,
`open-result`, `close`, and `closed` frames use that stream. Every unary RPC and
every streamed RPC uses a fresh bidirectional QUIC stream prefixed with its
session ID. Response streaming is one bounded response head followed by raw
body bytes and QUIC EOF. Cancellation maps to QUIC reset/stop.

`callerId` is durable application identity. `connectionId` and the Iroh session
ID identify one live authenticated session and are never durable user state.
One physical connection can carry the shell, app, panel, and control sessions
without weakening their separate admission or lease checks.

## Recovery

One reconnect owner dials the reach, retains the same client Endpoint ID, and
reopens every desired logical session with the same session ID. Iroh owns live
direct/relay path changes. A lost QUIC connection triggers bounded redial across
the advertised relay order; mobile suspend closes the endpoint generation and
resume binds a new generation from the same durable secret.

- `resubscribe` reopens response-owned subscriptions after transport recovery.
- `cold-recover` additionally rejects state tied to a prior server boot and
  rebuilds it from durable intent.
- a terminal session close is never reopened automatically.

## Invariants

- Authenticate the expected Endpoint ID before remote application auth.
- Keep hub control stable and replace only the selected workspace reach.
- Never persist direct addresses, relay hints, connection IDs, or session IDs.
- Never open a second physical connection for a panel or bulk transfer.
- Bound every frame, stream read, queue, timeout, and reconnect attempt.
- Exact-match the RPC contract version in the physical hello before redeeming a
  one-time pairing credential.
