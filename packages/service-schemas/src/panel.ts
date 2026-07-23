/**
 * panel service method schemas.
 */

import { z } from "zod";
import { BROWSER_NAVIGATION_TRANSITIONS } from "@vibestudio/shared/panelCommands";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  PanelFocusResultSchema,
  PanelTreeSnapshotSchema,
  ThemeConfigSchema,
} from "@vibestudio/shared/panelContracts";

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

const PanelAddressOptionsSchema = z
  .object({
    source: z.string(),
    suggestions: z.array(
      z.object({
        source: z.string(),
        title: z.string().optional(),
        kind: z.enum(["launchable", "package", "skill", "unit", "folder"]),
      })
    ),
  })
  .strict();

const BrowserAddressOptionsSchema = z.object({
  query: z.string(),
  suggestions: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
      visitCount: z.number().optional(),
      typedCount: z.number().optional(),
      lastVisit: z.number().optional(),
      source: z.enum(["history", "session", "bookmark", "search-engine"]),
      engineId: z.number().optional(),
      engineName: z.string().optional(),
      keyword: z.string().optional(),
      searchTemplate: z.string().optional(),
    })
  ),
});

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

// Wire shape of the per-device persisted panel layout (multi-column layout
// plan §3.3). The shell owns deep validation/pruning; this is the structural
// envelope so the RPC contract stays typed.
const PersistedPanelLayoutSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  layout: z.object({
    columns: z.array(
      z.object({
        id: z.string(),
        widthFr: z.number(),
        panes: z.array(z.object({ id: z.string(), heightFr: z.number(), panelId: z.string() })),
      })
    ),
    focusedPaneId: z.string().nullable(),
  }),
  updatedAt: z.string(),
});

const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const panelMethods = defineServiceMethods({
  updateTheme: {
    description: "Set the server-controlled theme appearance (light/dark) for the panel chrome.",
    args: z.tuple([z.enum(["light", "dark"])]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  updateThemeConfig: {
    description: "Set the server-controlled theme identity tokens broadcast to hosted panels.",
    args: z.tuple([ThemeConfigSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getThemeConfig: {
    description: "Return the current server-controlled theme identity tokens for hosted panels.",
    args: z.tuple([]),
    returns: ThemeConfigSchema,
    authority: { principals: ["user", "code"] },
    access: READ_ACCESS,
  },
  getTreeSnapshot: {
    description: "Return the Electron host's current mirrored panel tree snapshot.",
    args: z.tuple([]),
    returns: PanelTreeSnapshotSchema,
    access: READ_ACCESS,
  },
  getFocusedPanelId: {
    description: "Return the currently focused panel id from the Electron host mirror.",
    args: z.tuple([]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  getChromeState: {
    description: "Current chrome state (title, address, navigation affordances) for a panel by id.",
    args: z.tuple([z.string()]),
    returns: PanelChromeStateSchema,
    access: READ_ACCESS,
  },
  getAddressOptions: {
    description: "Address-bar options and suggestions for the current panel input.",
    args: z.tuple([z.string()]),
    returns: PanelAddressOptionsSchema,
    access: READ_ACCESS,
  },
  getBrowserAddressOptions: {
    description: "Browser address-bar options for a browser-backed panel by id.",
    args: z.tuple([z.string()]),
    returns: BrowserAddressOptionsSchema,
    access: READ_ACCESS,
  },
  ensureLoaded: {
    description:
      "Ensure a panel runtime is loaded into a host view without changing the active focus.",
    args: z.tuple([z.string()]),
    returns: PanelFocusResultSchema,
    access: WRITE_ACCESS,
  },
  takeOver: {
    description:
      "Take over a panel runtime lease for the calling host view and return the focus result.",
    args: z.tuple([z.string()]),
    returns: PanelFocusResultSchema,
    access: WRITE_ACCESS,
  },
  markBrowserNavigationIntent: {
    description:
      "Record how an imminent browser navigation was initiated so the panel can classify it.",
    args: z.tuple([z.string(), BrowserNavigationIntentSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  reloadView: {
    description: "Reload the panel's view.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  forceReloadView: {
    description: "Force-reload the panel's view, bypassing caches.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  findInPage: {
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
    description: "Close find-in-page and clear the current selection.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getBrowserSiteState: {
    description: "Return canonical bookmark, cookie, and zoom state for the current browser page.",
    args: z.tuple([z.string()]),
    returns: z.object({
      origin: z.string().url(),
      url: z.string().url(),
      secure: z.boolean(),
      zoomFactor: z.number(),
      bookmarkId: z.number().int().nullable(),
      cookieCount: z.number().int().nonnegative(),
    }),
    access: READ_ACCESS,
  },
  toggleBrowserBookmark: {
    description: "Add or remove the current browser page from canonical bookmarks.",
    args: z.tuple([z.string()]),
    returns: z.object({ bookmarked: z.boolean(), bookmarkId: z.number().int().nullable() }),
    access: WRITE_ACCESS,
  },
  setBrowserZoom: {
    description: "Set and persist page zoom for the current browser origin.",
    args: z.tuple([z.string(), z.number().min(0.25).max(5)]),
    returns: z.number(),
    access: WRITE_ACCESS,
  },
  clearBrowserSiteData: {
    description: "Clear canonical cookies and local site data for the current browser origin.",
    args: z.tuple([z.string()]),
    returns: z.number().int().nonnegative(),
    access: WRITE_ACCESS,
  },
  printBrowserPage: {
    description: "Open the native print flow for the current browser page.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  saveBrowserPagePdf: {
    description: "Save the current browser page as a PDF through a native file dialog.",
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
    access: WRITE_ACCESS,
  },
  stopBrowserMedia: {
    description: "Stop active camera, microphone, and geolocation use in a browser panel.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  togglePin: {
    description:
      "Toggle the client-local pin for a panel (by slot id). Returns the new pinned state.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    access: WRITE_ACCESS,
  },
  listPinnedPanelIds: {
    description: "List the slot ids of all client-local pinned panels.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  getPanelLayout: {
    description:
      "Return the client-local persisted panel layout for the active workspace and signed-in account, or null. The shell re-validates and prunes against the live tree on restore.",
    args: z.tuple([]),
    returns: PersistedPanelLayoutSchema.nullable(),
    access: READ_ACCESS,
  },
  savePanelLayout: {
    description:
      "Persist the client-local panel layout for the active workspace and signed-in account. Stored on this device only; never synced.",
    args: z.tuple([PersistedPanelLayoutSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  setFocusedPanelId: {
    description:
      "Record the focused panel in the Electron host mirror and persist the focused path, so getFocusedPanelId and restore reflect the shell's layout focus.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
});
