/**
 * In-memory cache of the most recent structured diagnostics per build key and
 * per unit name. Populated by the state-trigger build path and the push gate so
 * `getBuildMetadata` / `agent diag` / `getBuildReport` can surface structured
 * esbuild + tsc diagnostics after the fact (the synchronous path is
 * `validateRepoPush`; this is the queryable companion).
 *
 * This is a best-effort cache, not the source of truth: it bounds memory and is
 * lost on restart. Cleared between tests via `clearDiagnostics`.
 */

import type { BuildDiagnostic } from "./diagnostics.js";

const byBuildKey = new Map<string, BuildDiagnostic[]>();
const byUnitName = new Map<string, BuildDiagnostic[]>();

export function recordDiagnostics(
  unitName: string,
  buildKey: string | null,
  diagnostics: BuildDiagnostic[]
): void {
  byUnitName.set(unitName, diagnostics);
  if (buildKey) byBuildKey.set(buildKey, diagnostics);
  // Bound memory.
  if (byUnitName.size > 500) {
    const first = byUnitName.keys().next().value;
    if (first !== undefined) byUnitName.delete(first);
  }
  if (byBuildKey.size > 1000) {
    const first = byBuildKey.keys().next().value;
    if (first !== undefined) byBuildKey.delete(first);
  }
}

export function diagnosticsForBuildKey(buildKey: string): BuildDiagnostic[] | null {
  return byBuildKey.get(buildKey) ?? null;
}

export function diagnosticsForUnit(unitName: string): BuildDiagnostic[] | null {
  return byUnitName.get(unitName) ?? null;
}

export function clearDiagnostics(): void {
  byBuildKey.clear();
  byUnitName.clear();
}
