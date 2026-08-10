---
name: workspace-shell-app
description: Work on the Vibestudio desktop shell app, including the Devices pairing surface and paired-device management.
---

# Workspace Shell App

Use this when changing `workspace/apps/shell`, the trusted Electron shell that
hosts desktop panel chrome and device-management UI.

## Devices Surface

- "Connect a device" calls `hubControl.pairDevice` on the currently connected
  server, local or remote. The desktop is a broker, never a data relay.
- Render the HTTPS pair URL and QR from the complete invite object. Do not build
  client-side fallback links or accept nullable `deepLink`/`room`.
- The modal should show expiry, server/workspace label, waiting state, and then
  the paired device once `hubControl.listDevices` observes it.
- Device revocation uses `hubControl.revokeDevice`; after revoking the desktop's
  own stored device, explicitly call local `remoteCred.clear` before relaunching.
  A revoked phone should return to recovery/re-pair.

## Remote Parity

- Remote sessions serve panels, manifests, and assets through the bridge-backed
  facade. Avoid code that assumes the server's workspace path is readable on the
  desktop filesystem.
- Pairing URLs can arrive through the desktop protocol handler or as typed URLs;
  both carriers must feed the shared parser.

## Mobile Parity

- Treat desktop shell UX and `workspace/apps/mobile` as paired clients of the
  same workspace model. Before finishing a user-facing shell change, audit the
  mobile equivalent: title bar/AppBar, panel tree/drawer, approvals, launcher
  and about/new flows, browser favicons, and loading/error/empty states.
- Share canonical data and presentation rules, not renderer components. Add a
  focused behavioral test in every affected client; explicitly state when a
  surface has no mobile equivalent instead of silently omitting it.

## Panel Lifecycle and UI Projections

- `view.createPanel` and `panel.createPanel` resolve at the durable slot-commit
  boundary. Runtime-image preparation, native attachment, navigation, and app
  boot continue independently. Do not make a creation button await readiness.
- `panel-created` is the sole creation-placement fact. It may arrive before the
  create RPC response and before a tree or presentation read contains the slot.
  Reducers must be idempotent and merge by `panelId`; never append a second
  optimistic panel when the response arrives.
- Render committed panels immediately in a preparing state. Keep preparing,
  ready, and failed as projections of authoritative lifecycle state, not as
  reasons to hide or delete the durable slot.
- Subscribe to `panel-presentation-changed`, then fetch the changed ids with one
  `panel.getPresentations(panelIds)` call. Coalesce bursts by revision and id.
  Do not refetch the full panel tree or issue one RPC per panel.
- Focus, presentation lease acquisition, runtime activation, and boot readiness
  are separate transitions. Shell creation promises only the first; the
  portable `openPanel(...)` API has the stronger boot-ready contract.
- Approval and other long-running work must not occupy a renderer interaction
  lane. Async handlers show local pending/error state and leave unrelated panel
  creation, focus, navigation, and input responsive.
- Never add sleeps or polling loops to bridge event ordering. The slot event is
  durable intent, presentation events are invalidations, and exact readiness
  waits use the server-minted attempt stream.

## Verification

- For shell UI changes, run focused workspace shell tests and a Playwright flow
  where possible.
- For pairing changes, run `pnpm test:desktop-pairing-smoke`.
- For full composition with the Android client, run `pnpm smoke:full`.
