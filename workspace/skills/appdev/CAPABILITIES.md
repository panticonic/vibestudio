# App Capabilities

Capabilities are explicit privileges declared by an app manifest and checked at
host or service boundaries. They are not derived from filesystem path shape.

Example:

```json
{
  "vibez1": {
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications", "open-external"]
    }
  }
}
```

## Capability Rules

- Request only what the app needs.
- Adding or removing capabilities changes the trusted build identity and can
  require approval.
- Capabilities apply to active approved app principals.
- Host callers such as server and shell are trusted host
  principals only at call sites that explicitly allow them.
- Capability denial should surface as `EACCES` where exposed through auth or
  service APIs.

## Known Capabilities

| Capability | Meaning |
| --- | --- |
| `panel-hosting` | App can manage host panel layout, visibility, theme CSS, overlays, and shell-like view controls. Use only for shell/chrome apps. |
| `connection-management` | App can create pairing invites and participate in remote-client/device setup flows. |
| `incoming-pair-links` | Electron app can receive `vibez1://connect` deep links from the host. |
| `notifications` | App can use notification surfaces or native notification permission where available. |
| `open-external` | App can request system-browser external opens through host-gated APIs. |
| `window-management` | App can access host window/fullscreen/display-capture style operations where implemented. |
| `native-menus` | App can own or update native menu surfaces. |
| `fs-read` | Electron app can relay read-only filesystem server RPC through the host. |
| `fs-write` | Electron app can relay write-capable filesystem server RPC through the host. |
| `camera` | React Native app expects native camera access. |
| `keychain` | React Native app expects native secure credential/keychain access. |
| `clipboard` | React Native app expects native clipboard access. |

The exact supported set is host-target-specific. Electron rejects unsupported
host capabilities before loading an app view.

## `panel-hosting`

`panel-hosting` is the most sensitive Electron capability. It lets an app act
as shell chrome. A panel-hosting app may:

- show/hide panel and browser views
- update panel layout bounds
- inject host theme CSS
- show native shell overlays
- forward clicks and browser navigation commands
- subscribe to and forward shell-level event streams

Only shell-like apps should declare it. Ordinary Electron apps should be panels
unless they need trusted client authority.

## `connection-management`

`connection-management` lets an app create pairing invites through
`auth.createPairingInvite`. This is needed for clients that help connect other
clients to the server, such as a remote CLI or shell pairing UI.

Long-lived device refresh tokens should stay in native/client credential
storage. Workspace apps should use short-lived principal grants when possible.

## Filesystem Capabilities

Electron app filesystem relay is capability-gated:

- read methods require `fs-read`
- write methods require `fs-write`
- mixed operations such as copy require both as appropriate

Do not add `fs-write` to a shell or app as a convenience. It materially expands
what compromised client code can request.

## React Native Capabilities

React Native capabilities document what the workspace app expects from native
platform integration. The native host and OS permission systems still govern
actual access. Keep native capabilities aligned with implemented native modules
and app-store permission declarations.
