---
name: workspace-mobile-app
description: Work on the Vibestudio workspace React Native mobile app, OTA updates, re-pair states, and mobile recovery UX.
---

# Workspace Mobile App

Use this when changing `workspace/apps/mobile`, the trusted React Native app
that is streamed to the native host after pairing.

## Boundaries

- First pairing belongs to the shipped native bootstrap in `apps/mobile`.
- This app runs only after the native host has paired, fetched the current
  platform artifact, verified integrity, and reloaded React Native.
- Long-lived device credentials live in `@vibestudio/mobile-webrtc`; this app
  uses the active WebRTC transport and short-lived app principal grants.
- Bundle installation and self-update use the shared streamed delivery helper in
  `@vibestudio/mobile-webrtc`. Do not add HTTP-direct artifact fetches or native
  workspace-selection APIs.

## Pairing And Re-Pair

- Accept both `https://vibestudio.app/pair#...` and
  `vibestudio://connect?...` links through the shared parser.
- The login/recovery surface should offer paste-link and scanner entry points
  that delegate to native host capabilities.
- Consumed or stale links must fail visibly and leave the recovery UI usable.
- Re-pairing clears the active OTA bundle and returns to the shipped bootstrap;
  do not try to pair from a stale workspace bundle.

## OTA Updates

- `appUpdatePrompt.ts` prompts for trusted mobile app updates.
- Choosing Install must call the shared bundle-delivery flow over the app's
  current `MobileRpcClient` transport, then activate the prepared bundle.
- Choosing Roll back changes the trusted server build first, then activates the
  selected bundle.
- Keep `rnHostAbi` aligned with the native host. Current ABI: `rn-host-2`.

## Verification

- Run `pnpm -C apps/mobile type-check` for native/bootstrap TS.
- Run `pnpm -C apps/mobile test --runInBand` for the shipped shell package.
- Run `pnpm --dir workspace test -- mobile` or focused workspace tests for this
  app when changing workspace behavior.
- For real-device confidence, run `pnpm smoke:full` or
  `node scripts/cli/mobile-smoke.mjs --platform android` with an emulator.
