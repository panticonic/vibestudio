# Iroh relay operations

Vibestudio remote RPC uses stock `iroh-relay` 1.0.2 from the frozen
`iroh-ffi` 1.1.0/core 1.0.2 release set. Relay hosts terminate only the relay
transport; application RPC remains end-to-end encrypted and authenticated by
the hub or workspace child.

Production requires two independent public relay hosts. Give each a stable
DNS-only hostname, TCP 80/443, UDP 7842, an operator-only metrics listener,
central logs, and capacity alerts. Do not proxy relay traffic through a Worker,
Tunnel, or generic WebSocket service.

## Installation and verification

Download the release asset named
`iroh-relay-v1.0.2-<target>.tar.gz` from the official `n0-computer/iroh`
release. Verify it against `IROH_RELAY_1_0_2_LINUX_ASSET_SHA256` in
`packages/iroh-transport/src/releaseSet.ts`, install the binary as
`/usr/local/libexec/iroh-relay`, and install the unit and edited TOML template
from `deploy/iroh-relay/`. The binary, config, unit, DNS record, firewall, and
monitor must be reviewed as one deployment.

For an owned local fixture, run `pnpm relay:fixture`. It downloads only the
pinned official asset for the current Linux architecture, verifies SHA-256,
starts it in localhost development mode, forwards termination, and exits with
the child. Tests must always terminate and await this process.

## Admission

Open access is permitted only for the explicitly capacity-limited beta. The
production target is `access.http`: the relay sends the authenticated Endpoint
ID to a minimal registry, and the registry returns true only for bootstrap IDs
with an unexpired pairing invitation or live, non-revoked device IDs. The
relay-to-registry bearer belongs in `IROH_RELAY_HTTP_BEARER_TOKEN`; it is never
shipped to clients. Application authorization remains at the Iroh ingress.

Do not deploy authenticated production relays until fresh pairing, reconnect,
rotation, revocation latency, denial behavior, and registry outage behavior
pass against both regions. A global shared client token is forbidden.

## Rollout and outage

Roll one stateless region at a time: drain it from newly minted reach records,
wait at least the maximum reconnect window, upgrade and verify `/`, metrics,
TCP relay, UDP address discovery, then restore it before touching the second
region. Rollback means restoring the prior pinned binary/config while keeping
the same DNS and certificates.

Alert on process absence, TCP/UDP probe failure, admission failures, connection
accept saturation, rate-limited bytes, sustained relayed bandwidth, and one
region disappearing from connection diagnostics. If both relays fail, preserve
credentials and report offline/reconnecting; never enable public discovery or
an alternate application transport as an emergency fallback.

Certificate/key rotation is one region at a time. Endpoint identity rotation is
unrelated and destructive: it invalidates stored reaches and requires explicit
re-pairing.
