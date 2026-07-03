/**
 * Autofill preload — the defensive `??` fallback for the browser-panel surface
 * (PanelView.createViewForBrowser uses `browserPreloadPath ?? autofillPreloadPath`).
 * browserPreload.ts is the live path; this entry point exposes the identical
 * `__vibez1_autofill` bridge via the shared helper so the two cannot drift.
 */

import { exposeAutofillBridge } from "./autofillBridge.js";

exposeAutofillBridge();
