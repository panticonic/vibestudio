# Remote Clients And Pairing

Vibestudio remote clients use hub-owned user/device credentials and short-lived
principal grants. Device and user invitations are hub-control operations made
by an authenticated human account.

## Concepts

| Concept           | Purpose                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| Pairing invite    | One-time WebRTC bootstrap material: room, DTLS fingerprint, code, signaling endpoint   |
| Device credential | Long-lived device id plus refresh token, stored by the client/native host              |
| Shell token       | Remote shell credential presented as `refresh:<deviceId>:<refreshToken>` over the pipe |
| Principal grant   | Short-lived grant scoped to one app/runtime principal                                  |
| Connection info   | WebRTC pairing metadata plus server/workspace identity                                 |

## Desktop Remote Shell

Remote startup is a two-step WebRTC flow:

1. Redeem a user-bound or root-bootstrap invite and store the global device
   credential.
2. Select a workspace through `hubControl.routeWorkspace`, which returns that
   child's current WebRTC reach information without minting another identity.

`vibestudio remote pair "https://vibestudio.app/pair#room=...&fp=...&code=...&sig=...&v=2&ice=all"`
or the equivalent `vibestudio://connect?...` link exchanges a pairing invite
over the pipe and stores the device credential.
`vibestudio remote select <name>` switches the selected child's reach while
keeping that same credential for later workspace listing/selection.

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

The selected mobile source is supplied during bundle bootstrap and
principal-grant refresh:

```json
{
  "principal": "react-native-app",
  "source": "apps/field-mobile"
}
```

That yields a source-scoped caller id such as:

```text
app:apps/field-mobile:<device-id>
```

The native host persists the selected source alongside the activated bundle so
future reconnects refresh grants for the same app. No implicit app-source
fallback should be added to clients.

The workspace app should use that principal grant for RPC. It should not store
or handle the refresh token directly in JS.

## Terminal Client

The terminal target produces a Node ESM entry and the workspace server can
launch it as a supervised app process. A terminal app should:

- connect over `/rpc` with the runner-provided principal grant
- use app identity and manifest capabilities for privileged calls
- keep workspace work on the child session; account/device/workspace-catalog
  control belongs to a human shell's separate stable hub session

The built-in `@workspace-apps/remote-cli` is the canonical terminal app shape:
it connects as an app principal and lists workspace status. It is declared in
the template so it is available for debugging, but it stays dormant until the shell UI or
`workspace.units.restart("@workspace-apps/remote-cli")` starts it.

Fresh workspaces created from the product template trust their initial declared
app/extension set during startup. Later meta-state updates, capability changes, source
changes, dependency changes, and target changes still go through the normal unit
approval path.

## Pairing Invite Creation

Pairing invite creation belongs to the stable hub session held by desktop,
mobile, and external CLI shells. A workspace app has only its exact child
session and cannot deputy a hub-control request. `pairDevice` binds an invite to
the authenticated shell's account; `inviteUser` is root/admin-gated.

## URL And Transport Rules

- Remote clients pair through WebRTC using a signaling room plus DTLS
  fingerprint pinning. Do not add public-ingress, VPN, or cleartext-host
  exceptions for RPC reachability.
- Pairing QR codes should use the HTTPS carrier
  `https://vibestudio.app/pair#...`; machine/CLI surfaces may keep the
  `vibestudio://connect?...` carrier. Both use the same parser and payload.
- Pairing invites are complete artifacts: `deepLink`, `pairUrl`, `room`, `fp`,
  `code`, and `sig` are non-null. Do not reintroduce bare-code or nullable-link
  handling.
- `vibestudio://connect` is for pairing bootstrap. OAuth callbacks use the
  platform-specific OAuth seam and must not trigger pairing reset.

## Recovery And UX

Remote-client UX should handle:

- revoked device credential
- stale server boot id
- expired or unreachable signaling room
- DTLS fingerprint mismatch
- no active mobile app bootstrap
- terminal app build available but process not started
- terminal app process exited or failed session auth

The recovery surface should remain usable even when the workspace app cannot be
loaded.

## Operational Debugging

When testing pairing or remote-server state without a shell UI:

1. Start the hub with `--ready-file`; on a fresh identity DB, redeem the one
   `rootInvite` with the CLI to become root. Its deep link and HTTPS/QR URL are
   presentation carriers for the same invitation fact, not separate invites.
2. Select a workspace and inspect/resolve approvals through the authenticated
   workspace services. Do not mint a shell principal from a process token.
3. Use `workspace.units.list/restart/logs/diagnostics` from an authenticated
   client to inspect build keys, lifecycle state, and runner errors.
4. From app, panel, worker, or eval contexts, use `serverLog.query/tail/stats`
   (`services.serverLog.*` in eval, raw `rpc.call("main", "serverLog.*", ...)`
   elsewhere) or the `about/server-logs` viewer for host server logs such as
   pairing, reconnect, app reconcile, gateway, and shutdown events. See
   `../server-logs/SKILL.md`.
