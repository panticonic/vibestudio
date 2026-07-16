/**
 * Canonical JSON for every hash domain shared by the host, workerd programs,
 * the agentic protocol, and the semantic control plane.
 *
 * This package is deliberately dependency-free and runtime-neutral. A hash
 * protocol may choose a different domain separator, but never a private
 * serialization implementation.
 */

import { compareUtf16CodeUnits } from "./canonical-order.js";

export function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
      const child = record[key];
      if (child !== undefined) sorted[key] = sortForCanonicalJson(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}
