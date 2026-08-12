---
name: react-native-build-extension
description: Develop or diagnose the React Native build provider in extensions/react-native and its mobile bootstrap artifact contract.
---

# React Native Build Extension

This extension builds mobile app artifacts served to native hosts.

## Contract

- Build both `android` and `ios` Metro bundles when the workspace app supports
  both platforms.
- Resolve React Native, registry dependencies, and workspace/platform modules
  only from the dependency projection supplied in `BuildProviderInput` by
  Build V2. The provider must not search `process.cwd()`, a checkout root, the
  root lockfile, or the native host's Metro configuration.
- Keep native-module importer policy in the app's declared
  `nativeModulePolicy` JSON. The build provider reads it from the immutable app
  source projection; the native development host consumes the same data.
- Each primary artifact must include `platform: "android" | "ios"`, `role:
  "primary"`, `integrity`, content type, encoding, and URL.
- The server bootstrap manifest must include `rnHostAbi`, app/build identity,
  capabilities, artifact set integrity, and provider identity.
- Read the native-host ABI from the workspace app package and keep it aligned
  with the delivery constant in `@vibestudio/mobile-webrtc`. Change both only
  when the native contract changes.

## Failure Modes

- Missing platform artifact: native host refuses activation for that platform.
- ABI mismatch: host keeps recovery UI and tells the user to reinstall/rebuild
  the shell.
- Integrity mismatch: native finalize refuses activation after hashing the
  decompressed bundle bytes.
- Missing provider identity: activation fails closed because the app build
  cannot be trusted.

## Verification

- Run focused build-provider and native delivery tests after changing manifests
  or artifacts.
- Use the repository mobile smoke workflow before claiming end-to-end delivery
  when the change crosses build, transport, and activation boundaries.
