# Linking to panels across workspaces

Use `buildPanelLink` from `@workspace/runtime` for navigable links. It produces
a logical panel address, independent of the HTTP URL serving a build.

```tsx
import { buildPanelLink } from "@workspace/runtime";

<a
  href={buildPanelLink("about/automations", {
    workspace: { role: "system" },
  })}
>
  Explore automations
</a>;
```

This opens the signed-in user's System workspace and creates a root panel
there. It works as a clicked link, a new-panel link, or an address entered in
the shell. Desktop and mobile resolve destinations against their authenticated
workspace catalogs using the same rules.

## Choose a destination

| `workspace` option       | Meaning                        |
| ------------------------ | ------------------------------ |
| Omitted                  | The current workspace          |
| `"Research"`             | Exact workspace name           |
| `{ id: "workspace-id" }` | Exact workspace ID             |
| `{ role: "system" }`     | This user's System workspace   |
| `{ role: "personal" }`   | This user's Personal workspace |

Names and IDs are never guessed or treated as interchangeable. Private roles
work without discovering account-specific IDs or relying on display names.
Missing or ambiguous destinations fail visibly; they never fall back to the
current workspace. Links do not grant membership or permission to read data.

## State and placement

```tsx
const href = buildPanelLink("panels/editor", {
  workspace: "Research",
  stateArgs: { document: "notes" },
  disposition: "root",
  placement: { disposition: "side-if-room" },
});
```

The destination panel validates `stateArgs` against its manifest.
`ref` selects code and `contextId` selects storage inside the destination
workspace. Omit them to use the destination defaults; never copy the source
panel's context into a different workspace by accident.

A workspace-qualified link defaults to a new root in its destination.
Explicit `current` replaces the destination's focused panel;
`child` creates a child of that panel. If the destination has no focused
panel, either creates a root. A source panel never becomes a parent in
another workspace. Visual placement hints are applied where the host supports
them. `focus: false` avoids focusing the created panel; following the link
still selects the destination workspace.

Unqualified links retain ordinary local navigation: a click can navigate the
source panel; opening in a new panel creates a child. Set `disposition`
explicitly when you need a particular tree placement.

## Share and programmatic navigation

`buildPanelDeepLink(source, options)` builds an OS/app link;
`buildPanelShareLink(source, options)` builds an HTTPS share link.
Both capture the current workspace when no destination is supplied, so a
copied link keeps its destination. Supply a private role for a link intended
to work in each recipient's own Personal/System workspace.

All three builders serialize the same `PanelLocation` contract. A simple
name uses `workspace=Research`; typed targets carry `workspaceKind=id|role`
and their value. Use the builders instead of constructing query strings.

For a button, navigate to the URL from the same click handler, for example
`window.location.href = buildPanelLink(source, options)`. Prefer an anchor
when the action is navigation, so copying and new-panel gestures remain
available.

`openPanel(source, options)` is a workspace-local runtime operation that
returns a panel handle. It does not search other workspaces. Cross-workspace
navigation is a user-facing link, not an RPC read of the destination panel.
Cross-workspace data access still requires explicitly exposed RPC methods
and the corresponding authority.

Panel links are not asset URLs. Use the workspace asset-serving URL for
images and other build assets; do not append paths to a navigation link.
