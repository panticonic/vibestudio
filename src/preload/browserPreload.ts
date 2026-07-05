/**
 * Browser panel preload — autofill only (no __vibestudioShell).
 *
 * Browser panels load arbitrary external websites and must NOT have access
 * to host IPC. Only password autofill is injected.
 *
 * The `__vibestudio_autofill` bridge is shared with autofillPreload.ts via
 * exposeAutofillBridge(); see autofillBridge.ts for why both entry points exist.
 */

import { exposeAutofillBridge } from "./autofillBridge.js";

exposeAutofillBridge();
