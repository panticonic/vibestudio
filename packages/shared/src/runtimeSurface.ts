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

interface RuntimeSurfaceEntryBase {
  description?: string;
}

/** An opaque runtime value whose contract is owned by the runtime package. */
export interface RuntimeSurfaceValueEntry extends RuntimeSurfaceEntryBase {
  kind: "value";
  /** Source-level signature for runtime-owned functions without an RPC schema. */
  signature?: string;
  schemaRef?: never;
  schemaMethod?: never;
  members?: never;
  methodCatalog?: never;
}

/** A direct callable whose complete contract comes from one service method. */
export interface RuntimeSurfaceCallableEntry extends RuntimeSurfaceEntryBase {
  kind: "callable";
  schemaRef: string;
  schemaMethod: string;
  members?: never;
  methodCatalog?: never;
}

export interface RuntimeSurfaceNamespaceEntry extends RuntimeSurfaceEntryBase {
  kind: "namespace";
  members: string[];
  /**
   * Optional link to the RPC service whose typed method schemas back this
   * runtime export (e.g. the `gad` runtime namespace → the `gad` service). Lets
   * the capability catalog attach typed args/returns to an otherwise name-only
   * runtime surface. Best-effort: most runtime exports have no Zod counterpart.
   */
  schemaRef?: string;
  schemaMethod?: never;
  /** Pre-serialized public member schemas for runtime-owned APIs whose source
   * contract lives above the host/shared dependency boundary. */
  methodCatalog?: Record<string, RuntimeSurfaceMethodDoc>;
}

export type RuntimeSurfaceEntry =
  | RuntimeSurfaceValueEntry
  | RuntimeSurfaceCallableEntry
  | RuntimeSurfaceNamespaceEntry;

export interface RuntimeSurface {
  target: RuntimeSurfaceTarget;
  description: string;
  exports: Record<string, RuntimeSurfaceEntry>;
}

export function valueEntry(description?: string, signature?: string): RuntimeSurfaceValueEntry {
  return {
    kind: "value",
    ...(description ? { description } : {}),
    ...(signature ? { signature } : {}),
  };
}

export function callableEntry(
  schemaRef: string,
  schemaMethod: string,
  description?: string
): RuntimeSurfaceCallableEntry {
  return {
    kind: "callable",
    schemaRef,
    schemaMethod,
    ...(description ? { description } : {}),
  };
}

export function namespaceEntry(
  members: string[],
  description?: string,
  schemaRef?: string,
  methodCatalog?: Record<string, RuntimeSurfaceMethodDoc>
): RuntimeSurfaceNamespaceEntry {
  return {
    kind: "namespace",
    members,
    ...(description ? { description } : {}),
    ...(schemaRef ? { schemaRef } : {}),
    ...(methodCatalog ? { methodCatalog } : {}),
  };
}
