# App Targets

NatStack app targets define how a trusted workspace app is built, delivered,
and activated.

## Electron Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications"]
    }
  }
}
```

The Electron target is built as a browser app and loaded into an Electron
`WebContentsView` with the app preload. It is not a panel, even though it uses
the same low-level view infrastructure.

Important behavior:

- App IPC identity is `callerKind: "app"` and `callerId` is the app package
  name.
- Host capabilities are derived from the approved app manifest.
- Updates to an already-loaded Electron app use `adoptionPolicy: "prompt"`.
  The existing view stays loaded until the user chooses `Load update` from a
  notification or the App updates settings section.
- `panel-hosting` app views are full-window host chrome and are not panel
  content. They must not be sized to the panel content rectangle.
- Ordinary Electron apps should not declare `panel-hosting`; otherwise they get
  host-view authority.
- Shell app changes can break core UX: panel layout, title bar, overlays,
  pairing links, menus, notifications, and app event subscriptions.

Use `panel-hosting` only for shell-like apps that own panel layout and host
chrome. The built-in shell currently declares:

```json
[
  "native-menus",
  "notifications",
  "open-external",
  "window-management",
  "panel-hosting",
  "incoming-pair-links",
  "connection-management"
]
```

## React Native Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "react-native",
      "renderer": "App.tsx",
      "rnComponentName": "NatStack",
      "rnHostAbi": "rn-host-1",
      "capabilities": ["notifications", "open-external"]
    }
  }
}
```

The React Native target is built through a registered build provider. The
server exposes an app bootstrap to the native host; the native host selects the
artifact for its current platform, verifies integrity, writes it to native-owned
storage, and reloads React Native onto that bundle.

Important behavior:

- The shipped native bootstrap must be able to pair a clean install before a
  workspace app bundle exists.
- Native code owns durable device credentials.
- The workspace mobile app uses a short-lived principal grant, not the long-lived
  refresh token.
- The bootstrap may contain one platform artifact or multiple platform
  artifacts. The native host selects the current platform.
- Platform primary artifacts must have `platform: "android"` or `platform:
  "ios"` and an integrity string.
- Provider identity is part of trust. Missing provider identity fails closed.
- Updates are installed through a native prompt. Choosing `Install` prepares and
  activates the current trusted bundle; choosing `Roll back` switches the server
  to the previous trusted build, then activates that bundle.

## Terminal Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "terminal",
      "entry": "index.ts",
      "capabilities": ["connection-management"]
    }
  }
}
```

The terminal target currently builds a Node ESM entry artifact. The server emits
`apps:available` with `launchMode: "artifact-only"` and status `available`.

Current limitations:

- The host does not yet launch or supervise terminal app processes.
- A terminal app build being `available` does not mean a runtime is running.
- Updates use `adoptionPolicy: "artifact-only"` and are surfaced as new trusted
  artifacts, not reload prompts.
- Terminal app code should be written as a client entry artifact, but launch
  orchestration is future work.

First-class terminal apps should eventually add a runner/supervisor that owns
start, stop, restart, logs, environment, pairing material, and rollback-aware
process replacement. Until then, keep terminal app UX explicit about artifact
delivery.

Use terminal apps for remote-client CLI artifacts and shared client primitives
only when artifact-only delivery is acceptable.

## Target Selection

Use:

- `electron` for trusted desktop client UI.
- `react-native` for mobile client UI delivered to the native host.
- `terminal` for CLI/client artifacts that are not yet host-launched.

Do not use apps for ordinary user panels. Apps carry stronger trust and approval
implications than panels.
