# Trusted Workspace Units And Client Auth

Vibestudio treats trusted workspace units as declared, approved source units with
stable package identity. Trust is not derived from a special filesystem segment:

- `@workspace-clients/foo` lives at `clients/foo`
- `@workspace-extensions/bar` lives at `extensions/bar`

The package name is the code identity. The flat source path is the repo layout.

For authoring guidance, see the `clientdev` skill (`skills/clientdev/SKILL.md`)
in the System workspace.

## Unit Kinds

- Panels are user-facing workspace surfaces.
- Workers and Durable Objects are userland runtime code.
- Extensions are trusted Node service units.
- Clients (`clients/<id>`, unit kind `client`) are trusted units that a host
  runs for one runtime, declared by `vibestudio.client.runtime` and
  `vibestudio.client.hostAbi`:
  - `web` (`web-host-1`) runs as a window of the desktop host.
  - `react-native` (`rn-host-6`) is delivered to the native mobile host and runs
    in its own React Native instance.
  - `terminal` (`terminal-host-1`) produces one primary Node ESM (`.mjs`)
    artifact that the `vibestudio` CLI downloads over its own connection and
    runs in-process.

## Client Update Adoption

Client activation is server-side; adoption is a host decision, taken on
`supervision:changed`. A client in development mode (a per-client, per-device
host setting, never a manifest field) adopts a rebuild at once and restarts only
that client.

- Desktop clients keep an already-loaded window on the current build and offer
  the update; development mode reloads the window.
- React Native clients prompt, then the host recreates that client's instance;
  rollback switches the server to a retained previous build first.
- Terminal clients are offered a restart at a safe point; otherwise the next
  launch uses the new build.

The protocol surface is the `supervision:changed` event, `clients:changed`,
`runtime.supervision.versions`, and `runtime.supervision.rollback`. Release
operations use exact `{kind, releaseId}` identities. Rollback history is kept by
the unit host for clients and extensions alike, with a bounded retention limit,
and old artifacts remain servable while they are retained.

## Device And Principal Model

Remote clients use two layers of identity:

- A `DeviceCredential` is long-lived and native/client-held. It contains a
  device id and refresh token.
- A `PrincipalGrant` is short-lived and scoped to one concrete runtime
  principal, such as one client's principal on a device.
- A `PairingInvite` is one-time bootstrap material used to create a new device
  credential.
- `ConnectionInfo` describes the server URL clients should use for HTTP/RPC and
  pairing deep links.

A paired device host that runs a workspace client itself (the
desktop, mobile and terminal hosts) first resolves and verifies the client's
build with `clients.launch`, then obtains that client's principal grant over its
existing authenticated connection with the RPC
`auth.grantClientPrincipal([{ source, buildKey, executionDigest }])`. The grant
names the device-scoped principal `client:<id>:<runtime>:<deviceId>`, is bound
to the exact build the host verified, and is bound to the device key behind the caller's connection (an Iroh
process endpoint is delegated by the device's signing key, which only signs), so
it works over loopback and Iroh alike.

## Capability Checks

Capabilities are declared in the client manifest and checked at the service
boundary. User/device pairing is not a client capability: authenticated clients
use the typed `hubControl` service, which binds `pairDevice` to the acting user
and role-gates `inviteUser` at the hub.
