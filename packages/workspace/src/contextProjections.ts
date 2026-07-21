import * as path from "node:path";

/**
 * Disposable context projections use an independent cache namespace. A
 * marker/projection protocol change advances this namespace; prior roots are
 * unreachable derived state, not authoritative data requiring migration.
 */
export const CONTEXT_PROJECTION_EPOCH = 6 as const;
export const CONTEXT_PROJECTION_NAMESPACE = `v${CONTEXT_PROJECTION_EPOCH}` as const;

export function contextProjectionsBasePath(statePath: string): string {
  return path.join(statePath, ".context-projections");
}

export function currentContextProjectionsPath(statePath: string): string {
  return path.join(contextProjectionsBasePath(statePath), CONTEXT_PROJECTION_NAMESPACE);
}
