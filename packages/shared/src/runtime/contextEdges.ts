/**
 * Context-relationship registry types (shared).
 *
 * Contexts form two distinct relationship graphs, stored as durable edges in the
 * WorkspaceDO `context_edges` table and surfaced through `runtime.*`:
 *
 *  - "lifecycle" — a subagent's context OWNED BY its parent. CASCADED on
 *    `destroyContext({recursive})` and CLONED on `cloneContext({recursive})`.
 *  - "lineage"   — a conversation fork's provenance link to the context it was
 *    forked from. Access/provenance ONLY: NEVER cascaded on destroy, NEVER
 *    followed when cloning a lifecycle subtree.
 *
 * The two kinds are keyed distinctly (a context may carry both a lineage edge —
 * "forked from X" — and lifecycle edges from other owners), and every traversal
 * MUST scope to a single kind: cascade follows `lifecycle` exclusively.
 */
export type ContextEdgeKind = "lifecycle" | "lineage";

/** An owner→child edge as seen from the OWNER side (listOwnedContexts). */
export interface ContextEdge {
  /** The child/dependent/descendant context. */
  contextId: string;
  kind: ContextEdgeKind;
  /** The spawning entity in the owner context (lifecycle), or null. */
  ownerEntityId: string | null;
}

/** An owner→child edge as seen from the CHILD side (walk up for authz/teardown). */
export interface ContextEdgeByChild {
  /** The parent/owner context. */
  ownerContextId: string;
  kind: ContextEdgeKind;
  ownerEntityId: string | null;
}
