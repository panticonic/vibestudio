# Trusted Workspace Units And Client Auth

Vibestudio treats trusted workspace units as declared, approved source units with
stable package identity. Trust is not derived from a special filesystem segment:

- `@workspace-apps/foo` lives at `workspace/apps/foo`
- `@workspace-extensions/bar` lives at `workspace/extensions/bar`

The package name is the code identity. The flat source path is the repo layout.

For authoring guidance, see `workspace/skills/appdev/SKILL.md`.

## Unit Kinds

- Panels are user-facing workspace surfaces.
- Workers and Durable Objects are userland runtime code.
- Extensions are trusted Node service units.
- Apps are trusted client units with an explicit target:
  - `electron` runs as a hosted shell view.
  - `react-native` is delivered to the native mobile host through a signed build
    provider bootstrap.
  - `terminal` produces one primary Node ESM (`.mjs`) artifact that the
    `vibestudio terminal` CLI downloads over its own connection and runs
    in-process (adoption policy `artifact-only`).

## App Update Adoption

Trusted app activation is server-side; client adoption is target-specific.

- Electron clients keep an already-loaded app view on the current build when a
  new trusted build arrives. The shell surfaces `Load update` and `Roll back`
  actions through notifications and the App updates settings section.
- React Native clients use a native prompt. `Install` prepares and activates the
  current trusted bundle; `Roll back` switches the server to a retained previous
  build before activating it.
- Terminal clients keep the loaded module until `vibestudio terminal` loads the
  app again: on the next run, or when the CLI reconnects and its renewed app
  principal grant names a newer build.

The protocol surface is the `supervision:changed` event (one event for every
supervised unit, carrying each target's adoption policy),
`runtime.supervision.versions`, and `runtime.supervision.rollback`. Release
operations use exact `{kind, releaseId}` identities. Rollback history is kept by
the unit host for apps and extensions alike, with a bounded retention limit, and
old artifacts remain servable while they are retained.

## Device And Principal Model

Remote clients use two layers of identity:

- A `DeviceCredential` is long-lived and native/client-held. It contains a
  device id and refresh token.
- A `PrincipalGrant` is short-lived and scoped to one concrete runtime
  principal, such as a device's React Native or terminal app principal.
- A `PairingInvite` is one-time bootstrap material used to create a new device
  credential.
- `ConnectionInfo` describes the server URL clients should use for HTTP/RPC and
  pairing deep links.

Desktop and mobile remote shells refresh a `shell` token from their device
credential. A paired device shell that runs a workspace app itself (the mobile
native host, the `vibestudio terminal` CLI) obtains that app's principal grant
over its existing authenticated connection with the RPC
`auth.grantAppPrincipal([{ principal: "react-native-app" | "terminal-app",
source }])`. The grant names the device-scoped principal
`app:<source>:<deviceId>` and the exact build it may run, and is bound to the
caller's transport endpoint, so it works over loopback and Iroh alike.

## Capability Checks

Capabilities are declared in the app manifest and checked at the service
boundary. User/device pairing is not an app capability: authenticated clients
use the typed `hubControl` service, which binds `pairDevice` to the acting user
and role-gates `inviteUser` at the hub.
