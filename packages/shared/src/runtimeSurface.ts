export type RuntimeSurfaceTarget = "panel" | "workerRuntime";

/** Serializable method documentation generated from a runtime package's
 * canonical Zod contract. Keeping this as data lets the host catalog expose
 * full child-method docs without importing or executing userland code. */
export interface RuntimeSurfaceMethodDoc {
  signature?: string;
  description?: string;
  access?: Record<string, unknown>;
  argsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  examples?: Array<{ args: unknown[]; returns?: unknown }>;
}

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
  /** Pre-serialized public member schemas for runtime-owned APIs whose source
   * contract lives above the host/shared dependency boundary. */
  methodCatalog?: Record<string, RuntimeSurfaceMethodDoc>;
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
  schemaRef?: string,
  methodCatalog?: Record<string, RuntimeSurfaceMethodDoc>
): RuntimeSurfaceEntry {
  return {
    kind: "namespace",
    members,
    ...(description ? { description } : {}),
    ...(schemaRef ? { schemaRef } : {}),
    ...(methodCatalog ? { methodCatalog } : {}),
  };
}
