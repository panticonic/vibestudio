# Vibestudio iOS Native Project

The iOS shell requires iOS 17.5 or later, matching its pinned IrohLib package.
Workspace browser profiles use the iOS 17 WebKit APIs. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
The native contract version is `RN_HOST_ABI` in `@vibestudio/shared/buildProvider`.

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
Xcode 27 compiler. The same patch owns queued Fabric surface starts through
stop/reset so Debug runtime reloads cannot attach a root view twice. Native
regressions cover duplicate starts and cancellation before main-queue attachment.
The app uses `SceneDelegate` to own the window and creates
React Native through its factory. Firebase Messaging has a dependency patch to
find root views through connected scenes and receive scene foreground events;
its upstream implementation still assumes a window on the application delegate.

UIKit requires the scene lifecycle for apps built with SDK 27. See Apple's
[scene migration guide](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).

For physical-device builds, configure signing first:

```bash
cp hosts/ios/Signing.template.xcconfig hosts/ios/Signing.local.xcconfig
vibestudio mobile doctor
vibestudio mobile install --platform ios --device <udid> --launch
```

`Signing.local.xcconfig` is gitignored and holds user-specific Apple signing
settings. The shared `Vibestudio` scheme prepares signing entitlements before
build planning by running `scripts/cli/ios-entitlements.mjs`, which writes
`hosts/ios/Generated/Vibestudio.entitlements`. CLI and Xcode builds use
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
cd hosts/ios
xcodebuild -workspace Vibestudio.xcworkspace -scheme Vibestudio \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -only-testing:VibestudioNativeTests \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

Use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if the Mac's global
developer directory selects Command Line Tools. Native coverage also includes
explicit asset-cache misses (`VibestudioPanelHost`), host-only and capability gating of native modules, picker cancellation, and concurrent descriptor
construction. Interactive workspace acceptance uses the separate checklist below.

`mobile smoke --platform ios` is currently unsupported. The Android runner
tests pairing, streamed workspace activation, rendered panels, and recovery;
installing or launching an iOS shell does not establish that coverage on iOS.
Use [the iPhone acceptance checklist](../../docs/ios-integration-plan.md)
to track the remaining simulator and physical-device verification.

## Pairing And OAuth

The host runtime (module `VibestudioHostRuntime`) starts in the app delegate,
before any scene, and runs the app's own bundle headlessly; the first scene
presents its root view. `vibestudio://connect` and
`https://vibestudio.app/p#...` pairing links never restart React Native: the
scene delegate hands them to `VibestudioClientManager`, which delivers them to
the host's JavaScript through the Linking module once the host has called
`markReady`. Client apps run in their own React Native instances from verified
bundle files (`VibestudioClientBroker` is their only door to the device).

iOS OAuth uses `VibestudioAuthSession` (`ASWebAuthenticationSession`) with
`vibestudio://oauth/callback/<provider>` callbacks. Those OAuth-shaped URLs are
not pairing links and are ignored by the normal deep-link router.

## Launch surfaces (App Intents, quick actions, widgets, share extension)

Design: `docs/client-hosts-and-clients-plan.md` sections 4.7 and 5.4. The host
runtime's JavaScript publishes the whole launch-surface set (`LaunchSurfaces`
in `hosts/react-native/src/host/integration.ts`) after launch and on every
`clients:changed` event, through `VibestudioHostRuntime.publishLaunchSurfaces`.
Native writes that JSON atomically to `launch-surfaces.json` in the App Group
container and then sets `UIApplication.shortcutItems`, calls
`VibestudioShortcuts.updateAppShortcutParameters()` and
`WidgetCenter.shared.reloadAllTimelines()`. Every consumer decodes that one file.

| Piece | Where | Target |
|---|---|---|
| Snapshot model, quick-action ordering, share routing | `Vibestudio/LaunchSurfaces/LaunchSurfacesModel.swift` | app, widgets, share extension |
| App Group snapshot store | `LaunchSnapshotStore.swift` | app, widgets, share extension |
| `ClientEntity` and its query | `ClientEntity.swift` | app, widgets |
| Share inbox (enqueue / ordered drain) | `ShareInbox.swift` | app, share extension |
| Events to the host runtime, publisher | `LaunchSurfacesPublisher.swift` | app |
| `OpenClientIntent`, `AskIntent`, `AppShortcutsProvider` | `LaunchIntents.swift` | app (not an extension: the app must call `updateAppShortcutParameters()`) |
| Widget and Control Center control | `VibestudioWidgets/` | widget extension |
| Share extension | `VibestudioShareExtension/` | share extension |
| Tests | `VibestudioNativeTests/LaunchSurfacesTests.swift` | native tests |

Flow:

- Intents, quick actions and the host: `OpenClientIntent` (foreground) and
  home-screen quick actions emit a `link` host event; `AskIntent` emits
  `background-intent` `{name, text, clientId}` and answers "Asking ...". The
  headless host instance (started in `AppDelegate`, before any scene) serves it
  and shows the answer as a notification. Events wait in the client manager until
  the host runtime calls `markReady`; there is no timeout.
- Widgets and controls have no text input, so the widget and the iOS 18 control
  open the client (`Link`, `widgetURL`, `OpenURLIntent`) and the client's composer
  takes the question. Typed Ask is the Siri / Shortcuts / Action button intent.
- Share-in: the extension reads `shareIn` from the snapshot to name accepting
  clients, writes `ShareInbox/<id>.json` to the App Group, and posts a local
  notification. It never dials the server. `sceneDidBecomeActive` drains the inbox
  oldest first and emits `share-in` `{mimeType, text}`, deleting each file once its
  event was handed to the host runtime. The event carries no client id, so the
  host's JavaScript routes by MIME as on Android.
- Live Activity: not applicable. No APNs ActivityKit push trigger exists (the
  server never pushes ActivityKit tokens), so nothing is built.

### Xcode registration

Registered in `project.pbxproj`: the six app sources under
`Vibestudio/LaunchSurfaces/` (app target Sources phase) and
`LaunchSurfacesTests.swift` (native tests target). The app's `Info.plist` carries
`VibestudioAppGroup = group.$(VIBESTUDIO_IOS_BUNDLE_ID)`, which every target reads
to find its App Group, so a locally overridden bundle id stays consistent.

Not registered (create in Xcode; no Xcode was available when this was written):

1. App Group entitlement. `scripts/cli/ios-entitlements.mjs` generates the app's
   `Generated/Vibestudio.entitlements`; it must also emit
   `com.apple.security.application-groups` = `group.<VIBESTUDIO_IOS_BUNDLE_ID>`.
   Enable the App Groups capability for that identifier in the developer portal.
2. Widget extension target: File > New > Target > Widget Extension (uncheck Live
   Activity and Control; the control is in the same source). Name
   `VibestudioWidgets`, bundle id `$(VIBESTUDIO_IOS_BUNDLE_ID).widgets`, deployment
   target 17.5, Swift 5. Delete the template sources; add
   `VibestudioWidgets/VibestudioWidgets.swift` plus, by reference (not copy),
   `Vibestudio/LaunchSurfaces/LaunchSurfacesModel.swift`,
   `LaunchSnapshotStore.swift` and `ClientEntity.swift`. Set
   `INFOPLIST_FILE = VibestudioWidgets/Info.plist` and
   `CODE_SIGN_ENTITLEMENTS = VibestudioWidgets/VibestudioWidgets.entitlements`.
   Link WidgetKit, SwiftUI and AppIntents.
3. Share extension target: File > New > Target > Share Extension, name
   `VibestudioShareExtension`, bundle id
   `$(VIBESTUDIO_IOS_BUNDLE_ID).share`, deployment target 17.5, Swift 5. Delete the
   template sources and storyboard; add
   `VibestudioShareExtension/ShareViewController.swift` plus by reference
   `LaunchSurfacesModel.swift`, `LaunchSnapshotStore.swift` and `ShareInbox.swift`.
   Set `INFOPLIST_FILE = VibestudioShareExtension/Info.plist` (principal class is
   `$(PRODUCT_MODULE_NAME).ShareViewController`) and
   `CODE_SIGN_ENTITLEMENTS = VibestudioShareExtension/VibestudioShareExtension.entitlements`.
4. Embed both: Vibestudio target > General > Frameworks, Libraries, and Embedded
   Content, or Build Phases > "Embed Foundation Extensions" (destination
   PlugIns), adding both `.appex` products, and add both as target dependencies.
5. Podfile: the extensions use no pods. Do not add them to a Podfile target.
6. Universal links: the generator already emits `applinks:<pair host>`; the
   host's `apple-app-site-association` must list `/c/*` for
   `https://vibestudio.app/c/<id>/<intent>` to open the app.
