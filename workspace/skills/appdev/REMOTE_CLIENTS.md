# Remote Clients And Pairing

Vibestudio remote clients use device credentials and short-lived principal grants.
Apps that help connect other clients need the `connection-management`
capability.

## Concepts

| Concept           | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Pairing invite    | One-time WebRTC bootstrap material: room, DTLS fingerprint, code, signaling endpoint |
| Device credential | Long-lived device id plus refresh token, stored by the client/native host |
| Shell token       | Remote shell credential presented as `refresh:<deviceId>:<refreshToken>` over the pipe |
| Principal grant   | Short-lived grant scoped to one app/runtime principal                     |
| Connection info   | WebRTC pairing metadata plus server/workspace identity                    |

## Desktop Remote Shell

Remote startup is a two-step WebRTC flow:

1. Pair with the server hub and store a device credential.
2. Select a workspace, which returns a workspace-scoped WebRTC pairing invite.

`vibestudio remote pair "https://vibestudio.app/pair#room=...&fp=...&code=...&sig=...&v=2"`
or the equivalent `vibestudio://connect?...` link exchanges a pairing invite
over the pipe and stores the hub credential.
`vibestudio remote select <name>` pairs to the selected workspace's room and keeps
the hub credential for later workspace listing/selection.

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

The terminal target produces a Node ESM entry and the server can launch it as a
supervised app process. A terminal remote client should:

- connect over `/rpc` with the runner-provided principal grant
- use app identity and manifest capabilities for privileged calls
- create pairing invites with `auth.createPairingInvite` only when it has
  `connection-management`
- parse or accept pairing invites when acting as an external CLI client
- call `/auth/complete-pairing` for external device bootstrap flows
- store external device credentials in CLI/user config, not in trusted app
  bundle state

The built-in `@workspace-apps/remote-cli` is the canonical terminal app shape:
it connects as an app principal, lists workspace status, and can mint a pairing
invite for another client. It is declared in the template so it is available for
server pairing/debugging, but it stays dormant until the shell UI or
`workspace.units.restart("@workspace-apps/remote-cli")` starts it.

Fresh workspaces created from the product template trust their initial declared
app/extension set during startup. Later meta-state updates, capability changes, source
changes, dependency changes, and target changes still go through the normal unit
approval path.

## Pairing Invite Creation

An app caller needs `connection-management` to call `auth.createPairingInvite`.
Host callers can be allowed explicitly at the auth service call site.

Do not grant `connection-management` to arbitrary apps. It lets the app mint
new client bootstrap material.

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

1. Start the server with `--ready-file` and read `gatewayUrl` plus
   `adminToken`.
2. Use `scripts/vibestudio-admin.mjs approvals list` to inspect pending trusted
   unit approvals.
3. Use `scripts/vibestudio-admin.mjs approvals approve version` only for local
   trusted-template/dev scenarios where the unit set is expected.
4. Use `scripts/vibestudio-admin.mjs units list` to inspect active build keys and
   lifecycle states.
5. Use `scripts/vibestudio-admin.mjs units restart <app>` for terminal apps.
6. Use `scripts/vibestudio-admin.mjs units logs <app>` to inspect stdout/stderr
   and runner errors.
7. From app, panel, worker, or eval contexts, use `serverLog.query/tail/stats`
   (`services.serverLog.*` in eval, raw `rpc.call("main", "serverLog.*", ...)`
   elsewhere) or the `about/server-logs` viewer for host server logs such as
   pairing, reconnect, app reconcile, gateway, and shutdown events. See
   `../server-logs/SKILL.md`.
