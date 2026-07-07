---
name: workspace-shell-app
description: Work on the Vibestudio desktop shell app, including the Devices pairing surface and paired-device management.
---

# Workspace Shell App

Use this when changing `workspace/apps/shell`, the trusted Electron shell that
hosts desktop panel chrome and device-management UI.

## Devices Surface

- "Connect a phone" mints an invite on the currently connected server, local or
  remote. The desktop is a broker, never a data relay.
- Render the HTTPS pair URL and QR from the complete invite object. Do not build
  client-side fallback links or accept nullable `deepLink`/`room`.
- The modal should show expiry, server/workspace label, waiting state, and then
  the paired device once `remoteCred.listDevices` observes it.
- Device revocation uses `remoteCred.revokeDevice`; after revocation, the phone
  should return to recovery/re-pair.

## Remote Parity

- Remote sessions serve panels, manifests, and assets through the bridge-backed
  facade. Avoid code that assumes the server's workspace path is readable on the
  desktop filesystem.
- Pairing URLs can arrive through the desktop protocol handler or as typed URLs;
  both carriers must feed the shared parser.

## Verification

- For shell UI changes, run focused workspace shell tests and a Playwright flow
  where possible.
- For pairing changes, run `pnpm test:desktop-pairing-smoke`.
- For full composition with the Android client, run `pnpm smoke:full`.
