# Vibestudio Mobile

The mobile app is a React Native shell for pairing with a Vibestudio server,
rendering panels, and handling approval prompts in-app or through FCM/APNs push
notifications.

## Pairing And Install

The shipped native bootstrap owns first pairing. It accepts the HTTPS pair
carrier (`https://vibestudio.app/pair#...`) and the custom scheme
(`vibestudio://connect?...`) through the same shared parser, and also exposes
in-app Scan QR and Paste pairing link actions for fresh installs and recovery.

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

- Android: copy `android/app/google-services.template.json` to
  `android/app/google-services.json` and replace it with the real Firebase
  config.
- iOS: copy `ios/Vibestudio/GoogleService-Info.template.plist` to
  `ios/Vibestudio/GoogleService-Info.plist` and replace it with the real Firebase
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
not CDP targets; `handle.cdp.page()` and drive verbs reject while a target is
leased to mobile rather than taking it over silently. iOS `WKWebView` does not
provide CDP, so brokered CDP automation remains unavailable for mobile-held
panels there as well.

## Local Checks

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile type-check
pnpm -C apps/mobile lint
```

For Android WebRTC pairing and local relay testing, see
[docs/webrtc-local-e2e.md](../../docs/webrtc-local-e2e.md) and
[docs/webrtc-deployment.md](../../docs/webrtc-deployment.md).

The shipped native host exposes only reset/clear plus streamed bundle
activation. Pairing, credential refresh, bootstrap fetch, and bundle delivery
run through `@vibestudio/mobile-webrtc` over the active WebRTC pipe.
