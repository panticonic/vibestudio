import type { ContextEdge, ContextEdgeKind } from "@vibestudio/shared/runtime/contextEdges";

/** Durable context/entity projection needed to prove lifecycle ownership. */
export interface LifecycleContextControlStore {
  listContextEdgesByOwner(input: {
    ownerContextId: string;
    kind?: ContextEdgeKind;
  }): Promise<ContextEdge[]>;
  resolveRecord(id: string): Promise<{ id: string; parentId?: string } | null>;
}

/**
 * True when `callerId` owns one exact direct lifecycle child context.
 *
 * The edge may name the caller itself or an entity directly created by it.
 * Lineage edges and transitive context descendants deliberately do not count.
 */
export async function callerControlsLifecycleContext(
  store: LifecycleContextControlStore,
  callerId: string,
  originContextId: string | null,
  targetContextId: string
): Promise<boolean> {
  if (!originContextId) return false;
  const edges = await store.listContextEdgesByOwner({
    ownerContextId: originContextId,
    kind: "lifecycle",
  });
  const edge = edges.find((candidate) => candidate.contextId === targetContextId);
  if (!edge?.ownerEntityId) return false;
  if (edge.ownerEntityId === callerId) return true;
  const owner = await store.resolveRecord(edge.ownerEntityId);
  return owner?.parentId === callerId;
}
