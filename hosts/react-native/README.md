# Vibestudio Mobile

Workspace browser profiles require iOS 17 or later. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
The native contract version is `RN_HOST_ABI` in `@vibestudio/shared/buildProvider`.

This directory contains the React Native JavaScript half of the shipped native
host: first-pairing and recovery bootstrap, Metro boundary and configuration.
The native projects are its siblings, `hosts/android` and `hosts/ios`
(`react-native.config.js` points the React Native CLI at them); they own native
modules, signing, and release packaging. All of it is trusted host code and
changes only with a native app release.

The hot-updatable React Native product UI lives separately in
the exact external Base release selected by the server. The server builds that
workspace app from content-addressed workspace state and streams it through
this native host after pairing. Keep product screens and workspace
services there; keep OS integration and recovery code here.

## Pairing And Install

The shipped native bootstrap owns first pairing. It accepts the HTTPS pair
carrier (`https://vibestudio.app/p#...`) and the custom scheme
(`vibestudio://connect/...`) through the same shared compact-v3 parser, and also exposes
in-app Scan QR and Paste pairing link actions for fresh installs and recovery.
After activation, the streamed workspace app owns ordinary device management:
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

The shipped native host exposes only reset/clear plus streamed bundle
activation. Pairing, credential refresh, bootstrap fetch, and bundle delivery
run through `@vibestudio/mobile-iroh` over the active Iroh pipe.
