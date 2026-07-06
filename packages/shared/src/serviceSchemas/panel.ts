/**
 * panel service method schemas.
 */

import { z } from "zod";
import type {
  PanelFocusResult,
  PanelTreeSnapshot,
  ThemeAppearance,
  ThemeConfig,
} from "../types.js";
import type {
  BrowserAddressOptions,
  PanelAddressOptions,
  PanelChromeState,
} from "../panelChrome.js";
import { BROWSER_NAVIGATION_TRANSITIONS } from "../panelCommands.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";

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

export const panelMethods = defineServiceMethods({
  updateTheme: {
    description: "Set the server-controlled theme appearance (light/dark) for the panel chrome.",
    args: z.tuple([z.custom<ThemeAppearance>()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  updateThemeConfig: {
    description: "Set the server-controlled theme identity tokens broadcast to hosted panels.",
    args: z.tuple([z.custom<ThemeConfig>()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getThemeConfig: {
    description: "Return the current server-controlled theme identity tokens for hosted panels.",
    args: z.tuple([]),
    returns: z.custom<ThemeConfig>(),
    policy: { allowed: ["shell", "app", "panel"] },
    access: READ_ACCESS,
  },
  getTreeSnapshot: {
    description: "Return the Electron host's current mirrored panel tree snapshot.",
    args: z.tuple([]),
    returns: z.custom<PanelTreeSnapshot>(),
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
    returns: z.custom<PanelChromeState>(),
    access: READ_ACCESS,
  },
  getAddressOptions: {
    description: "Address-bar options/suggestions for a panel (optionally given current input).",
    args: z.tuple([z.string(), z.string().optional()]),
    returns: z.custom<PanelAddressOptions>(),
    access: READ_ACCESS,
  },
  getBrowserAddressOptions: {
    description: "Browser address-bar options for a browser-backed panel by id.",
    args: z.tuple([z.string()]),
    returns: z.custom<BrowserAddressOptions>(),
    access: READ_ACCESS,
  },
  ensureLoaded: {
    description:
      "Ensure a panel runtime is loaded into a host view without changing the active focus.",
    args: z.tuple([z.string()]),
    returns: z.custom<PanelFocusResult>(),
    access: WRITE_ACCESS,
  },
  takeOver: {
    description:
      "Take over a panel runtime lease for the calling host view and return the focus result.",
    args: z.tuple([z.string()]),
    returns: z.custom<PanelFocusResult>(),
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
});
