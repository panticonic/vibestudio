# Mobile App Authoring

Vibez1 mobile has two layers:

1. The shipped native host bootstrap in the application checkout.
2. The trusted workspace React Native app under `apps/mobile`.

The bootstrap exists so the native app can pair, fetch, verify, store, and
activate the workspace app bundle. The workspace app exists so user-visible
mobile UX can be updated through workspace app builds.

## Native Host Responsibilities

The native host owns:

- durable device credential storage
- `vibez1://connect` clean-install pairing
- `/auth/complete-pairing`
- `/auth/refresh-principal-grant`
- `/auth/mobile-app-bootstrap`
- platform artifact selection
- integrity verification
- writing the bundle to native-owned storage
- React Native reload onto the active bundle

The bootstrap must not depend on workspace app code for first pairing. A clean
install has no workspace bundle and no stored credentials yet.

## Workspace Mobile App Responsibilities

The workspace mobile app owns:

- mobile shell UI
- approval sheets
- notifications UI/state
- panel tree/navigation
- credential/OAuth UX that runs after the workspace app is loaded
- RPC transport using a principal grant

It should not directly hold long-lived refresh tokens. It should call native
host wrappers to obtain short-lived grants or current connection bootstrap.

The workspace app bundle entry must register the same root component name the
native host requests. The current native host requests `Vibez1`, so the active
workspace bundle must call:

```ts
AppRegistry.registerComponent("Vibez1", () => App);
```

Do not rely on the shipped bootstrap's registration. Once the native host reloads
onto the workspace bundle, that bootstrap code is no longer the active JS entry.

Register background notification handlers from the active bundle entry at module
load time, before React renders. Firebase and Notifee background delivery may run
the bundle headlessly, so registering handlers only from a mounted screen or a
foreground login flow can miss approval pushes/actions.

## Pairing Flow

Clean install:

1. Desktop/server creates a pairing invite.
2. User opens a `vibez1://connect?room=...&fp=...&code=...&sig=...&v=2` link on the phone.
3. Native bootstrap consumes the initial URL or URL event.
4. Native bootstrap shows a trusted recovery-surface confirmation with the
   target server/workspace label from the link.
5. After user confirmation, native bootstrap dials the WebRTC room, pins `fp`,
   and presents the one-time `code` as the first shell-session token.
6. Native code stores the returned device credential plus `room`/`fp`/`sig`.
7. Native bootstrap calls `listWorkspaces()` and asks the user to choose one.
8. Native bootstrap calls `selectWorkspace(name)`, which pairs to the
   workspace-scoped WebRTC room and returns a mobile shell grant.
9. Native bootstrap calls `prepareAppBundle(rnHostAbi, platform, source)`.
10. Native code verifies the selected platform artifact, writes
   it to disk, and reloads into the workspace app.

Already paired:

1. Bootstrap reads native credentials.
2. If no workspace is selected, bootstrap resumes at workspace choice.
3. Bootstrap issues a principal grant or prepares the active workspace app.
4. Workspace app connects using native-provided connection material.

## Bootstrap Payload

`/auth/mobile-app-bootstrap` returns:

- `appId`
- `buildKey`
- `effectiveVersion`
- `capabilities`
- `rnHostAbi`
- app-level `integrity`
- `artifacts[]`
- build provider identity

Each primary artifact should include:

- `path`
- `role: "primary"`
- `contentType`
- `encoding`
- `platform: "android" | "ios"`
- `integrity`
- `url`

The bootstrap can contain one platform artifact or multiple platform artifacts.
The native host selects only the current platform.

## React Native Build Provider

React Native app builds are routed through the active provider. Provider
identity is part of the trusted build identity:

- provider name
- provider active EV
- provider active build key
- provider contract version

If provider identity is missing, activation fails closed.

## Native ABI

`rnHostAbi` is the contract between the workspace app bundle and the shipped
native host. Bump it when the workspace app requires native modules or bootstrap
behavior that older native hosts do not provide.

Do not silently load an app bundle with an ABI mismatch. The native host should
fail clearly and keep the recovery surface available.

## Common Mobile Failure Modes

- Bootstrap requires credentials before handling a pair link.
- Workspace app owns pair-link handling, but workspace app cannot load yet.
- Bootstrap exchanges a pair link without confirming the server URL.
- Active workspace bundle does not register the native root component.
- Background notification handlers are registered from foreground UI instead of
  the app bundle entry module.
- Provider emits platformless primary artifacts.
- Server rejects bootstrap because only one platform artifact is present.
- Native host requests one platform but server only provides the other.
- App capabilities and native permission declarations drift apart.
- Refresh token leaks into JS instead of staying in native storage.
