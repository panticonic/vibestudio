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
}

function parseContextMarker(value: unknown): ContextMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Partial<ContextMarker>;
  const allowedKeys = new Set(["contextId", "workspaceId", "serverUrl"]);
  if (
    Object.keys(marker).some((key) => !allowedKeys.has(key)) ||
    typeof marker.contextId !== "string" ||
    !marker.contextId ||
    (marker.workspaceId !== undefined &&
      (typeof marker.workspaceId !== "string" || !marker.workspaceId)) ||
    (marker.serverUrl !== undefined && (typeof marker.serverUrl !== "string" || !marker.serverUrl))
  ) {
    return null;
  }
  return {
    contextId: marker.contextId,
    ...(marker.workspaceId ? { workspaceId: marker.workspaceId } : {}),
    ...(marker.serverUrl ? { serverUrl: marker.serverUrl } : {}),
  };
}

/** cwd-upward search for the context marker. */
export function findContextMarker(startDir: string): ContextMarker | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONTEXT_MARKER);
    if (fs.existsSync(candidate)) {
      try {
        return parseContextMarker(JSON.parse(fs.readFileSync(candidate, "utf8")));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
