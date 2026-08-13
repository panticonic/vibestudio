/**
 * panel service method schemas.
 */

import { z } from "zod";
import { BROWSER_NAVIGATION_TRANSITIONS } from "@vibestudio/shared/panelCommands";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import type { PanelPresentationSnapshot } from "@vibestudio/shared/panel/presentation";
import {
  PanelFocusResultSchema,
  PanelSchema,
  ThemeConfigSchema,
} from "@vibestudio/shared/panelContracts";

export const PanelPlacementHintSchema = z.object({
  disposition: z.enum(["side", "side-if-room", "replace", "split-below"]).optional(),
  preferredWidth: z.number().positive().optional(),
  minWidth: z.number().positive().optional(),
});

const PanelCreateOptionsSchema = z
  .object({
    title: z.string().optional(),
    slug: z.string().optional(),
    contextId: z.string().optional(),
    ref: z.string().optional(),
    focus: z.boolean().optional(),
    stateArgs: z.record(z.string(), z.unknown()).optional(),
    placement: PanelPlacementHintSchema.optional(),
  })
  .strict();

const PanelCreateResultSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const PanelChromeStateSchema = z
  .object({
    panelId: z.string(),
    title: z.string(),
    kind: z.enum(["panel", "browser"]),
    source: z.string(),
    contextId: z.string(),
    displayAddress: z.string(),
    editableAddress: z.string(),
    browserUrl: z.string().optional(),
    resolvedUrl: z.string().optional(),
    favicon: z
      .object({
        pageUrl: z.string(),
        updatedAt: z.number(),
      })
      .optional(),
    ref: z.string().optional(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    mediaPlaying: z.boolean(),
  })
  .strict();

export const BrowserNavigationIntentSchema = z.object({
  transition: z
    .enum(BROWSER_NAVIGATION_TRANSITIONS)
    .optional()
    .describe("How the navigation was initiated (link click, typed address, reload, ...)."),
  typed: z
    .boolean()
    .optional()
    .describe("True if the user typed the destination into the address bar."),
});

const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

const PanelPresentationSchema = z.intersection(
  PanelSchema,
  z.object({
    parentId: z.string().nullable(),
    position: z.number().int().nonnegative(),
    hostViewRevision: z.number().int().nonnegative(),
  })
);

const LocalPanelPresentationSnapshotSchema: z.ZodType<PanelPresentationSnapshot> = z.object({
  revision: z.number().int().nonnegative(),
  presentation: z.discriminatedUnion("state", [
    z.object({ state: z.literal("idle"), slotId: z.string() }),
    z.object({
      state: z.literal("loading"),
      slotId: z.string(),
      attemptId: z.string(),
      stage: z.enum([
        "resolving",
        "leasing",
        "creating-view",
        "navigating",
        "booting",
        "waiting-for-slot",
        "attaching",
        "recovering",
      ]),
      enteredAt: z.number(),
    }),
    z.object({
      state: z.literal("unavailable"),
      slotId: z.string(),
      attemptId: z.string(),
      reason: z.literal("leased-elsewhere"),
      lease: z.object({
        runtimeEntityId: z.string(),
        connectionId: z.string(),
        clientSessionId: z.string(),
        holderLabel: z.string(),
        holderPlatform: z.enum(["desktop", "headless", "mobile"]),
      }),
      enteredAt: z.number(),
    }),
    z.object({
      state: z.literal("ready"),
      slotId: z.string(),
      attemptId: z.string(),
      surface: z.enum(["code", "external"]),
      runtimeEntityId: z.string(),
      webContentsId: z.number().int().nonnegative(),
      nativeSlotId: z.string(),
      documentRevision: z.number().int().nonnegative(),
      url: z.string(),
      enteredAt: z.number(),
    }),
    z.object({
      state: z.literal("failed"),
      slotId: z.string(),
      attemptId: z.string(),
      stage: z.enum([
        "resolving",
        "leasing",
        "creating-view",
        "navigating",
        "booting",
        "waiting-for-slot",
        "attaching",
        "recovering",
      ]),
      code: z.string(),
      message: z.string(),
      enteredAt: z.number(),
    }),
  ]),
});

export const panelMethods = defineServiceMethods({
  createPanel: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Shell-owned panel creation commits and presents the durable slot promptly; native readiness follows through the panel presentation lifecycle",
    },
    description:
      "Commit and present a workspace panel under a parent on the current native host while runtime preparation continues in the background.",
    args: z.tuple([z.string().nullable(), z.string(), PanelCreateOptionsSchema.optional()]),
    returns: PanelCreateResultSchema,
    authority: { principals: ["user", "code"] },
    access: WRITE_ACCESS,
  },
  focusPanel: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Focus and placement are device-local native presentation effects on the caller's panel host",
    },
    description: "Focus a panel on the current native host, loading its current lease if needed.",
    args: z.tuple([
      z.string(),
      z
        .object({
          anchorPanelId: z.string().optional(),
          placement: PanelPlacementHintSchema.optional(),
        })
        .optional(),
    ]),
    returns: PanelFocusResultSchema,
    authority: { principals: ["user", "code"] },
    access: WRITE_ACCESS,
  },
  ensurePanelLoaded: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Materializes a resident panel on the caller's native host without changing shell layout focus",
    },
    description:
      "Ensure a panel has a native view on this host without navigating to it or waiting for visible-slot readiness.",
    args: z.tuple([z.string()]),
    returns: PanelFocusResultSchema,
    authority: { principals: ["user", "code"] },
    access: WRITE_ACCESS,
  },
  updateTheme: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Set the server-controlled theme appearance (light/dark) for the panel chrome.",
    args: z.tuple([z.enum(["light", "dark"])]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  updateThemeConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Set the server-controlled theme identity tokens broadcast to hosted panels.",
    args: z.tuple([ThemeConfigSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getThemeConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Return the current server-controlled theme identity tokens for hosted panels.",
    args: z.tuple([]),
    returns: ThemeConfigSchema,
    authority: { principals: ["user", "code"] },
    access: READ_ACCESS,
  },
  getPresentation: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: read-only Electron-local presentation state for trusted panel-hosting chrome",
    },
    description: "Return the Electron host's current local presentation projection for a panel.",
    args: z.tuple([z.string()]),
    returns: PanelPresentationSchema.nullable(),
    access: READ_ACCESS,
  },
  getPresentations: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: batched read-only Electron-local presentation state for trusted panel-hosting chrome",
    },
    description: "Return local presentation projections for a bounded set of panels in one IPC.",
    args: z.tuple([z.array(z.string()).max(2_000)]),
    returns: z.array(PanelPresentationSchema),
    access: READ_ACCESS,
  },
  getLocalPresentation: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale: "Trusted panel chrome reads Electron's canonical local presentation state",
    },
    description: "Return the revisioned Electron-local lifecycle snapshot for one panel slot.",
    args: z.tuple([z.string()]),
    returns: LocalPanelPresentationSnapshotSchema,
    access: READ_ACCESS,
  },
  getChromeState: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "Current chrome state (title, address, navigation affordances) for a panel by id.",
    args: z.tuple([z.string()]),
    returns: PanelChromeStateSchema,
    access: READ_ACCESS,
  },
  markBrowserNavigationIntent: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Record how an imminent browser navigation was initiated so the panel can classify it.",
    args: z.tuple([z.string(), BrowserNavigationIntentSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  findInPage: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: in-page find UI on the focused panel; core mutually inspectable workspace UX.",
    },
    description: "Find text in the current panel document and return the final match count.",
    args: z.tuple([
      z.string(),
      z.string().max(2_000),
      z.object({ forward: z.boolean(), findNext: z.boolean() }),
    ]),
    returns: z.object({
      activeMatchOrdinal: z.number().int().nonnegative(),
      matches: z.number().int().nonnegative(),
    }),
    access: READ_ACCESS,
  },
  stopFindInPage: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: dismisses the in-page find session; core mutually inspectable workspace UX.",
    },
    description: "Close find-in-page and clear the current selection.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getBrowserPageIdentity: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "Reads the exact URL, origin, and native document title from an Electron browser webContents.",
    },
    description: "Return the native page identity needed for workspace-owned browser actions.",
    args: z.tuple([z.string()]),
    returns: z.object({
      origin: z.string().url(),
      url: z.string().url(),
      secure: z.boolean(),
      title: z.string(),
    }),
    access: READ_ACCESS,
  },
  setNativeBrowserZoom: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "Applies an already-selected zoom factor to the exact Electron browser webContents.",
    },
    description:
      "Apply native page zoom after workspace code has persisted the preference for this exact origin.",
    args: z.tuple([z.string(), z.string().url(), z.number().min(0.25).max(5)]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  clearNativeBrowserSiteData: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Clears Electron session storage for an origin that is still displayed by the selected browser panel.",
    },
    description:
      "Clear native cookies, cache, local storage, IndexedDB, and service workers for one current origin.",
    args: z.tuple([z.string(), z.string().url()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  printBrowserPage: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: shell print action on the focused browser panel; core mutually inspectable workspace UX.",
    },
    description: "Open the native print flow for the current browser page.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  saveBrowserPagePdf: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: shell save-as-PDF action on the focused browser panel; core mutually inspectable workspace UX.",
    },
    description: "Save the current browser page as a PDF through a native file dialog.",
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
    access: WRITE_ACCESS,
  },
  stopBrowserMedia: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: stops media in the focused browser panel; core mutually inspectable workspace UX.",
    },
    description: "Stop active camera, microphone, and geolocation use in a browser panel.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  togglePin: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description:
      "Toggle the client-local pin for a panel (by slot id). Returns the new pinned state.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    access: WRITE_ACCESS,
  },
  listPinnedPanelIds: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    description: "List the slot ids of all client-local pinned panels.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  getFocusedPanelId: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale: "Reads the selected panel from the exact client-local native view registry",
    },
    description: "Return this client's focused panel id.",
    args: z.tuple([]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  setFocusedPanelId: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale:
        "Records the exact shell layout focus without acquiring a lease or emitting a navigation intent",
    },
    description: "Persist this client's focused panel id without loading or navigating the panel.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  openPanelDevTools: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.native-panel",
      rationale: "Opens Electron DevTools for the exact native panel webContents",
    },
    description: "Open native developer tools for a panel hosted by this client.",
    args: z.tuple([z.string(), z.enum(["detach", "right", "bottom"]).optional()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
});
