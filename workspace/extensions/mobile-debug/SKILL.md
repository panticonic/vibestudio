---
name: mobile-debug-extension
description: Use the mobile-debug extension to install, launch, screenshot, and tail logs for Android devices and iOS simulators.
---

# Mobile Debug Extension

Use this when an agent needs to inspect or iterate on the mobile app with a
real device, Android emulator, or iOS simulator.

## Platform Backends

- Android uses adb for install, launch, uiautomator taps, screenshots, and
  logcat phase markers.
- iOS simulator support should use `xcrun simctl` for boot/install/launch,
  `simctl io screenshot`, and `simctl spawn <udid> log stream`.
- Physical iOS device logs are not streamed by this extension; use Console.app
  and `vibestudio mobile install --platform ios --device <udid>` for install.

## Pairing Smoke Markers

Watch for `[VibestudioMobileSmoke] phase=...` lines:

- `embedded-pairing-start`
- `embedded-pairing-complete`
- `embedded-bootstrap-fetch-start`
- `embedded-bundle-activate-start`
- `embedded-bundle-activate-complete`
- `workspace-panel-webview-loaded`

Missing markers usually mean the failure is in pairing, bundle delivery,
native activation, or panel materialization respectively.

## Debugging A Bad Mobile Panel

- Android: use logcat, screenshots, and WebView debugging in Debug/Internal
  builds.
- iOS: use simulator screenshots/log stream and Safari Web Inspector for
  WKWebView in Debug/Internal builds. CDP automation is not available for
  mobile-held WebViews.
- If the active bundle is suspect, re-pair or call native reset so the shipped
  bootstrap can recover.

## Commands

```bash
node scripts/cli/mobile-smoke.mjs --platform android --avd <name>
node scripts/cli/mobile-smoke.mjs --platform ios --simulator <name>
pnpm smoke:full
```
