---
name: react-native-build-extension
description: Maintain the React Native workspace-app build provider and mobile bootstrap artifact contract.
---

# React Native Build Extension

Use this when changing `workspace/extensions/react-native` or debugging mobile
bundle artifacts served to native hosts.

## Contract

- Build both `android` and `ios` Metro bundles when the workspace app supports
  both platforms.
- Each primary artifact must include `platform: "android" | "ios"`, `role:
  "primary"`, `integrity`, content type, encoding, and URL.
- The server bootstrap manifest must include `rnHostAbi`, app/build identity,
  capabilities, artifact set integrity, and provider identity.
- Current native-host ABI is `rn-host-2`. Bump it only when the native host
  contract changes, and update the workspace app manifest and skills together.

## Failure Modes

- Missing platform artifact: native host refuses activation for that platform.
- ABI mismatch: host keeps recovery UI and tells the user to reinstall/rebuild
  the shell.
- Integrity mismatch: native finalize refuses activation after hashing the
  decompressed bundle bytes.
- Missing provider identity: activation fails closed because the app build
  cannot be trusted.

## Verification

- Run focused build-provider tests after manifest/artifact changes.
- Run `pnpm -C apps/mobile test --runInBand` for native bootstrap delivery
  callers.
- Run `node scripts/cli/mobile-smoke.mjs --platform android` or
  `pnpm smoke:full` before claiming end-to-end mobile delivery works.
