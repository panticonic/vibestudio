# Vibestudio iOS Native Project

The iOS shell requires iOS 17.5 or later, matching its pinned IrohLib package.
Workspace browser profiles use the iOS 17 WebKit APIs. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
This native contract is `rn-host-5`.

The checked-in Xcode project is authoritative. Do not regenerate it with
`react-native init`; update `Vibestudio.xcodeproj/project.pbxproj` directly when
native sources, build phases, or configurations change.

## Local Signing

For simulator testing, install full Xcode with an iOS simulator runtime and
CocoaPods, then boot exactly one iPhone simulator in Xcode. A developer team or
signing identity is not required for the simulator. The installer builds,
installs, and launches on that simulator's UDID:

```bash
node scripts/cli/mobile-install.mjs --platform ios --simulator --launch
```

The installer runs `pod install` before each build to reconcile native
dependencies with the installed JavaScript packages and `Podfile.lock`.
Keep the CocoaPods lockfile and workspace in source control. Use the repository's
pinned pnpm version when updating JavaScript dependencies; React Native 0.79.7
has a dependency patch upgrading its iOS fmt dependency to 12.1.0 for the
Xcode 27 compiler. The app uses `SceneDelegate` to own the window and creates
React Native through its factory. Firebase Messaging has a dependency patch to
find root views through connected scenes and receive scene foreground events;
its upstream implementation still assumes a window on the application delegate.

UIKit requires the scene lifecycle for apps built with SDK 27. See Apple's
[scene migration guide](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).

For physical-device builds, configure signing first:

```bash
cp apps/mobile/ios/Signing.template.xcconfig apps/mobile/ios/Signing.local.xcconfig
vibestudio mobile doctor
vibestudio mobile install --platform ios --device <udid> --launch
```

`Signing.local.xcconfig` is gitignored and holds user-specific Apple signing
settings. The shared `Vibestudio` scheme prepares signing entitlements before
build planning by running `scripts/cli/ios-entitlements.mjs`, which writes
`apps/mobile/ios/Generated/Vibestudio.entitlements`. CLI and Xcode builds use
this same scheme action. Signing inputs must remain unchanged during target
execution.
Associated-domain entitlements are emitted only when
`VIBESTUDIO_IOS_PAIR_HOST` or `VIBESTUDIO_IOS_ASSOCIATED_DOMAINS` is set; APNs
is emitted only when `VIBESTUDIO_IOS_APS_ENV` is set.

`mobile doctor` currently checks device signing even when planning a simulator
build. Its signing failures do not prevent the locally signed simulator command above.

## Verification boundary

`mobile smoke --platform ios` is currently unsupported. The Android runner
tests pairing, streamed workspace activation, rendered panels, and recovery;
installing or launching an iOS shell does not establish that coverage on iOS.
Use [the iPhone acceptance checklist](../../../docs/ios-integration-plan.md)
to track the remaining simulator and physical-device verification.

## Pairing And OAuth

The native host handles `vibestudio://connect` and
`https://vibestudio.app/p#...` pairing links, clears any active OTA bundle,
and starts the shipped bootstrap with the URL as a standard launch input. Cold
and warm pairing links share this runtime creation path, so the request survives
replacing a loaded workspace runtime. OAuth URLs continue to use Linking events.

iOS OAuth uses `VibestudioAuthSession` (`ASWebAuthenticationSession`) with
`vibestudio://oauth/callback/<provider>` callbacks. Those OAuth-shaped URLs are
not pairing links and are ignored by the normal deep-link router.
