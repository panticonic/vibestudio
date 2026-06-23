/**
 * palette service method schemas — the app-level command palette bridge.
 *
 * Panels `register` their contributed commands (keyed by the calling panel id);
 * the shell `list`s the contributions and `run`s a chosen one, which the main
 * process dispatches back to the owning panel via `runtime:palette-run`.
 */

import { z } from "zod";
import type { PaletteCommand } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const paletteMethods = defineServiceMethods({
  register: { args: z.tuple([z.array(z.custom<PaletteCommand>())]), returns: z.void() },
  unregister: { args: z.tuple([]), returns: z.void() },
  list: {
    args: z.tuple([]),
    returns: z.custom<Array<{ panelId: string; commands: PaletteCommand[] }>>(),
  },
  run: { args: z.tuple([z.string(), z.string()]), returns: z.void() },
});
