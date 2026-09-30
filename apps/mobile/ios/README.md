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

The native marketing version comes from the root application's SemVer through
`Vibestudio.Version.xcconfig`. Run `pnpm generate:mobile-version` after changing
the root version; `pnpm check:mobile-version` and the commit gate reject stale
metadata. Apple marketing versions contain the numeric major/minor/patch;
desktop compatibility compares that same core version. Debug and Release use
the generated app configuration without overriding CocoaPods target metadata.

## Local Signing

For simulator testing, install full Xcode with an iOS simulator runtime and
CocoaPods, then boot exactly one iPhone simulator in Xcode. A developer team or
signing identity is not required for the simulator. The installer builds,
installs, and launches on that simulator's UDID:

```bash
node scripts/cli/mobile-install.mjs --platform ios --simulator --launch
```

When multiple simulators are booted, add `--device <simulator-udid>` to select
one explicitly. `mobile dev --platform ios --device <simulator-udid>` forwards
the same selection for its Debug build. SDK selection and the built-product
directory follow `--simulator`, including when a UDID is supplied.

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

Use `mobile doctor --platform ios --simulator` to check simulator prerequisites.
`mobile doctor --platform ios` also checks physical-device signing. APNs
configuration uses `VIBESTUDIO_IOS_APS_ENV=development|production`, matching
the entitlements generator.

Device discovery inspects the selected bundle through CoreDevice, including
non-development installations. It uses the same local/environment bundle ID
configuration as the installer. Workspace phone setup reuses a compatible
installed app and verifies compatibility again after an installation.

## Verification boundary

The shared scheme includes app-hosted native XCTest coverage for Iroh runtime
retirement. It verifies that a pending native accept ends on invalidation, the
retired module is released, and a replacement runtime can reuse the persistent
identity. The same target verifies OAuth cancellation and cleanup of interrupted
bundle, asset, and browser-import transfers while preserving committed files.
It also verifies scene-owned status-bar updates and WebView URL routing: only
file URLs use WebKit’s file loader; blank, data, HTTPS, and panel URLs use normal
requests. Real WebKit fixtures verify startup adapter ordering, inherited message
delegation, and script rebuilds. Native notification tests cover JSON fragment
arguments and malformed requests. Run it on an available simulator:

```bash
cd apps/mobile/ios
xcodebuild -workspace Vibestudio.xcworkspace -scheme Vibestudio \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -only-testing:VibestudioNativeTests \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

Use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if the Mac's global
developer directory selects Command Line Tools. Native coverage also includes
explicit asset-cache misses, picker cancellation, and concurrent descriptor
construction. Interactive workspace acceptance uses the separate checklist below.

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
