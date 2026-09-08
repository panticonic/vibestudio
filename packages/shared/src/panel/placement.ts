import type { PanelPlacementHint } from "../types.js";

const PLACEMENT_DISPOSITIONS = new Set(["side", "side-if-room", "replace", "split-below"]);

/**
 * Validate and normalize a manifest/call-site `placement` block. Returns a
 * clean `PanelPlacementHint` with only recognized, well-typed fields, or
 * undefined when nothing valid is present. Invalid `disposition` values throw
 * (a typo'd manifest should fail loudly, not silently fall back to "side").
 */
export function sanitizePlacementHint(value: unknown): PanelPlacementHint | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("vibestudio.placement must be an object");
  }
  const raw = value as Record<string, unknown>;
  const hint: PanelPlacementHint = {};
  if (raw["disposition"] !== undefined) {
    if (typeof raw["disposition"] !== "string" || !PLACEMENT_DISPOSITIONS.has(raw["disposition"])) {
      throw new Error(
        `vibestudio.placement.disposition must be one of "side" | "side-if-room" | "replace" | "split-below", got ${JSON.stringify(raw["disposition"])}`
      );
    }
    hint.disposition = raw["disposition"] as PanelPlacementHint["disposition"];
  }
  for (const key of ["preferredWidth", "minWidth"] as const) {
    const width = raw[key];
    if (width === undefined) continue;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      throw new Error(`vibestudio.placement.${key} must be a positive number`);
    }
    hint[key] = width;
  }
  return Object.keys(hint).length > 0 ? hint : undefined;
}

