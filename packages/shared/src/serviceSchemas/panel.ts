/**
 * panel service method schemas.
 */

import { z } from "zod";
import type { ThemeAppearance } from "../types.js";
import type {
  BrowserAddressOptions,
  PanelAddressOptions,
  PanelChromeState,
} from "../panelChrome.js";
import { BROWSER_NAVIGATION_TRANSITIONS } from "../panelCommands.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const BrowserNavigationIntentSchema = z.object({
  transition: z.enum(BROWSER_NAVIGATION_TRANSITIONS).optional(),
  typed: z.boolean().optional(),
});

export const panelMethods = defineServiceMethods({
  updateTheme: { args: z.tuple([z.custom<ThemeAppearance>()]), returns: z.void() },
  getChromeState: { args: z.tuple([z.string()]), returns: z.custom<PanelChromeState>() },
  getAddressOptions: {
    args: z.tuple([z.string(), z.string().optional()]),
    returns: z.custom<PanelAddressOptions>(),
  },
  getBrowserAddressOptions: {
    args: z.tuple([z.string()]),
    returns: z.custom<BrowserAddressOptions>(),
  },
  markBrowserNavigationIntent: {
    args: z.tuple([z.string(), BrowserNavigationIntentSchema]),
    returns: z.void(),
  },
  reloadView: { args: z.tuple([z.string()]), returns: z.void() },
  forceReloadView: { args: z.tuple([z.string()]), returns: z.void() },
});
