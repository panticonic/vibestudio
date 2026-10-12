/**
 * In-memory cache of the most recent structured diagnostics per build key and
 * per unit name. Populated by state-triggered and explicit exact-state builds so
 * `getBuildMetadata` / `agent diag` / `getBuildReport` can surface structured
 * esbuild + tsc diagnostics after the fact.
 *
 * This is a best-effort cache, not the source of truth: it bounds memory and is
 * lost on restart. Cleared between tests via `clearDiagnostics`.
 */

import type { BuildDiagnostic } from "./diagnostics.js";

/** Role-owned diagnostics; unit names are only unique inside one workspace. */
export class BuildDiagnosticsStore {
  private readonly byBuildKey = new Map<string, BuildDiagnostic[]>();
  private readonly byUnitName = new Map<string, BuildDiagnostic[]>();

  record(unitName: string, buildKey: string | null, diagnostics: BuildDiagnostic[]): void {
    this.byUnitName.set(unitName, diagnostics);
    if (buildKey) this.byBuildKey.set(buildKey, diagnostics);
    if (this.byUnitName.size > 500) {
      const first = this.byUnitName.keys().next().value;
      if (first !== undefined) this.byUnitName.delete(first);
    }
    if (this.byBuildKey.size > 1000) {
      const first = this.byBuildKey.keys().next().value;
      if (first !== undefined) this.byBuildKey.delete(first);
    }
  }

  forBuildKey(buildKey: string): BuildDiagnostic[] | null {
    return this.byBuildKey.get(buildKey) ?? null;
  }

  forUnit(unitName: string): BuildDiagnostic[] | null {
    return this.byUnitName.get(unitName) ?? null;
  }
}
