# Remote Clients And Pairing

NatStack remote clients use device credentials and short-lived principal grants.
Apps that help connect other clients need the `connection-management`
capability.

## Concepts

| Concept | Purpose |
| --- | --- |
| Pairing invite | One-time bootstrap material: server URL plus pairing code |
| Device credential | Long-lived device id plus refresh token, stored by the client/native host |
| Shell token | Desktop remote shell token refreshed from a device credential |
| Principal grant | Short-lived grant scoped to one app/runtime principal |
| Connection info | Server URL and public connection metadata |

## Desktop Remote Shell

Desktop remote startup can use:

- admin token bootstrap
- device credential bootstrap
- hybrid admin + device bootstrap

Device bootstrap refreshes a shell token through `/auth/refresh-shell`. If the
device credential is revoked or expired, desktop startup should recover by
falling back to local mode or asking for re-pairing rather than leaving the app
dead.

`pnpm start:remote --pair "natstack://connect?url=...&code=..."` exchanges a
pairing invite, stores a CLI device credential, and launches Electron against
the remote server.

## Mobile Client

Mobile native host stores a device credential and requests a principal grant for
the React Native app:

```json
{
  "principal": "react-native-app"
}
```

The resulting caller id is device-scoped, for example:

```text
app:apps/mobile:<device-id>
```

The workspace app should use that principal grant for RPC. It should not store
or handle the refresh token directly in JS.

## Terminal Client

The terminal target currently produces an artifact-only Node ESM entry. A
terminal remote client should:

- parse or accept a pairing invite
- call `/auth/complete-pairing`
- store a device credential in CLI/user config
- refresh connection material from the server
- connect as the intended principal once terminal runtime primitives exist

Today, the server reports terminal apps as `available`, not `running`.

## Pairing Invite Creation

An app caller needs `connection-management` to call `auth.createPairingInvite`.
Host callers can be allowed explicitly at the auth service call site.

Do not grant `connection-management` to arbitrary apps. It lets the app mint
new client bootstrap material.

## URL And Transport Rules

- Cleartext HTTP is allowed only for trusted local/private/Tailscale-style
  hosts.
- Prefer HTTPS public URLs for mobile OAuth and app-link/universal-link flows.
- `natstack://connect` is for pairing bootstrap, not OAuth callbacks.
- Mobile OAuth callbacks should use verified app-link/universal-link routes
  where configured.

## Recovery And UX

Remote-client UX should handle:

- revoked device credential
- stale server boot id
- server URL change
- TLS fingerprint or CA mismatch
- no active mobile app bootstrap
- terminal artifact available but no runtime launched

The recovery surface should remain usable even when the workspace app cannot be
loaded.
