---
name: workspace-mobile-app
description: Develop and diagnose the trusted React Native app in apps/mobile, including pairing recovery, OTA activation, and mobile equivalents of shared shell behavior.
---

# Workspace Mobile App

`apps/mobile` is the trusted React Native app streamed to the native host after
pairing.

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
- Keep `rnHostAbi` aligned with the native host. Read the value from
  `apps/mobile/package.json`; `@vibestudio/mobile-webrtc` owns the matching
  native delivery constant.

## Desktop Parity

- Treat `apps/shell` and this app as clients of the same workspace model. Audit
  shared navigation, approval, identity, and lifecycle behavior in both.
- Consume the same canonical identity and state projections. Keep native and
  web rendering idiomatic, but never create a mobile-only fallback data path.
- For unit identities, use `MobileUnitIcon`/`MobilePanelIcon`; relative manifest
  images must resolve through the authenticated local asset facade, browser
  panels must use captured favicons, SVG artwork must render through
  `react-native-svg` rather than React Native `Image`, and fallbacks must remain
  kind-specific.
- Add a focused mobile behavioral test when shared shell behavior changes. A
  desktop-only test is not evidence for the mobile client.

## Verification

- Run the focused checks declared by the app package and the affected workspace
  packages.
- Use `extensions/mobile-debug/SKILL.md` for device or simulator verification.
- Use the repository mobile smoke workflow only when the change crosses native
  bootstrap, pairing, transport, or OTA boundaries.
