# Panel locations and URL transports

Vibestudio has one logical panel-location contract and several carriers. A
logical location is not the URL from which a renderer downloads panel assets.

```ts
interface PanelLocation {
  source: string;
  workspace?: string;
  ref?: string;
  contextId?: string;
  stateArgs?: Record<string, unknown>;
  name?: string;
  focus?: boolean;
  disposition?: "current" | "child" | "root";
}
```

The canonical carriers are versioned and equivalent:

- `vibestudio://panel?v=1&source=panels%2Fchat&...` is the installed-app/OS
  deep link.
- `https://vibestudio.app/panel#v=1&source=panels%2Fchat&...` is the shareable
  App Link / Universal Link. The payload is in the fragment so state arguments
  do not appear in ordinary HTTP access logs.

`vibestudio://connect` remains a separate pairing-only payload. The removed
`natstack-panel:`, `natstack-about:`, `ns:`, `ns-about:`, and `ns-focus:`
schemes are not asset transports or navigation APIs.

## Asset transport

Built panel HTML, JavaScript, and assets continue to load over the authenticated
managed HTTP gateway:

```text
http://127.0.0.1:<port>/_workspace/<workspace>/<source>/
```

That URL is host/session-specific and should not be shared. Desktop and mobile
translate a canonical `PanelLocation` into a panel-tree mutation, then the host
resolves the resulting build to its current gateway URL. Ordinary same-frame
managed links navigate the current slot; a real new-window link creates a child.
An explicit `disposition` overrides that default.

## Authoring

Use the runtime builders rather than assembling query strings:

```ts
import { buildPanelLink, buildPanelDeepLink, buildPanelShareLink } from "@workspace/runtime";

const inApp = buildPanelLink("panels/chat", {
  ref: "state:abc123",
  stateArgs: { initialPrompt: "Review this" },
  disposition: "current",
});

const share = buildPanelShareLink("panels/chat", {
  contextId: "ctx-123",
  stateArgs: { channelName: "design" },
  disposition: "root",
});
```

`buildPanelDeepLink` carries the same fields using the custom-scheme carrier.
The builders infer the selected workspace from the injected gateway URL unless
`workspace` is supplied explicitly.

## Validation and security

- Links require the exact current protocol version, a canonical two-segment
  source, unique known parameters, and object-shaped JSON state arguments.
- Link payloads are capped at 32 KiB and are validated again by the target
  panel's state schema.
- A link targeting a different workspace is not silently opened in the current
  workspace. Desktop carries the location through a one-shot workspace relaunch;
  mobile reports that the user must switch first.
- Custom schemes can be claimed by another installed application. Do not place
  credentials or bearer secrets in panel locations. Prefer the verified HTTPS
  carrier when sharing outside the app.
