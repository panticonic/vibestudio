/**
 * panel service method schemas.
 */

import { z } from "zod";
import type { PanelFocusResult, ThemeAppearance, ThemeConfig } from "../types.js";
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
  updateThemeConfig: { args: z.tuple([z.custom<ThemeConfig>()]), returns: z.void() },
  getThemeConfig: {
    args: z.tuple([]),
    returns: z.custom<ThemeConfig>(),
    policy: { allowed: ["shell", "app", "panel"] },
  },
  getChromeState: { args: z.tuple([z.string()]), returns: z.custom<PanelChromeState>() },
  getAddressOptions: {
    args: z.tuple([z.string(), z.string().optional()]),
    returns: z.custom<PanelAddressOptions>(),
  },
  getBrowserAddressOptions: {
    args: z.tuple([z.string()]),
    returns: z.custom<BrowserAddressOptions>(),
  },
  ensureLoaded: { args: z.tuple([z.string()]), returns: z.custom<PanelFocusResult>() },
  takeOver: { args: z.tuple([z.string()]), returns: z.custom<PanelFocusResult>() },
  markBrowserNavigationIntent: {
    args: z.tuple([z.string(), BrowserNavigationIntentSchema]),
    returns: z.void(),
  },
  reloadView: { args: z.tuple([z.string()]), returns: z.void() },
  forceReloadView: { args: z.tuple([z.string()]), returns: z.void() },
});
