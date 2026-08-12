---
name: mobile-debug-extension
description: Build, install, launch, screenshot, verify, and inspect logs for Vibestudio on Android devices or emulators and iOS simulators through the mobile-debug extension.
---

# Mobile Debug Extension

## Platform Backends

- Android uses adb for install, launch, uiautomator taps, screenshots, and
  logcat phase markers.
- iOS simulator support should use `xcrun simctl` for boot/install/launch,
  `simctl io screenshot`, and `simctl spawn <udid> log stream`.
- Physical iOS device logs are not streamed by this extension; use Console.app
  and `vibestudio mobile install --platform ios --device <udid>` for install.

## Canonical Sandboxed Install

From workspace eval, use the extension rather than spawning the CLI or invoking
`adb`:

```ts
const devices = await extensions.invoke("mobile-debug", "listDevices", []);
const install = await extensions.invoke("mobile-debug", "installAndroid", [
  { device: devices[0]?.serial, resetApp: true, launch: true },
]);
const verification = await extensions.invoke("mobile-debug", "verify", [
  { device: devices[0]?.serial },
]);
return { devices, install, verification };
```

`installAndroid` emits the normal scoped user approval. Automated system tests
must satisfy that request through a host-attested case authority policy; they
must not add an extension flag or alternate no-approval method.

`verify` returns bounded status evidence (`installed`, `rendering`,
`screenshotCaptured`, `screenshotBytes`, and `issues`). It deliberately does
not embed the screenshot bytes; call `screenshot` separately only when the
image itself is needed.

## Performance receipts

`doctor` reports the selected Android device ABI and current internal APK byte
size when available. For source-build profiling, either pass a device so the
extension selects its ABI or pass an explicit architecture list:

```ts
const devices = await extensions.invoke("mobile-debug", "listDevices", []);
const startedAt = Date.now();
const build = await extensions.invoke("mobile-debug", "buildAndroid", [
  { variant: "internal", device: devices[0]?.serial },
]);
const ready = await extensions.invoke("mobile-debug", "verifyWorkspaceReady", [
  { device: devices[0]?.serial, sinceMs: startedAt, timeoutMs: 180_000 },
]);
return { build, ready };
```

The build receipt contains `durationMs`, `architectures`, `apkPath`, and
`apkBytes`. The canonical build is deliberately resource-bounded
(`--no-daemon`, two Gradle workers, in-process Kotlin compilation); there is no
separate profiling build path. A device-targeted measurement must report the
selected ABI. An empty `architectures` array means the caller intentionally
measured Gradle's configured default set, not a device-specific build.

After a pairing or provisioning workflow, verify the workspace shell rather
than stopping at process liveness:

```ts
const startedAt = Date.now();
// Run the pairing/provisioning operation here.
const workspace = await extensions.invoke("mobile-debug", "verifyWorkspaceReady", [
  { device: devices[0]?.serial, sinceMs: startedAt, timeoutMs: 180_000 },
]);
```

`verifyWorkspaceReady` waits for the workspace initialization and connection
markers and fails on panel activation or load errors. Read its returned phase
evidence and the extension source for the current marker set; do not duplicate
marker strings or fixed cold-start timings in callers.

## Debugging A Bad Mobile Panel

- Android: use logcat, screenshots, and WebView debugging in Debug/Internal
  builds.
- iOS: use simulator screenshots/log stream and Safari Web Inspector for
  WKWebView in Debug/Internal builds. CDP automation is not available for
  mobile-held WebViews.
- If the active bundle is suspect, re-pair or call native reset so the shipped
  bootstrap can recover.

From the source checkout, use the repository mobile smoke entry point for the
target platform. Use the full composition smoke only when the change spans
desktop pairing, transport, mobile activation, and panel loading.
