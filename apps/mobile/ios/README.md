# Vibestudio iOS Native Project

Workspace browser profiles require iOS 17 or later. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
This native contract is `rn-host-5`.

The checked-in Xcode project is authoritative. Do not regenerate it with
`react-native init`; update `Vibestudio.xcodeproj/project.pbxproj` directly when
native sources, build phases, or configurations change.

## Local Signing

```bash
cp apps/mobile/ios/Signing.template.xcconfig apps/mobile/ios/Signing.local.xcconfig
vibestudio mobile doctor
vibestudio mobile install --platform ios --simulator --launch
```

`Signing.local.xcconfig` is gitignored and holds user-specific Apple signing
settings. `scripts/cli/ios-entitlements.mjs` writes
`apps/mobile/ios/Generated/Vibestudio.entitlements` during CLI/Xcode builds.
Associated-domain entitlements are emitted only when
`VIBESTUDIO_IOS_PAIR_HOST` or `VIBESTUDIO_IOS_ASSOCIATED_DOMAINS` is set; APNs
is emitted only when `VIBESTUDIO_IOS_APS_ENV` is set.

## Pairing And OAuth

The native host handles `vibestudio://connect` and
`https://vibestudio.app/p#...` pairing links, clears any active OTA bundle,
and reloads the shipped bootstrap before React Native processes the link.

iOS OAuth uses `VibestudioAuthSession` (`ASWebAuthenticationSession`) with
`vibestudio://oauth/callback/<provider>` callbacks. Those OAuth-shaped URLs are
not pairing links and are ignored by the normal deep-link router.
