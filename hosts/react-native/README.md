# Vibestudio Mobile

Workspace browser profiles require iOS 17 or later. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
The host ABI (`rn-host-6`) is `CURRENT_HOST_ABI["react-native"]` in `@vibestudio/workspace-contracts/clients`.

This directory contains the React Native JavaScript half of the shipped native
host: the **host runtime** (`index.js`, `src/host/`), its own screen
(`src/HostScreen.tsx`: pairing, the launch review, messages), the Metro
configuration and the jest runner for the clients' tests. The native projects
are its siblings, `hosts/android` and `hosts/ios` (`react-native.config.js`
points the React Native CLI at them); they own native modules, signing, and
release packaging. All of it is trusted host code and changes only with a native
app release.

The host runtime starts with the process (Android `Application.onCreate`, iOS
app delegate), before any activity or scene, and owns the device: the
credential, the one physical Iroh connection per reach, pairing, push, and the
verified artifact cache. It runs each **client** (a System workspace unit under
`clients/`, for example `mobile-browser`) in its own React Native instance,
launched through `clients.launch` and loaded only from a bundle whose SHA-256
matches the integrity the server sealed. A client reaches the host only through
the capability broker and `@vibestudio/rn-client-api` (`packages/rn-client-api`);
raw device modules are not registered in client instances. Updates reload only
the affected client's instance (the client prompts; development mode reloads at
once). A session closed with the `trust-revoked` reason tears the client down
with a message on the host screen.

`src/host/` map: `hostRuntime.ts` (state machine: pair, connect, launch,
update, revoke), `clientInstance.ts` + `clientBroker.ts` (per-client identity
and capability enforcement), `sessionRelay.ts` (logical sessions held for a
client, identity stamped by the host), `hostConnections.ts` (shared workspace
connections), `deviceConnection.ts` (credential and pairing),
`nativeHostRuntime.ts` (the contract native implements), `notifications/`
(device-level push), `nativeBindings.ts` (the only file wiring real modules).
Tests for `src/host` run in the host vitest suite; the clients' tests run here
with jest (`pnpm test:mobile`).

## Pairing And Install

The host runtime owns first pairing. It accepts the HTTPS pair
carrier (`https://vibestudio.app/p#...`) and the custom scheme
(`vibestudio://connect/...`) through the same shared compact-v3 parser, and also exposes
in-app Scan QR and Paste pairing link actions for fresh installs and recovery.
Once a client runs, it owns ordinary device management through the host API:
**Settings** → **Devices** → **Connect another device** creates and shares a
server-minted one-time link for the exact current workspace. That flow does not
reset or expose the current phone's native credential.

Android installs default to the version-matched prebuilt release APK and verify
it against the release `SHA256SUMS` file. `--from-source` builds the internal
contributor APK locally. iOS is always self-built and signed on a Mac:

```bash
vibestudio mobile install --platform android --launch
vibestudio mobile install --platform android --from-source --launch
vibestudio mobile install --platform ios --simulator --launch
vibestudio mobile doctor
```

iOS OAuth uses the native `VibestudioAuthSession` wrapper around
`ASWebAuthenticationSession` and app-scheme callbacks. Android keeps the native
loopback listener/foreground-service mechanism.

## Push Approvals

Provision Firebase before testing notification actions:

- Android: copy `hosts/android/app/google-services.template.json` to
  `hosts/android/app/google-services.json` and replace it with the real Firebase
  config.
- iOS: copy `hosts/ios/Vibestudio/GoogleService-Info.template.plist` to
  `hosts/ios/Vibestudio/GoogleService-Info.plist` and replace it with the real Firebase
  config.
- Server: set `VIBESTUDIO_FIREBASE_SERVICE_ACCOUNT_PATH` or
  `VIBESTUDIO_FIREBASE_SERVICE_ACCOUNT_JSON`.

Full architecture, security notes, decision semantics, and native test steps
are in [docs/approvals.md](../../docs/approvals.md).

## Panel Automation

Mobile panels use the WebView bridge for non-CDP runtime introspection.
Workspace panel handles can call `snapshot()`, `tree()`, `state()`,
`routes()`, and `setMode()`; the mobile host loads the target WebView when
needed and dispatches to the panel's registered `_agent.*` handlers.

CDP automation always runs through the server broker and requires a
CDP-capable Electron host. The mobile app does not expose an Android WebView
CDP proxy or a direct WebView drive path. Panels held by the mobile host are
not CDP targets; `handle.cdp.session()` and drive verbs reject while a target is
leased to mobile rather than taking it over silently. iOS `WKWebView` does not
provide CDP, so brokered CDP automation remains unavailable for mobile-held
panels there as well.

## Building The Android Host

The Gradle project is `hosts/android`. It requires JDK 21 (CI pins the same
version). Point `JAVA_HOME` at it, then:

```bash
cd hosts/android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew :app:assembleDebug
```

## Local Checks

```bash
pnpm -C hosts/react-native test
pnpm -C hosts/react-native type-check
pnpm -C hosts/react-native lint
```

For Android Iroh pairing and local relay testing, see
[docs/Iroh-local-e2e.md](../../docs/Iroh-local-e2e.md) and
[docs/Iroh-deployment.md](../../docs/Iroh-deployment.md).

The shipped native host exposes the host runtime module (client instances, the
verified artifact store, the broker), browser import and USB provisioning.
Pairing, credential refresh, launch and bundle delivery run in the host runtime
through `@vibestudio/mobile-iroh` and `@vibestudio/client-host-core` over the
device's Iroh pipe.
