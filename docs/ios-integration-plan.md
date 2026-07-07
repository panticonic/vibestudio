# iOS Integration - Implementation Record

**Status:** Implemented in this change set. This document records the final iOS
surface and the verification evidence expected for future changes.

## Invariants

- The native host ABI is `rn-host-2` on Android and iOS.
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

| WP | Outcome | Primary artifacts |
| --- | --- | --- |
| WP-i1 native host parity | Android and iOS use `rn-host-2` and the same streamed delivery module. The shipped entrypoint rejects stale bundle contracts and resets connection state before a new pair. | `apps/mobile/index.js`, `apps/mobile/metroNativeBoundary.cjs`, `packages/mobile-webrtc/src/bundleDelivery.ts`, `workspace/apps/mobile/src/services/appBootstrap.ts` |
| WP-i2 signing | Xcode signing configuration is generated locally. Associated domains, camera, notification, and local-network usage are config-driven. | `scripts/cli/ios-entitlements.mjs`, `apps/mobile/ios/Signing.template.xcconfig`, `apps/mobile/ios/.gitignore`, `apps/mobile/ios/Vibestudio.xcodeproj/project.pbxproj`, `tests/ios-entitlements.test.ts` |
| WP-i3 install | `mobile install --platform ios` builds, installs, and launches simulator/device targets with entitlement generation and CocoaPods checks. | `scripts/cli/mobile-install.mjs`, `apps/mobile/ios/README.md`, `docs/cli.md` |
| WP-i4 dev loop | `mobile dev --platform ios` uses the simctl backend for install, launch, screenshot, and log streaming; mobile-debug documents both Android and iOS backends. | `scripts/cli/mobile-dev.mjs`, `scripts/cli/mobile-logs.mjs`, `workspace/extensions/mobile-debug/index.ts`, `workspace/extensions/mobile-debug/SKILL.md` |
| WP-i5 OAuth | iOS OAuth opens through `ASWebAuthenticationSession` and returns through the configured custom scheme without conflating OAuth with pairing. | `apps/mobile/ios/Vibestudio/VibestudioAuthSession.mm`, `workspace/apps/mobile/src/services/oauthLoopback.ts`, `workspace/apps/mobile/src/services/oauthLoopback.test.ts` |
| WP-i6 pairing entry | iOS has URL handling, paste-link support, camera permission, scanner wiring, and the same pair-link grammar as Android. | `apps/mobile/index.js`, `apps/mobile/ios/Vibestudio/AppDelegate.mm`, `apps/mobile/ios/Vibestudio/Info.plist`, `workspace/apps/mobile/src/components/LoginScreen.tsx` |
| WP-i7 push | Push provisioning is surfaced through doctor/config checks and documented alongside Firebase/APNs setup. | `scripts/cli/mobile-doctor.mjs`, `docs/approvals.md`, `apps/mobile/ios/Vibestudio/GoogleService-Info.template.plist` |
| WP-i8 app surface parity | iOS uses safe-area aware mobile UI, lifecycle reconnect/reset hooks, app update prompts, and inspectable WebViews where supported. | `workspace/apps/mobile/src/services/appUpdatePrompt.ts`, `workspace/apps/mobile/src/services/shellClient.ts`, `workspace/apps/mobile/src/components/ApprovalSheet.test.tsx`, `apps/mobile/ios/Vibestudio/VibestudioMobileHost.mm` |
| WP-i9 smoke and CI | Mobile smoke is platform-aware and the full-system smoke command includes Android emulator, desktop pairing, and desktop e2e phases. iOS simulator smoke is available through the same script surface on macOS. | `scripts/cli/mobile-smoke.mjs`, `scripts/full-system-smoke.mjs`, `.github/workflows/build-mobile.yml`, `package.json` |
| WP-i10 docs and skills | Mobile, shell, extension, remote-access, onboarding, server-log, and testing skills describe the iOS path and the current ABI. | `workspace/apps/mobile/SKILL.md`, `workspace/extensions/mobile-debug/SKILL.md`, `workspace/extensions/react-native/SKILL.md`, `workspace/skills/appdev/MOBILE.md`, `workspace/skills/system-testing/SKILL.md` |

## CLI Surface

```bash
vibestudio mobile install --platform ios --simulator --launch
vibestudio mobile install --platform ios --device <udid> --launch
vibestudio mobile dev --platform ios
vibestudio mobile logs --platform ios
vibestudio mobile doctor
node scripts/cli/mobile-smoke.mjs --platform ios --simulator <name>
```

## State And Configuration

- `RN_HOST_ABI = "rn-host-2"` is the cross-cutting contract in the native shell
  and workspace app manifest.
- `apps/mobile/ios/Signing.local.xcconfig` is developer-local and ignored. It
  is included by the checked-in `Vibestudio.Debug.xcconfig` and
  `Vibestudio.Release.xcconfig`, so direct Xcode builds and
  `vibestudio mobile install --platform ios` use the same
  `VIBESTUDIO_IOS_TEAM_ID` and `VIBESTUDIO_IOS_BUNDLE_ID` values.
- Generated entitlements are local build output, not a checked-in source file.
- Associated domains are emitted only when the configured team ID and bundle ID
  are present.
- OAuth callback schemes and pair-link association stay separate.

## Verification

```bash
pnpm vitest run tests/ios-entitlements.test.ts tests/remote-overhaul-skill-guard.test.ts --config vitest.host.config.ts
pnpm --dir apps/mobile type-check
node scripts/cli/mobile-smoke.mjs --platform ios --simulator <name>
pnpm smoke:full
```

On non-macOS CI, the iOS-specific entitlement and source-level tests are the
required gate. Simulator install and smoke run on macOS runners or developer
machines with Xcode.
