/**
 * view service method schemas — control of native Electron views (bounds,
 * visibility, theme CSS, browser navigation, and native panel/shell-overlay
 * slots). Pure-data wire contract shared by the server registration and typed
 * clients.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { panelMethods } from "./panel.js";

/** Electron-local shell to native WebContents projection. Cross-client runtime
 * ownership remains exclusively in panelRuntime. */
export const NATIVE_PANEL_SURFACE_PROTOCOL_VERSION = 1 as const;
const nativeSurfaceIdentity = z.string().min(1);
const nativeSurfaceRevision = z.number().int().nonnegative();
export const NativePanelAdapterHelloSchema = z
  .object({
    sealedLaunchIdentity: nativeSurfaceIdentity,
    supportedProtocolVersions: z.array(z.literal(NATIVE_PANEL_SURFACE_PROTOCOL_VERSION)),
  })
  .strict();
export type NativePanelAdapterHello = z.infer<typeof NativePanelAdapterHelloSchema>;
export const NativePanelAdapterHandshakeSchema = z
  .object({
    protocolVersion: z.literal(NATIVE_PANEL_SURFACE_PROTOCOL_VERSION),
    hostGeneration: nativeSurfaceIdentity,
    shellGeneration: nativeSurfaceIdentity,
    sealedLaunchIdentity: nativeSurfaceIdentity,
  })
  .strict();
export type NativePanelAdapterHandshake = z.infer<typeof NativePanelAdapterHandshakeSchema>;
export const NativePanelAdapterHandshakeResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), handshake: NativePanelAdapterHandshakeSchema }).strict(),
  z.object({ accepted: z.literal(false), reason: z.literal("unsupported-protocol") }).strict(),
]);
export type NativePanelAdapterHandshakeResult = z.infer<
  typeof NativePanelAdapterHandshakeResultSchema
>;
export const DesiredNativePanelSurfaceSchema = z
  .object({
    surfaceId: nativeSurfaceIdentity,
    materialization: z
      .object({ runtimeEntityId: nativeSurfaceIdentity, leaseConnectionId: nativeSurfaceIdentity })
      .strict(),
    visible: z.boolean(),
    focused: z.boolean(),
    bounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const NativePanelDesiredSnapshotSchema = z
  .object({
    protocolVersion: z.literal(NATIVE_PANEL_SURFACE_PROTOCOL_VERSION),
    hostGeneration: nativeSurfaceIdentity,
    shellGeneration: nativeSurfaceIdentity,
    revision: nativeSurfaceRevision,
    surfaces: z.array(DesiredNativePanelSurfaceSchema),
  })
  .strict();
export type NativePanelDesiredSnapshot = z.infer<typeof NativePanelDesiredSnapshotSchema>;
export const NativePanelObservedSnapshotSchema = z
  .object({
    protocolVersion: z.literal(NATIVE_PANEL_SURFACE_PROTOCOL_VERSION),
    hostGeneration: nativeSurfaceIdentity,
    shellGeneration: nativeSurfaceIdentity,
    desiredRevision: nativeSurfaceRevision,
    observationRevision: nativeSurfaceRevision,
    surfaces: z.array(
      z
        .object({
          surfaceId: nativeSurfaceIdentity,
          nativeSurfaceId: nativeSurfaceIdentity,
          materialization: z
            .object({
              runtimeEntityId: nativeSurfaceIdentity,
              leaseConnectionId: nativeSurfaceIdentity,
            })
            .strict(),
          visible: z.boolean(),
          focused: z.boolean(),
          bounds: z
            .object({
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().finite().nonnegative(),
              height: z.number().finite().nonnegative(),
            })
            .strict(),
        })
        .strict()
    ),
  })
  .strict();
export type NativePanelObservedSnapshot = z.infer<typeof NativePanelObservedSnapshotSchema>;
export const NativePanelApplyResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), observation: NativePanelObservedSnapshotSchema }).strict(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum([
        "foreign-host-generation",
        "invalid-desired-state",
        "revision-conflict",
        "stale-revision",
        "stale-shell-generation",
        "unsupported-protocol",
      ]),
    })
    .strict(),
]);
export type NativePanelApplyResult = z.infer<typeof NativePanelApplyResultSchema>;

// Access descriptors classify native window/view mutations. The Electron view
// service definition separately declares the required principals.

const VIEW_BOUNDS_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_VISIBILITY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_INPUT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_THEME_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_SLOT_BIND_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_TOGGLE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_SHOW_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_HIDE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_NAVIGATE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_NAV_HISTORY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_RELOAD_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_STOP_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const ViewBoundsSchema = z.object({
  x: z.number().describe("Left edge in window-relative pixels."),
  y: z.number().describe("Top edge in window-relative pixels."),
  width: z.number().describe("View width in pixels."),
  height: z.number().describe("View height in pixels."),
});
export type ViewBounds = z.infer<typeof ViewBoundsSchema>;

export const ViewPointSchema = z.object({
  x: z.number().describe("X coordinate in window-relative pixels."),
  y: z.number().describe("Y coordinate in window-relative pixels."),
});
export type ViewPoint = z.infer<typeof ViewPointSchema>;

const OverlayRangeSchema = z.object({
  start: z.number().describe("Inclusive start index of the highlighted range."),
  end: z.number().describe("Exclusive end index of the highlighted range."),
});
export const ShellOverlayRowSchema = z.object({
  label: z.string().describe("Primary text shown for the row."),
  meta: z.string().optional().describe("Secondary/detail text shown alongside the label."),
  labelRanges: z
    .array(OverlayRangeSchema)
    .optional()
    .describe("Character ranges within `label` to highlight (e.g. fuzzy-match hits)."),
  metaRanges: z
    .array(OverlayRangeSchema)
    .optional()
    .describe("Character ranges within `meta` to highlight."),
  icon: z.string().optional().describe("Optional icon identifier rendered before the label."),
  selected: z.boolean().optional().describe("Whether this row is the currently selected one."),
  type: z.string().describe("Row kind used by the shell to route activation/payload handling."),
  payload: z.unknown().optional().describe("Opaque data passed back when the row is activated."),
});

export const ContentOverlayThemeSchema = z.object({
  appearance: z.enum(["light", "dark"]).describe("Resolved light/dark appearance."),
  accentColor: z.string().optional().describe("Radix accent color name."),
  grayColor: z.string().optional().describe("Radix gray scale name."),
  panelBackground: z.enum(["solid", "translucent"]).optional(),
  radius: z.enum(["none", "small", "medium", "large", "full"]).optional(),
  scaling: z.enum(["90%", "95%", "100%", "105%", "110%"]).optional(),
});
export type ContentOverlayTheme = z.infer<typeof ContentOverlayThemeSchema>;

export const coreViewMethods = defineServiceMethods({
  setBounds: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Reposition and resize a native view to the given window-relative pixel bounds.",
    args: z.tuple([z.string(), ViewBoundsSchema]),
    returns: z.void(),
    access: VIEW_BOUNDS_ACCESS,
    examples: [{ args: ["view-123", { x: 0, y: 48, width: 800, height: 600 }] }],
  },
  setVisible: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Show or hide a native view without changing its bounds.",
    args: z.tuple([z.string(), z.boolean()]),
    returns: z.void(),
    access: VIEW_VISIBILITY_ACCESS,
    examples: [{ args: ["view-123", true] }],
  },
  forwardMouseClick: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Synthesize a left mouse click at a window-relative point inside a view, focusing it; returns false if the point falls outside the view's bounds or the view is gone.",
    args: z.tuple([z.string(), ViewPointSchema]),
    returns: z.boolean(),
    access: VIEW_INPUT_ACCESS,
    examples: [{ args: ["view-123", { x: 120, y: 80 }], returns: true }],
  },
  setThemeCss: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Apply a global theme CSS string injected into hosted views.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_THEME_ACCESS,
  },
  connectNativePanelAdapter: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Negotiate one generation-fenced native panel-host session.",
    args: z.tuple([NativePanelAdapterHelloSchema]),
    returns: NativePanelAdapterHandshakeResultSchema,
    access: VIEW_SLOT_BIND_ACCESS,
  },
  applyNativePanelSurfaces: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Converge the native adapter to one complete desired surface snapshot.",
    args: z.tuple([NativePanelDesiredSnapshotSchema]),
    returns: NativePanelApplyResultSchema,
    access: VIEW_SLOT_BIND_ACCESS,
  },
  setShellOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Activate or deactivate the shell overlay layer.",
    args: z.tuple([z.boolean()]),
    returns: z.void(),
    access: VIEW_OVERLAY_TOGGLE_ACCESS,
  },
  showNativeShellOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Show a native shell overlay (e.g. a command palette/list) with the given rows at the supplied bounds.",
    args: z.tuple([
      z.object({
        id: z.string().describe("Overlay instance identifier."),
        rows: z.array(ShellOverlayRowSchema).describe("Rows to render in the overlay list."),
        empty: z.string().describe("Text shown when there are no rows."),
        bounds: ViewBoundsSchema.describe("Window-relative bounds for the overlay."),
        focus: z.boolean().optional().describe("Whether the overlay should grab focus."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  updateNativeShellOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Update an already-shown native shell overlay; every field is optional, so only the provided properties change.",
    args: z.tuple([
      z.object({
        id: z.string().optional().describe("Overlay instance identifier, if retargeting."),
        rows: z.array(ShellOverlayRowSchema).optional().describe("Replacement rows, if changing."),
        empty: z.string().optional().describe("Replacement empty-state text, if changing."),
        bounds: ViewBoundsSchema.optional().describe("New window-relative bounds, if changing."),
        focus: z.boolean().optional().describe("New focus state, if changing."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  hideNativeShellOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Hide a native shell overlay, optionally identified by id; omit the id to hide the active overlay.",
    args: z.tuple([z.string().optional()]),
    returns: z.void(),
    access: VIEW_OVERLAY_HIDE_ACCESS,
  },
  showContentOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Show the rich content overlay (a shell React surface floated above the panels) for the given surface key, anchored to the supplied region.",
    args: z.tuple([
      z.object({
        surface: z.string().describe("Registered overlay surface key (e.g. 'approval-card')."),
        bounds: ViewBoundsSchema.describe("Anchor region (the panel viewport rect)."),
        props: z.unknown().describe("Serialized props pushed to the surface."),
        theme: ContentOverlayThemeSchema.describe(
          "Theme identity so the surface matches the chrome."
        ),
        focus: z.boolean().optional().describe("Whether the overlay should grab focus."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  updateContentOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Update the already-shown content overlay; every field is optional, so only the provided properties change.",
    args: z.tuple([
      z.object({
        surface: z.string().optional().describe("New surface key, if retargeting."),
        bounds: ViewBoundsSchema.optional().describe("New anchor region, if changing."),
        props: z.unknown().optional().describe("Replacement props, if changing."),
        theme: ContentOverlayThemeSchema.optional().describe("New theme identity, if changing."),
        focus: z.boolean().optional().describe("New focus state, if changing."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  hideContentOverlay: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Hide the content overlay surface.",
    args: z.tuple([]),
    returns: z.void(),
    access: VIEW_OVERLAY_HIDE_ACCESS,
  },
  browserNavigate: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Navigate a browser view to an http(s) URL (rejected if the URL is not http/https).",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: VIEW_NAVIGATE_ACCESS,
    examples: [{ args: ["browser-1", "https://example.com"] }],
  },
  browserGoBack: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Navigate a browser view back one entry in its history.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_NAV_HISTORY_ACCESS,
  },
  browserGoForward: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Navigate a browser view forward one entry in its history.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_NAV_HISTORY_ACCESS,
  },
  browserReload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Reload a browser view.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_RELOAD_ACCESS,
  },
  browserForceReload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Reload a browser view bypassing the cache.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_RELOAD_ACCESS,
  },
  browserStop: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Stop any in-progress load in a browser view.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_STOP_ACCESS,
  },
});

/** The one public Electron view surface, including panel-hosting operations. */
export const viewMethods = defineServiceMethods({
  ...coreViewMethods,
  ...panelMethods,
});
