import type { EntityRecord } from "./entitySpec.js";
import type { ExecutionAuthorityOrigin } from "@vibestudio/rpc";

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

/** Original joined result of the canonical clone operation. */
export interface ContextCloneResult {
  contextId: string;
  entities: Array<{
    sourceId: string;
    newId: string;
    kind: "worker" | "do";
    source: string;
    className?: string;
    sourceKey: string;
    newKey: string;
    targetId: string;
  }>;
  contexts: Array<{
    sourceContextId: string;
    newContextId: string;
    ownerNewContextId: string | null;
  }>;
  rewired: Array<{
    sourceEntityId: string;
    newEntityId: string;
    sourceChannelId?: string;
    newChannelId?: string;
  }>;
}
export interface ContextCloneCompletion {
  phase: "completed";
  result: ContextCloneResult;
}

/** Immutable definition owned by the root lineage reservation of one clone. */
export interface ContextCloneDefinition {
  request: { sourceContextId: string; include: string[] | null; recursive: boolean };
  author: {
    runtimeId: string;
    runtimeKind: string;
    authoritySessionId?: string;
    userId?: string;
    hostOriginated: boolean;
    executionAuthority?: ExecutionAuthorityOrigin;
  };
  contexts: Array<{
    sourceContextId: string;
    targetContextId: string;
    ownerSourceContextId?: string;
    ownerEntityId?: string | null;
  }>;
  members: Array<{ source: EntityRecord; targetId: string; targetKey: string }>;
}

/** An owner→child edge as seen from the OWNER side (listOwnedContexts). */
export interface ContextEdge {
  /** The child/dependent/descendant context. */
  contextId: string;
  kind: ContextEdgeKind;
  /** The spawning entity in the owner context (lifecycle), or null. */
  ownerEntityId: string | null;
  cloneDefinition?: ContextCloneDefinition;
  cloneCompletion?: ContextCloneCompletion;
}

/** An owner→child edge as seen from the CHILD side (walk up for authz/teardown). */
export interface ContextEdgeByChild {
  /** The parent/owner context. */
  ownerContextId: string;
  kind: ContextEdgeKind;
  ownerEntityId: string | null;
  cloneDefinition?: ContextCloneDefinition;
  cloneCompletion?: ContextCloneCompletion;
}
