export type RuntimeSurfaceTarget = "panel" | "workerRuntime";

export interface RuntimeSurfaceEntry {
  kind: "value" | "namespace";
  description?: string;
  members?: string[];
  /**
   * Optional link to the RPC service whose typed method schemas back this
   * runtime export (e.g. the `gad` runtime namespace → the `gad` service). Lets
   * the capability catalog attach typed args/returns to an otherwise name-only
   * runtime surface. Best-effort: most runtime exports have no Zod counterpart.
   */
  schemaRef?: string;
}

export interface RuntimeSurface {
  target: RuntimeSurfaceTarget;
  description: string;
  exports: Record<string, RuntimeSurfaceEntry>;
}

export function valueEntry(description?: string, schemaRef?: string): RuntimeSurfaceEntry {
  return {
    kind: "value",
    ...(description ? { description } : {}),
    ...(schemaRef ? { schemaRef } : {}),
  };
}

export function namespaceEntry(
  members: string[],
  description?: string,
  schemaRef?: string
): RuntimeSurfaceEntry {
  return {
    kind: "namespace",
    members,
    ...(description ? { description } : {}),
    ...(schemaRef ? { schemaRef } : {}),
  };
}
