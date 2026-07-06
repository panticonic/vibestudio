/**
 * Context-marker discovery shared by the `claude` command group (plan §6.2
 * step 3): materialized context folders carry `.vibestudio-context.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CONTEXT_MARKER = ".vibestudio-context.json";

export interface ContextMarker {
  contextId: string;
  workspaceId?: string;
  serverUrl?: string;
  entityHint?: string;
}

/** cwd-upward search for the context marker. */
export function findContextMarker(startDir: string): ContextMarker | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONTEXT_MARKER);
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ContextMarker;
        if (parsed && typeof parsed.contextId === "string") return parsed;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
