---
name: remote-access
description: Deploy, pair, inspect, repair, update, or remove a Vibestudio remote server and diagnose WebRTC signaling, identity, membership, device, or workspace-routing failures.
---

# Remote access

Use `vibestudio remote --help` and subcommand help for current CLI syntax. The
main workflows are deploy, serve, pair, doctor, status/logs/update/remove,
user invitations, device pairing/revocation, membership, and explicit child
identity repair.

## Model

- A server is a hub hosting users, devices, and workspace children. The first
  redeemed startup invite establishes the root user; later users and devices
  join through authenticated hub actions.
- A user may pair several devices. Workspace membership is hub-owned and is
  enforced before routing to a child.
- Keep one stable hub-control reach per device. Route a workspace by exact ID
  and replace only the returned workspace reach.
- Each workspace child owns its own WebRTC ingress and persistent identity. The
  hub routes control but does not relay workspace media or turn internal tokens
  into user credentials.
- Pairing links are complete signed URLs. Do not construct bare-code or partial
  invites.

Do not infer a workspace from a display name, derive one reach from another, or
expose pairing secrets. The live hub-control schema is the source of truth for
method arguments and return types.

## Golden paths

Deploy with `vibestudio remote deploy <user@host>` and the desired artifact or
channel options, then run `remote doctor` against the exact server/workspace.
Use the authenticated hub to invite later users or pair another device.

For a phone attached to the connected desktop, use
[phone setup](../phone-setup/SKILL.md). It routes installation and same-account
pairing through the trusted desktop. If that owner is unavailable, use the
shell's Devices surface and its HTTPS QR.

## Diagnosis

Run the doctor ladder from the outside in:

1. Verify signaling and TURN/relay availability.
2. Inspect service status and logs on the remote host.
3. Distinguish the hub-control identity from the selected workspace child's
   identity before any repair.
4. Restore a hub identity from its exact backup. Rotate only a damaged child
   through the explicit repair command, then re-route that workspace from the
   stable hub connection.
5. Apply any exact host remediation printed by deploy or doctor, then rerun the
   failed check.

Do not replace identity as a generic connectivity fix. Preserve the narrow
failure state and report which endpoint, route, or dependency failed.

Use the focused desktop-pairing smoke for pairing changes. Use the full mobile
composition smoke only when the change spans desktop pairing, remote transport,
mobile activation, and panel loading.
