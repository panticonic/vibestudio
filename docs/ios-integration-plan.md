# iOS Integration - Implementation Record

**Status:** Native iOS implementation exists; end-to-end iPhone verification is
incomplete. The current smoke runner explicitly rejects iOS. This document
records the implementation surface and the evidence still required for acceptance.

## Invariants

- The native host ABI is `rn-host-5` on Android and iOS.
- Workspace app delivery uses the shared streamed bundle mechanism over the
  active paired connection.
- The native shell owns pairing, scanner, paste-link entry, OAuth browser
  sessions, push registration, lifecycle reset, and panel surface hosting.
- iOS signing and associated domains are generated from local configuration;
  static entitlement files are not checked in.
- iOS install and dev flows are CLI-supported for simulator and device builds.
- App-link association is explicit and configuration-gated; the pair page uses
  an explicit user tap before falling back to the custom scheme.

## Work Package Outcomes

| WP                       | Outcome                                                                                                                                                                                   | Primary artifacts                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP-i1 native host parity | Android and iOS use `rn-host-5` and the same streamed delivery module. The shipped entrypoint rejects stale bundle contracts and releases bootstrap transport ownership before reloading. | `apps/mobile/index.js`, `apps/mobile/metroNativeBoundary.cjs`, `packages/mobile-iroh/src/bundleDelivery.ts`, `workspace/apps/mobile/src/services/appBootstrap.ts`                                                                 |
| WP-i2 signing            | Xcode signing configuration is generated locally. Associated domains, camera, notification, and local-network usage are config-driven.                                                    | `scripts/cli/ios-entitlements.mjs`, `apps/mobile/ios/Signing.template.xcconfig`, `apps/mobile/ios/.gitignore`, `apps/mobile/ios/Vibestudio.xcodeproj/project.pbxproj`, `tests/ios-entitlements.test.ts`                           |
| WP-i3 install            | `mobile install --platform ios` builds, installs, and launches simulator/device targets with entitlement generation and CocoaPods checks.                                                 | `scripts/cli/mobile-install.mjs`, `apps/mobile/ios/README.md`, `docs/cli.md`                                                                                                                                                      |
| WP-i4 dev loop           | `mobile dev --platform ios` uses the simctl backend for install, launch, screenshot, and log streaming; mobile-debug documents both Android and iOS backends.                             | `scripts/cli/mobile-dev.mjs`, `scripts/cli/mobile-logs.mjs`, `workspace/extensions/mobile-debug/index.ts`, `workspace/extensions/mobile-debug/SKILL.md`                                                                           |
| WP-i5 OAuth              | iOS OAuth opens through `ASWebAuthenticationSession` and returns through the configured custom scheme without conflating OAuth with pairing.                                              | `apps/mobile/ios/Vibestudio/VibestudioAuthSession.mm`, `workspace/apps/mobile/src/services/oauthLoopback.ts`, `workspace/apps/mobile/src/services/oauthLoopback.test.ts`                                                          |
| WP-i6 pairing entry      | iOS has URL handling, paste-link support, camera permission, scanner wiring, and the same pair-link grammar as Android.                                                                   | `apps/mobile/index.js`, `apps/mobile/ios/Vibestudio/AppDelegate.mm`, `apps/mobile/ios/Vibestudio/Info.plist`, `workspace/apps/mobile/src/components/LoginScreen.tsx`                                                              |
| WP-i7 push               | Push provisioning is surfaced through doctor/config checks and documented alongside Firebase/APNs setup.                                                                                  | `scripts/cli/mobile-doctor.mjs`, `docs/approvals.md`, `apps/mobile/ios/Vibestudio/GoogleService-Info.template.plist`                                                                                                              |
| WP-i8 app surface parity | iOS uses safe-area aware mobile UI, lifecycle reconnect/reset hooks, app update prompts, and inspectable WebViews where supported.                                                        | `workspace/apps/mobile/src/services/appUpdatePrompt.ts`, `workspace/apps/mobile/src/services/shellClient.ts`, `workspace/apps/mobile/src/components/ApprovalSheet.test.tsx`, `apps/mobile/ios/Vibestudio/VibestudioMobileHost.mm` |
| WP-i9 smoke and CI       | Android has end-to-end smoke. iOS smoke is unsupported; CI defines a Debug simulator compilation job, which does not exercise pairing or rendered workspace content.                      | `scripts/cli/mobile-smoke.mjs`, `scripts/full-system-smoke.mjs`, `.github/workflows/build-mobile.yml`, `package.json`                                                                                                             |
| WP-i10 docs and skills   | Mobile, shell, extension, remote-access, onboarding, server-log, and testing skills describe the iOS path and the current ABI.                                                            | `workspace/apps/mobile/SKILL.md`, `workspace/extensions/mobile-debug/SKILL.md`, `workspace/extensions/react-native/SKILL.md`, `workspace/skills/appdev/MOBILE.md`, `workspace/skills/system-testing/SKILL.md`                     |

## CLI Surface

```bash
vibestudio mobile install --platform ios --simulator --launch
vibestudio mobile install --platform ios --device <udid> --launch
vibestudio mobile dev --platform ios
vibestudio mobile logs --platform ios
vibestudio mobile doctor
```

## State And Configuration

- `RN_HOST_ABI = "rn-host-5"` is the cross-cutting contract in the native shell
  and workspace app manifest.
- `apps/mobile/ios/Signing.local.xcconfig` is developer-local and ignored. It
  is included by the checked-in `Vibestudio.Debug.xcconfig` and
  `Vibestudio.Release.xcconfig`, so direct Xcode builds and
  `vibestudio mobile install --platform ios` use the same
  `VIBESTUDIO_IOS_TEAM_ID` and `VIBESTUDIO_IOS_BUNDLE_ID` values.
- Generated entitlements are local build output, not a checked-in source file.
- Associated domains are emitted when a pair host or explicit associated-domain
  entries are configured. Physical-device use also requires matching signing
  and a deployed Apple app-site association file.
- OAuth callback schemes and pair-link association stay separate.

## Verification

```bash
pnpm vitest run tests/ios-entitlements.test.ts tests/remote-overhaul-skill-guard.test.ts --config vitest.host.config.ts
pnpm type-check:userland -- --template system
node scripts/cli/mobile-install.mjs --platform ios --simulator --launch
pnpm smoke:full
```

On non-macOS CI, the iOS-specific entitlement and source-level tests are the
available checks. Simulator compilation and installation require full Xcode on
macOS. An iOS end-to-end smoke implementation remains required.

## iPhone acceptance checklist

Record the source revision, phone/simulator model, iOS version, build
configuration, and captured evidence for each run. Do not mark a step complete
from source-level tests alone.

- [x] Build and launch Debug on a simulator with Metro and Release with its
      bundled bootstrap and no Metro dependency.
- [ ] Fresh pairing through a pasted link and a custom-scheme link downloads
      the workspace bundle and renders interactive workspace content. Invalid and
      expired invites show a useful error and allow another attempt.
- [ ] Send an agent message, observe streamed output, answer an approval, and
      navigate between workspaces and panels.
- [ ] Inspect small and large iPhone layouts: safe areas, home indicator,
      portrait/landscape, keyboard appearance, composer scrolling, and text scaling.
- [ ] Restart the app and confirm credential/cache restoration. Exercise
      background/foreground, server interruption, reconnect, and bundle updates.
- [ ] Verify browser cookie/storage isolation between workspaces and accounts.
- [ ] On a signed physical iPhone, test camera QR pairing, permission denial
      and retry, OAuth browser callbacks, Wi-Fi/cellular switching, and device lock.
- [ ] With real Firebase/APNs provisioning, verify notification permission,
      registration, foreground/background delivery, and navigation after tapping
      a notification from a terminated app.
- [ ] With associated domains configured and deployed, verify HTTPS pairing
      links on the physical phone.
- [ ] Produce a signed Release archive and validate an installed TestFlight
      build before declaring the distribution experience complete.

### Local checkpoint: 2026-09-30

The development Mac has Xcode 27.0 at `/Applications/Xcode.app` and CocoaPods
1.17.0. Command Line Tools remain globally selected; native commands use
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. The iOS 27.0
simulator runtime (24A434, arm64) is installed, and an isolated iPhone 18 Pro
simulator has completed boot. CocoaPods resolves fmt 12.1.0
through the React Native dependency patch, and the native deployment floor is
17.5 to match IrohLib. The unsigned Release simulator build succeeded on
2026-09-30 and contains a 3.8 MB Hermes bootstrap bundle. Build evidence is in
`/tmp/vibestudio-ios-release-linked-20260930.log`. The normal installer now builds, installs, and launches the signed Release app
(`/tmp/vibestudio-ios-install-signed-scenes-20260930.log`). The bundled bootstrap
visibly renders without Metro, rotates into landscape and back, and survives
background/foreground. SDK 27's scene requirement exposed legacy window access
in Firebase Messaging and React Native; dependency repairs use scene windows.
The shared scheme prepares signing inputs before build planning. Startup no
longer reports the Keychain entitlement error. Fresh identity creation, pairing,
workspace execution, and physical iPhone acceptance remain unverified. Device signing and
Firebase configuration are absent. Focused host tests cover
entitlements, pairing-link routing, native Iroh contracts, and mobile tooling;
they are not iPhone execution evidence.

Opening a pairing link while the bootstrap is running currently loses the
pending request: the native URL handler emits it and schedules a reload that
replaces the receiving runtime. A cold-launch link was delivered, but its UI
result has not yet been inspected. Repair and verify warm-link delivery before
marking pairing accepted. The isolated test server and owned simulator were
stopped and awaited before publication; their tracked processes and temporary
instance state were removed.

### Pairing lifecycle repair: 2026-09-30

Cold and warm scene links now start the bootstrap through one native factory
creation path, carrying the URL or browsing activity in standard launch options.
The outgoing root view is released, the legacy bridge invalidated, and the old
factory released before its replacement is created. The warm link no longer
gets emitted to a runtime that is then discarded. The signed Release rebuild
and normal installation succeeded (`/tmp/vibestudio-ios-warm-link-fix-20260930.log`),
and opening a link in the already-running simulator visibly showed the pairing
review with Pair/Cancel buttons. Pairing itself still awaits completion.

The user confirmed that a physical phone, developer signing, Firebase/APNs, and
App Store Connect access are unavailable now. TestFlight's 90-day build expiry
is acceptable for beta distribution. Assess the streamed executable workspace
bundle design against Apple's review requirements before relying on TestFlight
or App Store approval. Continue independent simulator acceptance work.

### Latest verification: 2026-09-30

Pairing with the live isolated `iphone-20260930-0220` server reached System
workspace trust review. The earlier connection failure used an invitation for
an already-stopped instance; no transport workaround was added. Debug install
and Metro connection passed after repairing SDK/product selection for explicit
simulator UDIDs. Workspace-guided installation now preserves simulator targets,
and discovery excludes other Apple platforms and Macs. Streamed activation,
rendered workspace use, and recovery remain unverified because Computer Use
cannot currently access native windows. The owned server, Metro, app, and exact
simulator were stopped; retained ephemeral state was removed after ownership
verification. See the latest handover checkpoint for the observed shutdown
signal defect and remaining deployment gaps.

### Source gap closure: 2026-09-30

The preceding window/shutdown/deployment source-gap checkpoint is historical.
Published repairs align numeric iOS app versions with root SemVer, inspect and
reuse compatible installed iOS apps, share custom signing/bundle configuration,
and make simulator doctor independent of physical signing. The normal installer
and real simulator discovery verified the version/compatibility result.

Developer shutdown now retains one signal owner through ordered retirement and
state cleanup; the real CLI launch exited zero with all tracked descendants gone
and its ephemeral root removed automatically. Native Iroh runtime invalidation
now closes transient resources and preserves identities. Two app-hosted native
XCTest cases passed, including a pending accept and replacement-runtime rebind.
See the latest handover for commits and private evidence paths.

Pairing remains verified through System workspace trust review. Native capture
briefly recovered, then returned `cgWindowNotFound` again. Workspace Start also
awaits its specific access-grant confirmation. Streamed panels, agent messaging,
restoration, reconnect, and full mobile layout acceptance remain open. Physical
phone, signing, Firebase/APNs, and App Store Connect access remain unavailable.

### Deployment decision

Continue the existing System phone setup extension and desktop provisioning
service. On a Mac, use its existing native build/install operation with the user's
Apple signing configuration; reuse a compatible installed shell for pairing.
No separate iPhone installer or credential service is needed.

For users without a Mac, TestFlight remains a candidate, not an available release.
Apple permits testing a build for up to 90 days and reviews the first external
beta build. See [Apple's TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

The current host downloads and activates executable React Native workspace
bundles and exposes native modules. My assessment is that review eligibility is
unresolved: guideline 2.5.2 restricts downloaded feature-changing code; its limited
educational exception requires viewable, editable source. Guideline 4.7 permits
certain external software but requires permission for native API exposure and
adds consent, indexing, moderation, and age-rating obligations. A trust review
alone does not establish compliance. See [Apple's review guidelines](https://developer.apple.com/app-store/review/guidelines/).

Resolve this with Apple against the actual architecture before promising beta
self-installation. Do not add a hidden review mode or a second runtime to disguise
execution. If approval cannot accommodate the design, a product-level execution
model decision is required; missing signing credentials are a separate blocker.

### Expanded native verification

All five native XCTest cases passed on iPhone 18 Pro / iOS 27: Iroh retirement
and identity reuse, OAuth timeout/session retirement and module release, rejection
after invalidation, and owned temporary-file cleanup with committed-file
preservation. Browser-import callbacks now share the module's serial queue.
The CI-equivalent generic signed Debug build passed for arm64 and x86_64.
Private logs and results are referenced in the handover.

The owned server, Metro, console sessions, builds/tests, and simulator were
retired and awaited; all eight tracked server processes and its temporary root
are gone. Recreate an isolated instance and fresh invitation for interactive
continuation. The open acceptance items above remain open.

### Interactive rendering checkpoint

With the screen awake, Device Hub capture and interaction worked and the user
approved the isolated System workspace. Streamed activation reached the managed
app. Published native repairs retain scene-owned status-bar appearance and send
only actual file URLs to WebKit’s file loader; blank/data/HTTPS/panel requests
use the normal loader. All nine app-hosted native tests passed on iOS 27 after
recovering runtime registration and discovery following the machine restart.

Interactive acceptance remains open. A native sample identified a descriptor
registry/UIKit lock inversion while the app displayed “Opening your
workspaces…”. Construction outside the registry publication lock is published
as `7ea12683d` and passes the concurrent-reader native regression. Do not mark panel use, messages, keyboard,
cache recovery, or reconnect complete until the repaired app visibly performs
those flows. The handover records source commits and private evidence paths.

### Approval control verification

System `9d3de21` preserves approval-sheet accessibility children and marks its
visible title as a heading. All 49 UI unit cases and the composed System
mobile typecheck pass. The simulator now exposes search, filters, checkboxes,
dismissal, and the decision action individually. System `6de53eb` makes the
shared surface honor its queue's closed state; five surface tests pass, including
closing without a decision and reopening the same request. Its native dismissal
check is in progress on `iphone-20260930-visibility`.

Host `1d118f7ec` extends the iOS CI job with native XCTest execution and result
artifacts. The runner creates and cleans its own compatible simulator. Local
selection/create/delete validation and all nine native tests passed; a hosted
run has not been observed. This coverage is separate from full workspace smoke.
Warm pairing from a running managed app and cancel/reopen retry have now been
observed. Interactive panel/message and restart acceptance remain open.

### Native live acceptance — 2026-09-30

The native null bridge and WebView handler/script lifecycle fixes (`8edac9bdf`,
`8ec386b28`) now permit real workspace panels to render. Eleven native cases
passed together; both new WebKit regressions passed after the script inventory
ownership repair. The isolated iPhone navigated to chat, submitted a message,
applied one-use account approvals, and displayed **iPhone verification complete.**
Server restart recovery retained that conversation. Lookup and fetch each prompted
for credential approval; waiting on the second approval consumed the model stream
progress timeout. That admission flow remains an investigation item.

System `bd6ad2c` centralizes native modal orientations and `c4b7114` makes the
workspace screen resize above the iOS keyboard. Both composition/mobile typechecks
and 97 relevant sheet tests passed across focused runs. Live verification uses a
fresh isolated snapshot because a persistent restart does not reread templates.
The refreshed bundle's keyboard/rotation verification is still in progress.
Hosted iOS CI was manually dispatched as run `36706691764`; successful ordinary
push runs skipped that job. Device provisioning and distribution remain unavailable.
See the latest handover checkpoint for exact evidence and owned-resource cleanup.

### Panel-owned screen-edge geometry (2026-09-30)

The app keeps panel canvases edge to edge. It does not add a safety strip or
force panel padding. The mobile host publishes optional measured CSS properties
`--vibestudio-safe-area-inset-top/right/bottom/left` and the appearance hint
`--vibestudio-viewport-corner-radius-hint`. The shared UI foundation supplies
browser `env()` defaults. Panels opt into these values for their own controls;
scroll viewports retain their full canvas, with any spacing applied to content.
Chat uses this contract for its composer and coordinates nested surface curves.
The radius hint is approximate and uses no private hardware API.

Hosted workflow [36706691764](https://github.com/panticonic/vibestudio/actions/runs/36706691764)
passed the iOS Debug simulator build and all 13 app-hosted native tests together.
Touch settings/composer and measured geometry source checks pass; final combined
native keyboard/rotation acceptance is still being exercised in an isolated
fixture. Physical hardware, signing, APNs/Firebase, and distribution access remain
external acceptance requirements.

Directional corner hints are now published separately for all four panel corners
(System `d8475d1`). The host derives exposure from the measured panel/window
edges, so a header or keyboard removes hints for the corners it excludes. Base
`f49920d` rounds only the composer bottom corners with these hints; its top
corners retain the normal card radius. Five geometry tests, 22 chat tests, both
composition typechecks and checkout hygiene pass. Final native visual acceptance
is tracked in the handover. A newly captured long-lived Debug/Metro reload
assertion remains a separate native lifecycle gap; hosted native tests do not
cover that sequence.

Native acceptance on the fresh corner fixture confirms ordinary top composer
corners, larger exposed bottom corners, portrait keyboard flattening, draft
preservation across rotation, and mobile settings scrolling/Advanced expansion.
There is no separate native safety strip. Landscape software-keyboard accessory
overlap remains open, as does the separate Debug reload assertion. Owned test
resources were stopped and awaited, simulator keyboard capture was restored,
and the owned simulator and retired fixture state were cleaned up.
