# iOS Integration — One-Shot Plan (self-built client, full parity)

**Status:** Planned, not started. This is a **single big-bang change set**: every
work package lands together, none is optional, none is deferred, no feature flag
gates any of it. Anything it replaces is **deleted in the same change** — zero
backward compatibility, zero migration shims (the same rule
`remote-ux-overhaul-plan.md` and `webrtc-rpc-v2-plan.md` set).

**Prerequisite:** this plan assumes `docs/remote-ux-overhaul-plan.md` (now
frozen) has landed. It builds directly on WP1 (hosted signaling), WP4
(complete invites), WP5 (desktop Connect-a-device), WP6 (https pair-link
carrier + app-link infra), WP7 (prebuilt shell, in-shell scanner), and the
§6.1 full-system smoke. It also **supersedes that plan's iOS touchpoints** —
the precise, line-anchored list is §0.5; where the two documents disagree
about iOS, this document wins.

**Audience:** a fresh agent with no prior context. Section 0 contains
everything you need to know about how mobile works today, what iOS already
has, and why each decision was made. Read it before touching code.

**Binding design rules** (inherited, still in force):

- Fail loud, never mask.
- One mechanism per job. A platform difference is a different mechanism only
  when the platforms genuinely differ; otherwise it is one implementation.
- The server binds loopback only, forever; phones reach it exclusively over the
  fingerprint-pinned WebRTC pipe.
- Test the negative (every "refuses to X" claim gets a test).
- No compatibility: replaced code is deleted in this change set.

---

## 0. Background

### 0.1 The two-layer model, and what iOS already has

The mobile client is two layers (`workspace/skills/appdev/MOBILE.md`):

1. **Native host shell** (`apps/mobile/`, bare React Native 0.79.2, Hermes,
   New Architecture off). Owns first pairing (`vibestudio://connect`), durable
   credentials, and fetching/verifying/activating the OTA workspace-app bundle.
   Server-agnostic: nothing in the binary binds it to a server.
2. **Workspace app** (`workspace/apps/mobile/`), delivered over-the-air from
   whichever server the phone is paired to, streamed over the WebRTC pipe via
   `gateway.fetch`, integrity-verified, RN-reloaded.

**"iOS support" is therefore mostly a shell problem.** The workspace app, the
transport, and the server are already platform-neutral or better:

- `apps/mobile/ios/` is a **real, configured Xcode project**, not a stub:
  bundle id `app.vibestudio.mobile`, iOS 15.0 deployment target, Hermes on,
  Fabric off (`ios/Podfile:4-44`), a hand-authored `project.pbxproj` that
  compiles `AppDelegate.mm`, `VibestudioMobileHost.mm`, `main.m`
  (`project.pbxproj:248-252`), full icon assets, launch screen.
- `AppDelegate.mm` already implements the OTA loading contract: `bundleURL`
  reads `activeBundle.localPath`/`activeBundle.integrity` from NSUserDefaults,
  re-verifies SHA-256, falls back to Metro (debug) or `main.jsbundle`
  (`AppDelegate.mm:71-112`) — the exact iOS analog of Android's
  `getJSBundleFile()` (`MainApplication.kt:27-28`).
- `VibestudioMobileHost.mm` (731 lines) has working Keychain credential
  storage (`SecItem*`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
  `:585-637`), SHA-256 verification (`:525-541`), path-traversal-validated
  bundle writes to `NSCachesDirectory/vibestudio-rn/…` (`:543-568`), and
  `activatePreparedAppBundle` → NSUserDefaults + `RCTReloadCommand`
  (`:282-314`).
- `Info.plist` registers the `vibestudio` URL scheme (`:49-59`), declares
  `UIBackgroundModes: remote-notification, fetch` (`:27-31`), and scopes ATS
  cleartext to loopback for local dev (`:72-93`).
- `Vibestudio.entitlements` exists (associated domains for
  `applinks:vibestudio.app` / `webcredentials:vibestudio.app`) but is **not
  referenced by any build setting** — it currently does nothing.

### 0.2 What already works for iOS with zero code changes

Do not rebuild any of this; it is done and platform-symmetric:

- **The server already builds iOS bundles.** The React Native build provider
  loops `for (const platform of ["android", "ios"])` and Metro-bundles each
  (`workspace/extensions/react-native/index.ts:41,104-143`), emitting
  `index.ios.bundle` (role `primary`, `platform:"ios"`) plus `assets/ios/*`,
  streamed into the content-addressed build store with per-artifact
  `sha256-…` integrity and a set integrity that includes `platform`
  (`src/server/buildV2/buildStore.ts:184-220`). Metro bundling needs no
  Xcode, so a Linux server serves iOS phones without any macOS involvement.
- **The bootstrap manifest is per-platform by contract.**
  `getReactNativeBootstrap` requires each primary artifact to be tagged
  `android` or `ios`, no dupes (`src/server/appHost.ts:1279-1302,2910-2918`),
  and the shell bootstrap already selects `platform:"ios"`
  (`apps/mobile/index.js:147-154,297`, `platformName()` at `:63-65`).
- **The entire pairing/transport/credential JS layer.**
  `packages/mobile-webrtc/` (fingerprint pinning through the shared
  `parseSdpFingerprint`, `reactNativeWebRtcPeer.ts:410-418`; Keychain
  credential store via `react-native-keychain`, `connect.ts:140-189`; NetInfo/
  AppState reconnect nudges, `connect.ts:206-244`) and the workspace app's
  `mobileTransport.ts`, `shellClient.ts`, `panelAssetFacade.ts` (loopback
  HTTP/1.1 façade on `react-native-tcp-socket` + in-memory LRU) are
  platform-neutral RN; every native dep in play ships iOS pods.
- **Push is iOS-capable end to end in code.** The server builds real APNs
  payloads through Firebase Admin (`apns-push-type`, priorities, categories —
  `src/server/services/pushService.ts:181-247`, tested); the client branches
  `platform: Platform.OS === "ios" ? "ios" : "android"` and builds Notifee
  `ios:{categoryId}` payloads (`pushNotifications.ts:189,214-244`). What's
  missing is provisioning and entitlements, not code (§WP-i7).
- **Approvals, launch gate, deep-link replay guard, background action
  queue** — all JS, all platform-neutral in *code*. The queue's execution
  semantics differ on iOS (no foreground services; suspension kills the
  pipe), which is why lifecycle behavior is specified work (WP-i7, WP-i8),
  not assumed done.

### 0.3 Gap inventory (the reason for every work package)

- **G1 — The iOS native module is stale against the current ABI.**
  `index.js` streams the bundle over the pipe chunk-by-chunk via
  `nativeHost.appendBundleChunk(...)` and `nativeHost.finalizeBundleWrite(...)`
  (`apps/mobile/index.js:251,314`). Android implements both
  (`VibestudioMobileHostModule.kt:313-392`); **`VibestudioMobileHost.mm`
  implements neither.** The iOS module instead still carries the pre-WebRTC
  HTTP-direct flow (`pairServer` `:81`, `listWorkspaces` `:115`,
  `selectWorkspace` `:155`, `prepareAppBundle` `:222-280` with `NSURLSession`
  `getData:` `:460`, `postJson` `:533`, and the same-origin assertion
  `ensureSameOriginArtifactUrl` `:565`) — a model that cannot work when the
  server binds
  loopback only and there is no reachable origin. On iOS today the bootstrap
  dies at the first chunk. → WP-i1.
- **G2 — The workspace-app self-update path is orphaned and broken, on both
  platforms.** The HTTP-direct native path is not a harmless legacy twin: it
  is wired to a live UI affordance. The "app update available" prompt
  (`workspace/apps/mobile/src/services/appUpdatePrompt.ts`, mounted from
  `MainScreen.tsx:46`) drives `auth.ts:198-230` → native `prepareAppBundle`,
  which reads a module-internal credential store (it needs a `serverUrl`)
  written **only** by `pairServer` and `selectWorkspace` — and neither is on
  any live code path: `pairServer` has no production JS caller (mocks only),
  and `selectWorkspaceAndRun` (`index.js:692-706`) is dead because its
  `pendingWorkspaces` is never populated. A phone paired the modern WebRTC
  way has an empty module store, so tapping "Install" throws
  `"No mobile credentials are stored"`. Net: there is **one working delivery
  mechanism** (the streamed path, shell bootstrap only) and **one broken
  orphan** occupying the self-update seat. Deleting the orphan is safe;
  replacing self-update with the streamed mechanism is real net-new work
  this plan delivers, not a deletion. → WP-i1.
- **G3 — No iOS build/install/dev/test tooling exists at all.** No
  `xcodebuild`, `xcrun`, `simctl`, or `devicectl` invocation anywhere in the
  repo; no `Podfile.lock`; `mobile install|dev|smoke|logs|emulator` are
  adb/gradle-only (`scripts/cli/mobile-*.mjs`); the `mobile-debug` workspace
  extension is adb-only (`workspace/extensions/mobile-debug/index.ts:13-70`).
  → WP-i3, WP-i4, WP-i9.
- **G4 — No signing story.** The pbxproj has no team, no automatic signing,
  and the entitlements file is unwired (`project.pbxproj:342,425`; no
  `CODE_SIGN_ENTITLEMENTS`). Every user must be able to sign with **their
  own** Apple identity — this is a *user-specific self-built* client by
  design. → WP-i2.
- **G5 — No OAuth on iOS.** Android runs a native loopback HTTP server plus a
  foreground keep-alive service (`OAuthLoopbackModule.kt`,
  `OAuthLoopbackKeepAliveService.kt`); iOS has no counterpart, and the
  loopback-socket model is wrong for iOS anyway (no foreground services, no
  guarantee the process survives a Safari round-trip). → WP-i5.
- **G6 — The connect-intent reset is Android-only.** `MainActivity.kt:41-59`
  clears the active OTA bundle and restarts when a `vibestudio://connect`
  intent arrives, so re-pairing always lands in the shell bootstrap. iOS has
  the scheme registration but not the reset. → WP-i1.
- **G7 — iOS pairing entry differs structurally.** The iOS camera does not
  fire custom-scheme QRs the way Android's does; the https pair-link carrier
  (overhaul WP6) and the in-app scanner (overhaul WP7) are the load-bearing
  entry points on iOS, and both need iOS-specific wiring: camera permission
  strings, associated-domain entitlements, and an AASA story that survives
  user-specific signing (§0.4 D3). → WP-i6.
- **G8 — Push provisioning and the entitlement trap.** APNs requires an
  `aps-environment` entitlement, which **free personal Apple teams cannot
  have**; unconditionally including it breaks signing for exactly the users
  the self-build flow serves. Firebase iOS config is template-only
  (`GoogleService-Info.template.plist`). → WP-i2, WP-i7.
- **G9 — Small genuinely-Android-only patches in the workspace app.**
  Hardware-back handling is `Platform.OS === "android"`-guarded with no iOS
  equivalent for panel history/parent activation
  (`MainScreen.tsx:1283`); `webviewDebuggingEnabled` is Android-gated
  (`PanelWebView.tsx:879`) although react-native-webview maps it to
  `isInspectable` on iOS 16.4+. → WP-i8.
- **G10 — Doc/infra placeholders.** `apps/well-known/config.json` carries
  `TODO_TEAM_ID`; `apps/mobile/ios/README.md` still describes regenerating the
  project by hand; `Info.plist` declares stale `UIRequiredDeviceCapabilities:
  armv7`; the entitlements file carries a `TODO(release)` developer-mode
  marker. → WP-i2, WP-i10.

### 0.4 Design conclusions (the reasoning — don't re-litigate)

1. **D1 — Self-build is the iOS distribution mechanism, full stop.** The
   product model is a *user-specific, self-built* client: each user builds the
   shell with their own Apple identity and installs it on their own devices,
   exactly as Android users build and sideload their own APK. Apple's platform
   rules make this the only mechanism that requires no distribution
   infrastructure — and we want none. **This amends overhaul WP7:** the
   "TestFlight publishing from CI" and App Store ambitions are deleted from
   scope; CI proves buildability and runs the simulator smoke but publishes no
   iOS artifact. The pair page's iOS not-installed guidance (overhaul WP6)
   points at the self-build instructions, not a store.
2. **D2 — One bundle-delivery mechanism, everywhere, shared by both callers.**
   The streamed pipe-delivery path (`gateway.fetch` → `appendBundleChunk` →
   `finalizeBundleWrite` → `activatePreparedAppBundle`) is the only way a
   bundle reaches a phone. Its JS orchestration is extracted out of
   `index.js` into a shared module so both JS contexts — the shipped shell
   bootstrap and the OTA workspace app (self-update) — run identical code
   over their own transports. The HTTP-direct fetch path, its
   pairing/workspace-selection cousins, and the module-internal credential
   store they fed are deleted on **both** platforms. The native ABI moves to
   `rn-host-2` so stale bundles fail closed (`MOBILE.md:124-131` is the ABI
   contract; note that MOBILE.md's pairing-flow steps 7–10 still describe
   the deleted HTTP sequence — that section is stale, not authoritative, and
   is rewritten in WP-i10).
3. **D3 — Universal links are an optimization; the trampoline is the
   guarantee.** AASA verification binds to `teamId.bundleId`. Self-built apps
   carry the user's team ID, which a hosted AASA cannot enumerate — so
   universal-link direct-open **cannot** be the required path. The required
   path is the one that works for every team ID: https pair QR → pair page
   reads the fragment client-side → **explicit "Open in Vibestudio" tap**
   fires `vibestudio://connect` → app. On iOS the scheme is never
   auto-fired — that is the overhaul plan's hijack-hardening rule (WP6:
   scheme fallback is explicit-tap only, because iOS cannot scope scheme
   registration and the link carries a one-time code), and this plan keeps
   it. AASA direct-open remains wired and works whenever the
   deployed well-known config lists the app identity (self-hosters deploy
   their own well-known with their own IDs — the env-var override plumbing
   already exists, `apps/well-known/build.ts`). One grammar, one parser, per
   overhaul WP6.
4. **D4 — OAuth on iOS is `ASWebAuthenticationSession` with a custom-scheme
   callback.** No loopback socket, no keep-alive service, no associated-domain
   dependency — which also keeps OAuth working under user-specific signing.
   Android keeps its loopback mechanism; this is a genuine platform
   difference, so two mechanisms are correct, behind one JS seam.
5. **D5 — Signing/entitlements are per-user configuration, generated at build
   time, never committed.** A gitignored local signing config supplies team
   ID and capability toggles; the build generates the entitlements file from
   it (push entitlement only when push is provisioned, associated domains only
   when configured). Committing anyone's identity, or an entitlement the
   signer can't satisfy, is a build error by construction.
6. **D6 — Simulator-first dev loop, device parity via the same pipe.** The
   iOS Simulator shares the host network namespace, so Metro, signaling, and
   the gateway are reachable on `127.0.0.1` with **no port-forwarding step at
   all** (no `adb reverse` analog needed) and no TURN (the loopback ICE path
   holds). Physical devices use exactly the production path: real signaling +
   the WebRTC pipe. Deep links: `simctl openurl` on simulators; on devices the
   OS camera scanning the https pair QR is the entry (no `openurl`
   equivalent exists, and none is needed).
7. **D7 — macOS coupling is stated, not smoothed over.** Building/installing
   the iOS shell requires macOS + Xcode. `mobile install --platform ios` on a
   non-mac fails loudly naming the requirement. Nothing else in the system
   needs macOS: a Linux server builds and serves the iOS OTA bundle (§0.2).
8. **D8 — No CDP on iOS panels, by design.** WKWebView exposes no CDP;
   brokered panel automation stays desktop-hosted (`apps/mobile/README.md:
   24-36`). Mobile panels expose the `_agent.*` bridge on both platforms.
   Documented, not worked around.

### 0.5 Precise amendments to the (frozen) overhaul plan

The overhaul plan is final and lands first; this plan supersedes the
following iOS touchpoints in it. WP-i10 annotates each in that document, and
the implementer rule is: **do not build what this plan immediately deletes**
— if both change sets are staffed together, implement the mobile-packaging
work as one motion.

1. **WP7's iOS bullet (`remote-ux-overhaul-plan.md:626-631`):** "TestFlight
   publishing from CI on tagged releases" is deleted (D1 — self-build is the
   distribution). The rest of the bullet (CocoaPods lockfile in CI,
   `mobile install --platform ios` via `xcodebuild`, pair-host entitlement)
   is subsumed by WP-i2/i3/i6, with entitlements generated and config-gated
   rather than unconditional.
2. **WP6's pair-page iOS install guidance (`:525`,** "TestFlight/App Store
   for iOS per WP7"**):** replaced by self-build instructions (WP-i6).
3. **"the AASA side of WP6 filled with the real team/bundle IDs" (`:629`):**
   the hosted AASA carries no enumerable iOS app identities — self-built
   team IDs cannot be listed. AASA population is per-deployment
   configuration (D3, WP-i6); the explicit-tap trampoline is the guarantee.
4. **The CLI-surface row (`:824`) implying prebuilt-by-default for
   `--platform ios`:** no prebuilt iOS artifact exists or can (unsigned IPAs
   don't install); on iOS `mobile install` is always the signed self-build
   (WP-i3).
5. **The §6 iOS test bullet (`:962-965`) and §8's "TestFlight keeps the
   install path real" hazard clause (`:991-992`):** superseded by WP-i9's
   full simulator smoke and the D1 distribution model — device verification
   stays a manual per-release checklist; nothing TestFlight-shaped exists.

---

## 1. Target experience — the golden paths

These transcripts are the acceptance spec. Every command must exist and behave
exactly as shown when this plan lands.

### Path A — iPhone, from a Mac, one command

```
$ vibestudio mobile install --platform ios
✓ Xcode 16.x · CocoaPods 1.15 · pods installed
✓ Signing        team 8XYZ… (personal team, from ios-signing config)
✓ Entitlements   generated (push: off — no APNs provisioning found)
✓ Build          Release · app.vibestudio.mobile
✓ Device         "Gabriel's iPhone" (devicectl) — installed & launched

  Pair it: open Devices → Connect a phone on your desktop and scan the QR
  with the iPhone camera, or scan from inside the app.
  Note: personal-team installs expire after 7 days; re-run this command.
```

Phone camera scans the desktop's https pair QR → pair page → app opens →
confirmation sheet → paired over WebRTC to whatever server the desktop is on →
workspace app streams OTA and reloads. Identical to Android Path B of the
overhaul plan.

### Path B — simulator dev loop

```
$ vibestudio mobile dev --platform ios
✓ Simulator      iPhone 16 (booted)
✓ Metro          :8081        ✓ Signaling  ws://127.0.0.1:8976 (wrangler dev)
✓ Server         ephemeral answerer, ready
✓ Build+install  Debug (xcodebuild → simctl install)
✓ Pairing        fired via simctl openurl vibestudio://connect?…
  [phase] embedded-pairing-complete … workspace-panel-webview-loaded
```

No port forwarding, no TURN: the simulator reaches host loopback directly.

### Path C — daily parity (the point of it all)

An iPhone paired to a **remote** server (deployed via overhaul Path A) is at
full functional parity with the Android client: OTA workspace app on every
`vcs.edit`-driven deploy, panels over the loopback façade, approval sheet,
push-driven approval notifications with lock-screen actions (when the user has
provisioned APNs — which requires a paid Apple team, WP-i7; without one, push
is off and the app says exactly why), OAuth flows, reconnect-on-foreground
with full panel recovery (WP-i8). No feature works on
Android but not iOS except brokered CDP panel automation (D8, a platform
limitation on both mobile OSes' webviews — see `apps/mobile/README.md:24-36`).

### Path D — CI, on a tag and on every PR touching mobile

macOS runner: `pod install` against the committed lockfile → `xcodebuild`
Debug + Release (unsigned build for PRs) → boot simulator → run
`mobile smoke --platform ios` end-to-end (pair → OTA activate → panel
webview loaded, phase-asserted from the unified log stream).

---

## 2. Work packages

All ten land in one change set. Ordering is dependency order, not staging.

### WP-i1 — Native host ABI parity and one delivery mechanism (`rn-host-2`)

**Problem:** G1, G2, G6. **Outcome:** one native contract, implemented twice,
byte-equivalent in behavior; every legacy path deleted.

- **Implement the streaming write path in `VibestudioMobileHost.mm`:**
  `appendBundleChunk(base64, buildKey, artifactPath, first)` and
  `finalizeBundleWrite(integrity, gzipped)`, mirroring
  `VibestudioMobileHostModule.kt:313-392` exactly: append to a `.transfer`
  file under the validated cache path, then decompress (gzip) and hash the
  **decompressed** bytes, compare `sha256-…` integrity, atomic-rename into
  place. Reuse the existing `validatedPreparedBundlePath` and CC_SHA256
  helpers (`VibestudioMobileHost.mm:525-568`).
- **Deep-link ingress + connect-intent reset on iOS:** `AppDelegate.mm`
  today has **no URL entry points at all** — no
  `application:openURL:options:`, no `application:continueUserActivity:`
  (`AppDelegate.mm:32-94`) — so neither scheme links nor universal links
  would ever reach RN's `Linking` on iOS. Add both handlers, forwarding to
  `RCTLinkingManager` so both carriers land in the existing JS listeners
  (`index.js:708-743,800-805`). In the same handlers, a connect link
  (scheme or https pair-carrier) first clears the `activeBundle.*`
  NSUserDefaults keys and triggers an RN reload to the shipped bootstrap —
  the exact behavior of `MainActivity.kt:41-59`. OAuth-shaped URLs are
  ignored here and never reset, per the Info.plist scheme-scoping note.
- **Delete the orphaned HTTP-direct subsystem everywhere:** `pairServer`
  (`VibestudioMobileHost.mm:81`), `listWorkspaces` (`:115`),
  `selectWorkspace` (`:155`), `prepareAppBundle` (`:222-280`), the
  `NSURLSession` helpers `getData:` (`:460`) / `postJson` (`:533`) /
  `ensureSameOriginArtifactUrl` (`:565`), **and the module-internal
  credential store they feed** — `saveCredential`/`loadCredential` and their
  only readers `getCredentials` and `issueConnectionGrant`, which have zero
  production callers repo-wide (mocks only) and read a store nothing on a
  live path writes; the live credential is the `react-native-keychain` shell
  credential (`packages/mobile-webrtc/src/connect.ts:140-189`). Delete the
  Kotlin twins of all of the above in `VibestudioMobileHostModule.kt`; the
  JS wrappers in `workspace/apps/mobile/src/services/auth.ts`; the HTTP arm
  of `appBootstrap.ts`; and the dead hub-mode `selectWorkspaceAndRun`
  (`apps/mobile/index.js:692-706` — its `pendingWorkspaces` is never
  populated; hub workspaces pair through per-child invites,
  `src/server/hubServer.ts:223-262`). Keep `clearCredentials`,
  `resetToNativeBootstrap`, `activatePreparedAppBundle`, and the two chunk
  methods — the actual live contract, nothing else.
- **Extract the delivery orchestration into a shared module:**
  `streamArtifactToNative` + the fetch-manifest/verify/activate sequence
  (`apps/mobile/index.js:230-320`) move into `@vibestudio/mobile-webrtc`
  (`src/bundleDelivery.ts`), parameterized by any transport that can
  `streamReadable("main", "gateway.fetch", …)` — the shell bootstrap passes
  its paired connection, the workspace app passes its `MobileRpcClient`
  (`mobileTransport.ts:145`; precedent: the panel façade already streams
  exactly this way, `panelAssetFacade.ts:478`). One implementation, two
  callers, two JS contexts. The module returns the full bootstrap manifest
  (`appId`, `buildKey`, `capabilities`, `rnHostAbi`, integrity — the shape
  `getReactNativeBootstrap` emits, `src/server/appHost.ts:1293-1312`), so
  both callers preserve the capability handoff `appBootstrap.ts:11-16`
  performs today: `setApprovedAppCapabilities(...)` (and the
  notifications-gated `registerBackgroundHandlers()`) run **before**
  `activatePreparedAppBundle`, on the pairing path and the self-update path
  alike — this runtime contract moves into the shared module, not around it.
- **Workspace-app self-update becomes streamed — and works for the first
  time:** the update prompt (`appUpdatePrompt.ts`) rewires from the deleted
  native `prepareAppBundle` to the shared delivery module over the app's own
  transport, then `activatePreparedAppBundle` — the RN bundle replaces
  itself and reloads. This is net-new engineering, not a deletion side
  effect (the current self-update path throws for every WebRTC-paired
  device, §0.3 G2), and Path C's "OTA on every deploy" rests on it.
- **Bump `RN_HOST_ABI` to `"rn-host-2"`** in `apps/mobile/index.js:55`, the
  workspace-app manifest (`workspace/apps/mobile/package.json` `rnHostAbi`),
  and `MOBILE.md`. Old bundles and old binaries fail closed against each
  other. Migration story, stated plainly: every Android device reinstalls
  the shell; every iOS self-builder rebuilds on their Mac (D1).
  Simultaneous, forced, and final — there is no compatibility window.

**Acceptance:** iOS simulator completes the full stream→verify→activate cycle
with a tampered-byte negative test (integrity mismatch → activation refused,
error surfaced); **workspace-app self-update e2e on both platforms** —
deploy a new workspace-app build server-side, update prompt appears, streamed
install, RN reload lands the new bundle (asserted via a version marker);
connect-intent on iOS with an active OTA bundle drops to the shell bootstrap
(instrumented test); grep proves no `prepareAppBundle` / `pairServer` /
`selectWorkspace` / `issueConnectionGrant` / `getCredentials` symbol survives
in either native module or any JS seam — which includes rewriting the
boundary test's entrypoint assertion
(`src/server/mobileMetroNativeBoundary.test.ts:89` currently *requires*
`prepareAppBundle` in the shipped entrypoint; it re-anchors on the
chunk-method contract, the host-only boundary check itself stays); ABI
mismatch (old bundle vs new host) refuses activation with the exact
remediation text.

### WP-i2 — Xcode project and per-user signing

**Problem:** G4, G8 (entitlement half), G10. **Outcome:** a stranger with a
Mac and any Apple ID (free or paid) builds and installs their own signed
shell without editing project files.

- **Signing config:** committed `apps/mobile/ios/Signing.template.xcconfig` +
  gitignored `Signing.local.xcconfig` holding `DEVELOPMENT_TEAM`, optional
  `PRODUCT_BUNDLE_IDENTIFIER` override, and capability toggles. The pbxproj
  references the xcconfig; `CODE_SIGN_STYLE = Automatic`. `vibestudio mobile
  doctor` (overhaul WP7) gains an iOS section that discovers available signing
  identities (`security find-identity`, `xcrun xcodebuild -showBuildSettings`)
  and writes the local xcconfig interactively when absent.
- **Generated entitlements:** a small generator (invoked by `mobile install` /
  `mobile dev` and by an Xcode pre-build phase) writes
  `ios/Vibestudio/Generated.entitlements` from the signing config +
  provisioning reality: `aps-environment` **only** when push is provisioned
  (paid team + `GoogleService-Info.plist` present — G8's trap becomes
  unreachable), associated domains **only** when a pair/oauth host is
  configured. `CODE_SIGN_ENTITLEMENTS` points at the generated file; the
  checked-in static `Vibestudio.entitlements` (never wired, `TODO(release)`
  marker and all) is **deleted**.
- **Project hygiene in the same pass:** commit `Podfile.lock`; add an
  `Internal` build configuration + scheme with a **two-bundle-id matrix**
  sized for Apple's free-team economics (3 sideloaded apps per device, ~10
  App IDs per rolling week): Release keeps `app.vibestudio.mobile` (the
  personal install); Debug **and** Internal share
  `app.vibestudio.mobile.dev`, so dev/smoke installs replace each other and
  never displace the personal install, without burning a third App ID. This
  deliberately does not mirror Android's three-id triple
  (`android/app/build.gradle:55-85`): Apple's constraints are the design
  input, and Internal exists for what the smoke needs (release-like, bundled
  JS, no Metro), not for id symmetry. `mobile dev` uses Debug,
  `mobile smoke`/`mobile install --internal` use Internal, personal installs
  use Release. Delete `UIRequiredDeviceCapabilities` (armv7) from
  `Info.plist:32-35`; add `NSCameraUsageDescription` (WP-i6 scanner) **and**
  `NSMicrophoneUsageDescription` — `react-native-webrtc`'s iOS pod links
  AVFoundation/AVAudioSession, and a missing mic string is a
  first-WebRTC-use crash on device even for datachannel-only usage (verify
  against the pinned pod version, then add unconditionally); replace
  `apps/mobile/ios/README.md`'s regenerate-by-hand instructions with real
  docs (the checked-in project is authoritative).

**Acceptance:** clean Mac + free Apple ID: doctor writes the config,
`mobile install --platform ios` produces a signed, installable Release build
with **no** push entitlement and installs to a connected iPhone; same machine
with a paid team + Firebase plist produces a build **with** `aps-environment`;
a push-provisioned config with a free team fails the build with the exact
explanation (negative test); `pod install` is reproducible from the lockfile
in CI.

### WP-i3 — `vibestudio mobile install --platform ios`

**Problem:** G3 (install half). **Outcome:** Path A transcript, verbatim.

- Extend `scripts/cli/mobile-install.mjs` with an iOS arm (flag wired through
  `src/cli/client.ts:797-830`): preflight (macOS, Xcode ≥16, CocoaPods,
  signing config — each failure is one actionable line, doctor-style); `pod
  install` when the lockfile demands it; entitlement generation (WP-i2);
  `xcodebuild -scheme Vibestudio -configuration Release
  -allowProvisioningUpdates` build; target resolution and install:
  physical devices via `xcrun devicectl device install app` + `devicectl
  device process launch`, simulators via `xcrun simctl install` + `simctl
  launch`. `--device <udid>` / `--simulator [name]` select explicitly;
  exactly one candidate target is required otherwise (same posture as
  `assertInstallTarget`, `mobile-install.mjs:129-175`).
- Per D1 there is **no prebuilt-artifact arm for iOS**: on iOS,
  `mobile install` *is* the from-source build. The command surface stays
  symmetric with post-overhaul Android (`--from-source` is where Gradle
  lives); asking for a prebuilt iOS artifact is an error explaining D1.
- `mobile logs --platform ios`: simulators stream via `xcrun simctl spawn
  <udid> log stream --predicate 'process == "Vibestudio"'`; physical devices
  fail loudly naming Console.app (Apple provides no supported device
  log-streaming CLI; one mechanism per job — no third-party syslog dep).
- Free-team installs print the 7-day expiry note (Path A) and `mobile doctor`
  reports days remaining when it can read the embedded provisioning profile.

**Acceptance:** end-to-end on a Mac runner: build + `simctl install` + launch
succeeds from a clean checkout; `--platform ios` on Linux exits non-zero
naming macOS; ambiguous targets (two simulators booted) refuse with the list;
device-install path manually verified per release (devicectl needs hardware).

### WP-i4 — iOS dev loop: `mobile dev --platform ios` + mobile-debug backend

**Problem:** G3 (dev half). **Outcome:** Path B transcript; agents get the
same frontend-dev affordances they have on Android.

- Extend `scripts/cli/mobile-dev.mjs` with an iOS arm reusing the entire
  platform-neutral spine (Metro, wrangler signaling, ephemeral answerer
  server, ready-file wait, pairing-link scrape — `mobile-dev.mjs:190-269,
  342-522`): boot/reuse a simulator (`simctl boot`, default device type
  configurable, `VIBESTUDIO_IOS_SIMULATOR` env), `xcodebuild` Debug, `simctl
  install`, fire the connect link via `simctl openurl <udid>
  "vibestudio://connect?…"` (the `am start -a VIEW` analog). **No
  port-forwarding step and no TURN**: the simulator shares host loopback (the
  ATS exception in `Info.plist:72-93` exists for exactly this), and the
  loopback `ws://127.0.0.1` signaling URL is already legal per
  `isLoopbackHost` (`connect-utils.mjs:181-187`).
- Physical-device dev: same command with `--device <udid>` skips `openurl`
  (unsupported on hardware) and prints the pair QR for camera scanning; the
  pipe is the production WebRTC path. Nothing is emulated.
- **`workspace/extensions/mobile-debug` grows an iOS backend** behind its
  existing surface: screenshots via `simctl io <udid> screenshot`, log
  tailing via `simctl spawn log stream`, install/launch via the WP-i3
  primitives, replacing the adb-only assumption
  (`workspace/extensions/mobile-debug/index.ts:13-70`). One extension, two
  backends selected by target platform — agents iterating on the workspace
  app get screenshot/log parity on iOS simulators.
- `mobile emulator --platform ios` boots a windowed simulator (name from
  config), symmetric with the Android AVD verb.

**Acceptance:** Path B transcript reproduces on a Mac from a clean checkout;
the mobile-debug extension returns a real simulator screenshot and tails
phase-marker logs during an agent session; `mobile dev --platform ios
--device` prints a scannable QR and pairs a hardware iPhone over real
signaling.

### WP-i5 — OAuth on iOS (`ASWebAuthenticationSession`)

**Problem:** G5. **Outcome:** every OAuth flow the workspace app runs on
Android completes on iOS, under user-specific signing.

- New native module `VibestudioAuthSession` (`apps/mobile/ios/Vibestudio/`):
  `start(authUrl, callbackScheme) → Promise<callbackUrl>` wrapping
  `ASWebAuthenticationSession` with `callbackURLScheme: "vibestudio"`,
  `prefersEphemeralWebBrowserSession` configurable, correct
  presentation-context anchoring, and cancellation mapped to a typed
  rejection. The session survives app backgrounding by OS contract — the
  entire reason Android needs `OAuthLoopbackKeepAliveService` and iOS must
  not copy it.
- The existing JS OAuth seam (registered in `workspace/apps/mobile/App.tsx`)
  branches by platform: Android → loopback module (unchanged), iOS → auth
  session. One seam, two genuine mechanisms (D4).
- **The server/client contract this depends on — new work, not assumed:**
  the server today refuses non-loopback, non-https redirect URIs
  (`validateOAuthCredentialRequest`,
  `src/server/services/credentialService.ts:250-258`), its redirect-strategy
  resolution has no custom-scheme branch (`connectOAuth2AuthCode`,
  `:2422-2445`), and the mobile dispatcher parses only
  `https://vibestudio.app/oauth/callback/…` universal links
  (`workspace/apps/mobile/src/services/oauthHandler.ts:30,46-57`). Add an
  **`app-scheme` redirect strategy**: the server mints
  `vibestudio://oauth/callback/<provider>` as the `redirect_uri` (validation
  extended to accept exactly this scheme/shape for this strategy only —
  still refusing query/fragment on the registered URI), keeps owning the
  transaction end to end (PKCE-bound `state`, server-side code exchange, the
  RFC 8252 native-app pattern), and the client returns the intercepted
  callback URL over the existing forward-callback RPC keyed by `state`. The
  universal-link strategy remains for Android and for AASA-verified
  installs; on iOS, app-scheme is the **default** because a self-built app's
  team ID is not in the hosted AASA — the same reasoning as D3. The callback
  shape validator is shared with `oauthHandler.ts`: one parser, two
  carriers.
- Callback semantics,
  modeled precisely: `ASWebAuthenticationSession` **intercepts** the
  `vibestudio://oauth/…` redirect in-session and resolves its completion
  handler — the callback never routes through AppDelegate `openURL` or the
  deep-link layer at all. The deep-link layer's only obligation is
  defense-in-depth: iOS claims the whole `vibestudio` scheme, so a stray
  oauth-shaped scheme URL fired by any app is **ignored entirely** — never
  pairing, never the auth session (WP-i1's reset logic already acts only on
  connect URLs).
- `webcredentials`/`applinks` associated domains stay config-gated (WP-i2
  generator): when a self-hoster's well-known lists their team ID, iOS
  universal-link OAuth callbacks also verify — an optimization on top of the
  scheme callback, never a requirement (D3).

**Acceptance:** an e2e credential flow (the same one exercised on Android)
completes on the iOS simulator through `ASWebAuthenticationSession` against
the new app-scheme strategy; the strategy is unit-tested server-side
(mint/validate/forward, refusal of malformed or cross-strategy scheme URIs);
a crafted `vibestudio://oauth/…` link fired at the app is ignored entirely —
neither pairing nor the auth session reacts (negative test); user
cancellation surfaces as a typed error, not a hang.

### WP-i6 — Pairing entry on iOS

**Problem:** G7. **Outcome:** every pairing surface of the overhaul plan
works on an iPhone: OS camera → https QR → app; in-app scanner; paste-link.

- **Carrier wiring (builds on overhaul WP6):** register the pair-host
  associated domain in the WP-i2 entitlement generator; the pair page's iOS
  branch shows the self-build install guidance (per D1) with the "retry
  open" button. Universal-link direct-open engages when the deployed AASA
  lists the app identity; the trampoline's **explicit-tap** →
  `vibestudio://connect` path is the tested guarantee for every team ID
  (D3; never auto-fired, per the overhaul plan's hijack hardening). Both
  carriers feed the one shared parser (`packages/shared/src/connect.ts`).
- **In-app scanner (builds on overhaul WP7, which puts it in the native host
  shell — where first pairing lives):** the workspace app only exists after
  a bundle is activated, so a scanner in its login screen could never serve
  a fresh install; per overhaul WP7 the camera module and scan screen ship
  in the **shell binary** (unpaired/onboarding state), and the workspace
  app's re-pair surfaces reuse the same native module. This WP lands the iOS
  leg of exactly that: `NSCameraUsageDescription` (WP-i2), the
  vision-camera pod in Podfile + lockfile, permission-denied UX, and the
  scan → shared-parser → confirmation → replay-guard path verified on iOS
  in both contexts (shell first-pair, workspace re-pair). Plus a paste-link
  field in both the shell's unpaired state and the workspace login screen
  (simulators and devices without camera line-of-sight need it; it is also
  the smoke's entry on hardware).
- **Shell-bootstrap parity:** the shipped `index.js` bootstrap handles the
  https-carrier URL on iOS (universal-link open) and the scheme URL
  identically — `Linking.getInitialURL` cold-start and warm `url` events
  both covered (`index.js:708-743,800-805` already do this; extend the parse
  to both carriers via the shared grammar, which overhaul WP6 delivers).
- Update `apps/well-known/config.json` semantics documentation: hosted
  deployment carries no iOS `appID`s by default (self-built apps aren't
  enumerable); self-hosters set `VIBESTUDIO_APPLE_TEAM_ID` /
  `VIBESTUDIO_IOS_BUNDLE_ID` and get direct-open (`apps/well-known/build.ts`
  strict placeholder check stays).

**Acceptance:** simulator e2e — `simctl openurl` with an **https** pair link
opens the app directly (associated domain configured in the test build) and
reaches the confirmation sheet; the same link through Safari (no AASA match)
reaches the app via the trampoline's explicit Open-in-Vibestudio tap — and
the page never auto-fires the scheme (asserted, per the hijack-hardening
rule); scanner-initiated **first pairing from the shell's unpaired state**
on a hardware iPhone verified per release; replay of a consumed link is
refused (existing guard, re-asserted on iOS).

### WP-i7 — Push: APNs provisioning made real

**Problem:** G8. **Outcome:** a user with a paid Apple team gets lock-screen
approval actions on iOS; a user without one gets a working app that says
exactly why push is off. No code path changes — provisioning, entitlements,
and verification do.

- Wire the iOS Firebase steps into `mobile doctor` (the overhaul makes doctor
  the home for this on Android; iOS joins it): checks for
  `GoogleService-Info.plist` (vs the committed template), an APNs key
  uploaded to the Firebase project (doc-check, can't be probed), a paid team
  in the signing config, and the generated entitlement actually containing
  `aps-environment`. Each miss prints the one-line fix.
- Notifee/RNFB pods verified under the committed lockfile;
  `UNUserNotificationCenter` category registration confirmed against the
  categories the server sends (`aps.category`,
  `pushService.ts:181-247`; client `notificationCategories.ts` ios block).
  Approval actions (approve/deny from the notification) round-trip on iOS,
  including the offline queue → drain-on-reconnect path
  (`pushNotifications.ts:279-300,383-391`).
- **Suspended-app semantics, specified not assumed:** iOS has no foreground
  service to lean on, so the background action queue's execution model is
  spelled out. Lock-screen approval actions are handled by Notifee's
  background event handler (registered at module load,
  `backgroundHandlers.ts`, wired at `appBootstrap.ts:15`), which enqueues
  the decision; the queue drains on the next connect
  (`pushNotifications.ts:383-391`) — on iOS that means next app
  launch/foreground, or the APNs `content-available` background wake when
  the OS grants one (`UIBackgroundModes: remote-notification` is already
  declared, `Info.plist:27-31`). The wake is opportunistic; the queue is the
  guarantee: a decision taken on the lock screen is never lost, and
  reconcile-on-recovery cancels stale notifications
  (`pushNotifications.ts:245-269`).
- When push is unprovisioned, `isNativeFirebaseConfigured()` short-circuits
  registration exactly as on Android — and the settings screen surfaces
  "push off: no APNs provisioning" rather than silence (fail loud extends to
  UX).
- **Explicit non-goal, stated in docs:** no Notification Service Extension
  (rich attachments / payload mutation). It is not required for functional
  parity — Android has no equivalent surface in use — so it is out of scope
  by design, not deferred (`docs/approvals.md:160-172` updated to say so).

**Acceptance:** on a paid-team, Firebase-provisioned device build: an
approval push arrives, lock-screen approve resolves the approval on the
server (manual per-release verification — simulators cannot prove APNs);
CI asserts the entitlement/config matrix (free team ⇒ no aps-environment ⇒
registration skipped with the exact log line; paid+plist ⇒ entitlement
present); the simulator-testable half of the suspended path is CI-tested — a
Notifee background event with the app quit enqueues the decision and the next
launch drains it against the server; the unprovisioned-build settings screen
shows the push-off reason.

### WP-i8 — Workspace-app surface parity and iOS lifecycle

**Problem:** G9, plus the iOS background-execution model, which "the JS is
platform-neutral" does not cover. **Outcome:** zero `Platform.OS ===
"android"` guards that gate *behavior* (styling branches are fine), and
suspension/foreground transitions specified and tested.

- **Back navigation:** replace the Android-only `BackHandler` block
  (`MainScreen.tsx:1283`) with one navigation-intent seam consumed by both
  platforms: Android hardware back and iOS horizontal edge-swipe (plus an
  on-screen back affordance in the panel app bar, which Android also gets)
  drive the same panel-history/parent-activation logic. One behavior, two
  input sources.
- **WebView inspection:** drop the Android gate on `webviewDebuggingEnabled`
  (`PanelWebView.tsx:879`) — react-native-webview maps it to WKWebView
  `isInspectable` (iOS 16.4+); enable in Debug/Internal builds on both
  platforms, off in Release (Safari Web Inspector becomes the iOS panel
  debugging story; document beside the CDP note, D8).
- **Background→foreground recovery is a first-class spec, not an audit
  item:** iOS suspension tears down the WebRTC pipe **and** the
  `react-native-tcp-socket` loopback panel-asset server within seconds of
  backgrounding. On foreground: the existing nudge/reconnect path
  (`connect.ts:206-244`, `useAppLifecycle.ts:53-66`) re-establishes the
  pipe; the façade re-binds its persisted port
  (`panelAssetFacade.ts:255-278`) before any panel WebView issues a request;
  the in-memory LRU survives when the process lived and repopulates
  transparently when it didn't. Named test, not a bullet in an audit:
  background the app mid-panel-load, foreground, assert the panel completes
  without a white screen — then repeat with a **multi-MB asset over a
  TURN-relayed pipe** (the wire-gzip throughput case,
  `gatewayFetchService.ts:71-76`), because suspension and datachannel
  buffering interact exactly there.
- **Full-surface audit pass with the WP-i4 loop:** safe-area (notch/home
  indicator) on MainScreen/PanelDrawer/ApprovalSheet, keyboard avoidance
  (`ApprovalSheet.tsx:391` behavior branches exist — verify against real
  keyboard), haptics mapping, font fallbacks (Menlo branches).

**Acceptance:** the smoke's panel phase markers pass on iOS; edge-swipe pops
panel history on iOS and hardware back still works on Android (both
instrumented); grep: no behavior-gating `Platform.OS === "android"` early
returns remain in `workspace/apps/mobile/src/` (styling ternaries exempt);
Safari Web Inspector attaches to a panel WebView in an Internal build.

### WP-i9 — iOS smoke + CI

**Problem:** G3 (test half). **Outcome:** Path D; iOS regressions cannot land
silently.

- **`mobile smoke --platform ios`** in `scripts/cli/mobile-smoke.mjs`,
  reusing the platform-neutral spine (signaling, answerer env, ready-file,
  pairing-link scrape, SQLite first-turn probe) with an iOS half:
  `simctl boot` (headless on CI) → Internal-scheme `xcodebuild` → `simctl
  install` → `simctl openurl` deep link → phase assertions from `simctl
  spawn <udid> log stream` (the eleven phase markers are emitted by JS,
  `mobile-smoke.mjs:1715-1731`, and are platform-agnostic) → screenshots via
  `simctl io screenshot` for the panel-visible assertion. No TURN, no
  reverse-forwarding (D6) — delete-by-never-adding the Android emulator's
  QEMU-NAT workarounds from the iOS arm.
- **UI taps via an XCUITest conductor:** a tiny `VibestudioSmokeUITests`
  target whose single parameterized test taps by accessibility label
  (`Pair`, `Trust and start`), invoked with `xcodebuild
  test-without-building -only-testing:…` and env-passed labels — the
  `uiautomator dump` + `input tap` analog (`mobile-smoke.mjs:1750-1766`).
  Accessibility labels added to the two buttons in the same change (which
  also improves real accessibility; Android smoke keys off visible text and
  is unaffected).
- **CI:** a macOS job on PRs touching `apps/mobile/`, `workspace/apps/
  mobile/`, `packages/mobile-webrtc/`, or the RN build provider: lockfile
  `pod install` → unsigned Debug + Release builds → simulator smoke. On
  tags, the same job runs the full smoke including OTA activation against a
  just-built server. No artifact publishing (D1).
- The overhaul plan's **§6.1 full-system smoke** gains an iOS leg: a macOS
  job mirroring phase 3 ("phone ← desktop, remote server") with the iOS
  simulator as the second client — redeem a desktop-minted invite against
  the containerized remote server over real signaling, assert the same
  `smokePhase` ladder through pairing and OTA activation, then the
  revoke → re-pair round-trip. Panel assertions ride log phases and
  screenshots (no CDP on iOS, D8 — the overhaul plan's §6.1 already scopes
  panel-content assertions to Android).

**Acceptance:** the iOS smoke is green in CI on a clean macOS runner from
checkout to panel-webview-loaded; a deliberately broken iOS native method
(revert of WP-i1) fails the smoke at `embedded-bundle-activate-start`
(negative canary, run once to prove the smoke bites); flake budget: the
smoke retries the simulator boot only, never the assertions.

### WP-i10 — Documentation, skills, and registry sweep

Same change set, not a follow-up. Skills are how agents assist with this
system — the workspace now supports **repo-local skills** (a top-level
`SKILL.md` beside the code it describes, discovered like `skills/*`; see
commit `d49608ef`, convention documented in the workspace-dev skill), and
skills surface to linked CLI sessions as MCP resources. Every extension this
plan touches ships its skill in the same change:

- **`workspace/extensions/mobile-debug/SKILL.md` (new):** the agent dev loop
  for the mobile app — install/launch, screenshots, log tailing — covering
  **both backends** (adb and the WP-i4 simctl backend) with the
  platform-selection rules, the phase markers to watch, and the "panel looks
  wrong on iOS" debugging recipe (Safari Web Inspector, WP-i8). This is the
  skill that lets an agent iterate on the workspace app against an iOS
  simulator without a human driving Xcode.
- **`workspace/extensions/react-native/SKILL.md` (new):** the build
  provider's contract — per-platform Metro bundles, artifact roles and
  `platform` tags, the `rn-host-2` ABI and when it must be bumped, the
  bootstrap-manifest requirements (`hasMobilePrimaryArtifacts`), and the
  failure-mode table (missing platform artifact, ABI mismatch, integrity
  refusal) with fixes.
- `workspace/skills/appdev/MOBILE.md` (cross-repo workflow, so it stays under
  `skills/`): rewritten for `rn-host-2`, the single streamed delivery
  mechanism (the stale HTTP pairing steps 7–10 are deleted, per D2),
  iOS-specific failure modes (signing, entitlement matrix, free-team
  expiry), and the updated native-host method table — and it now **links to
  the two repo-local skills** above instead of duplicating their content
  (guidance lives beside the code that implements it; MOBILE.md keeps only
  the cross-cutting two-layer architecture).
- `workspace/skills/appdev/DEV_LOOP.md`: gains the iOS simulator loop next
  to the Android one.
- **Extend, don't fork, the skills the overhaul plan creates:** its WP10
  ships `workspace/apps/mobile/SKILL.md` (OTA update prompts, re-pair
  states, scanner entry points) and the `remote-access` skill — this plan
  adds their iOS content to those same files (self-build + signing matrix,
  scanner and paste-link on iOS, Safari Web Inspector for panels, free-team
  expiry symptoms in the troubleshooting ladder) rather than creating
  parallel documents. The overhaul plan's skill-freshness rule (a deleted
  surface's skill sentence dies in the same commit) applies to this change
  set's deletions too, and its grep gate covers the `rn-host-1`/legacy-
  method sweep in §7.
- `apps/mobile/README.md`: iOS build/signing/push provisioning sections
  (replacing the Android-only framing); the CDP note gains the Safari Web
  Inspector pointer (WP-i8).
- `apps/mobile/ios/README.md`: rewritten — the project is authoritative;
  regenerate-instructions deleted.
- `docs/cli.md` regenerated for every `--platform ios` surface;
  `docs/approvals.md` iOS provisioning + explicit NSE non-goal;
  `docs/remote-ux-overhaul-plan.md` WP7 annotated as amended by this plan
  (D1). `STATE_DIRECTORY.md`: signing xcconfig, generated entitlements,
  simulator config env.
- `mobile doctor` output *is* documentation of record for provisioning; the
  doc pages link to it rather than duplicating step lists that will drift.

---

## 3. CLI surface after this change

| Command | Behavior |
|---|---|
| `vibestudio mobile install --platform ios [--device <udid>\|--simulator [name]] [--internal]` | Self-build: preflight → pods → generated entitlements → signed `xcodebuild` → devicectl/simctl install + launch. No prebuilt arm on iOS (D1) |
| `vibestudio mobile dev --platform ios [--device <udid>]` | Metro + signaling + answerer + simulator build/install + `simctl openurl` pairing; device mode prints the pair QR |
| `vibestudio mobile smoke --platform ios` | Simulator e2e: pair → OTA activate → panel visible, phase-asserted |
| `vibestudio mobile logs --platform ios` | Simulator `log stream`; hardware devices error naming Console.app |
| `vibestudio mobile emulator --platform ios` | Boots a windowed simulator |
| `vibestudio mobile doctor` | Gains the iOS section: Xcode/CocoaPods/signing identity/team, entitlement matrix, Firebase/APNs provisioning, free-team expiry |
| `vibestudio mobile install` (Android) | Unchanged from the overhaul plan |

## 4. State and config after this change

- `apps/mobile/ios/Signing.local.xcconfig` (gitignored; team ID, bundle-id
  override, capability toggles) + committed `Signing.template.xcconfig`.
- `apps/mobile/ios/Vibestudio/Generated.entitlements` (build-time artifact,
  gitignored) replaces the deleted static entitlements file.
- `apps/mobile/ios/Podfile.lock` committed; CI installs from it.
- `GoogleService-Info.plist` remains hand-provisioned per user (template
  committed), same posture as Android's `google-services.json`.
- `RN_HOST_ABI = "rn-host-2"` — the one cross-cutting contract bump.
- Env: `VIBESTUDIO_IOS_SIMULATOR` (device-type name for dev/smoke).

## 5. Deletions register (nothing on this list survives)

1. The orphaned HTTP-direct subsystem, both platforms: `pairServer`
   (`VibestudioMobileHost.mm:81`), `listWorkspaces` (`:115`),
   `selectWorkspace` (`:155`), `prepareAppBundle` (`:222-280`), `getData:`
   (`:460`), `postJson` (`:533`), `ensureSameOriginArtifactUrl` (`:565`),
   the module-internal credential store (`saveCredential`/`loadCredential`)
   with its dead readers `getCredentials` and `issueConnectionGrant` (mocks
   are their only callers), and the Kotlin twins of all of the above in
   `VibestudioMobileHostModule.kt`.
2. Their JS seams: the `prepareAppBundle`/`pairServer` wrappers in
   `workspace/apps/mobile/src/services/auth.ts`, the HTTP arm of
   `appBootstrap.ts`, `appUpdatePrompt.ts`'s native-HTTP mechanism (the
   prompt survives; its mechanism is replaced by the shared streamed
   delivery module), and `selectWorkspaceAndRun`
   (`apps/mobile/index.js:692-706`).
3. `RN_HOST_ABI = "rn-host-1"` (→ `rn-host-2` everywhere; mismatch fails
   closed).
4. The static, never-wired `Vibestudio.entitlements` (replaced by the
   generated file) and its `TODO(release)` developer-mode marker.
5. `UIRequiredDeviceCapabilities: armv7` (`Info.plist:32-35`).
6. `apps/mobile/ios/README.md` regenerate-the-project instructions and
   `apps/mobile/ios/.gitkeep`.
7. The Android-only gate on `webviewDebuggingEnabled`
   (`PanelWebView.tsx:879`) and the Android-only `BackHandler` block as the
   sole back-navigation mechanism (`MainScreen.tsx:1283`).
8. The adb-only assumption in `workspace/extensions/mobile-debug/index.ts`
   (refactored into per-platform backends behind the existing surface).
9. Overhaul WP7's iOS TestFlight/store-publishing scope (amended per D1; the
   annotation lands in that doc).
10. Any doc section describing iOS as "checked-in but not a target."
11. The boundary test's legacy-symbol assertion
    (`src/server/mobileMetroNativeBoundary.test.ts:89` requires
    `prepareAppBundle` in the shipped entrypoint) — re-anchored on the
    chunk-method contract; the host-only boundary check itself stays.

## 6. Test plan

- **Unit:** entitlement generator matrix (free/paid × push-provisioned ×
  domains-configured → exact entitlement set, error on impossible combos);
  chunk-write/finalize logic against golden gzip artifacts (shared fixture
  with the Android test); deep-link router (connect vs oauth-shaped scheme
  URLs, both carriers).
- **Negative (mandatory per design rules):** tampered bundle byte → iOS
  activation refused; `rn-host-1` bundle vs `rn-host-2` host → refused with
  remediation; free team + push config → build error; `vibestudio://oauth/…`
  → never enters pairing; an app-scheme OAuth redirect URI under any other
  strategy (or malformed shape) → server refusal; the pair page never
  auto-fires the scheme on iOS; consumed connect link replay → refused;
  `--platform ios` on Linux → non-zero naming macOS; two booted simulators,
  no `--simulator` → refuses with list.
- **Smokes:** `mobile smoke --platform ios` (Path D) in CI on macOS; Android
  smoke stays green (proving the WP-i1 deletions and ABI bump didn't regress
  the Kotlin side); mobile-debug iOS backend screenshot/log check inside the
  smoke run.
- **Lifecycle and self-update (both platforms):** workspace-app self-update
  e2e (WP-i1); background→foreground panel recovery including the multi-MB
  TURN-relayed asset case (WP-i8); suspended-app lock-screen decision →
  queue → drain-on-launch (WP-i7, the simulator-testable half).
- **Triangle e2e:** iOS-simulator leg added to the overhaul plan's headline
  test (remote server in a container + desktop + iOS simulator redeeming a
  desktop-minted invite over real signaling).
- **Manual per release (hardware-only physics, documented checklist):**
  devicectl install to a physical iPhone; camera-scan pairing via the https
  QR; APNs lock-screen approval round-trip on a paid-team build; free-team
  7-day expiry note accuracy.

## 7. Definition of done

- All four golden-path transcripts (§1) reproduce verbatim — B and D on
  clean machines/CI; A and C on hardware (a physical iPhone is the point of
  Path A; CI covers A's full build/sign/install pipeline against a simulator
  target instead).
- Deletions register (§5) fully executed; CI greps prove no references
  remain.
- All §6 tests green; the macOS CI job is required on mobile-touching PRs.
- One `rn-host-2` contract, one bundle-delivery mechanism, one deep-link
  parser, one doctor — no iOS-only forks of anything that isn't a genuine
  platform difference (OAuth mechanism, input sources, log streaming).
- Docs and skills sweep (WP-i10) merged in the same change set — including
  the two new repo-local extension skills — and a CI grep proves no skill or
  doc still references `rn-host-1` or any deleted native method; no
  "TODO(follow-up)" markers introduced.

## 8. Known hazards (handle, don't defer)

- **Apple toolchain drift:** `devicectl`/`simctl` flags and XCUITest
  behavior move with Xcode releases. Pin the CI Xcode version explicitly;
  `mobile doctor` checks the local version against the supported range and
  says so, rather than letting `xcodebuild` fail cryptically.
- **Free-team physics:** 7-day provisioning expiry and a 3-app-per-device
  cap are Apple policy, not bugs. The install transcript and doctor state
  them; re-running `mobile install` is the whole remediation; the
  two-bundle-id matrix (WP-i2) exists so the cap is never consumed by our
  own variants.
- **The ABI bump is a simultaneous forced rebuild.** `rn-host-2` invalidates
  every existing install at once; Android users reinstall the shell, and
  every iOS self-builder must rebuild on a Mac before their phone works
  again. Intentional — no compatibility window, by rule. Say it in the
  release notes; don't soften it in code.
- **Push requires money:** APNs entitlement needs a paid team. The
  entitlement generator makes the degraded mode explicit and loud (settings
  screen + doctor), never silent.
- **APNs is unprovable in CI:** simulators don't do APNs delivery. The
  entitlement/config matrix is CI-tested; delivery itself is a per-release
  manual checklist item. Do not fake it with a simulator push shim.
- **macOS coupling of the dev/install tooling** (D7): iOS shell builds need
  a Mac. Everything server-side stays Linux-clean; CI is the only Mac the
  project itself must own.
- **XCUITest conductor flake:** simulator UI automation is the least stable
  link (same as uiautomator on Android). Keep the conductor to two taps;
  every other assertion rides log phases and screenshots, which are stable.
