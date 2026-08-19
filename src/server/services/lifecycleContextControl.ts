import type {
  ContextEdge,
  ContextEdgeByChild,
  ContextEdgeKind,
} from "@vibestudio/shared/runtime/contextEdges";

/** Durable context/entity projection needed to prove lifecycle ownership. */
export interface LifecycleContextControlStore {
  listContextEdgesByOwner(input: {
    ownerContextId: string;
    kind?: ContextEdgeKind;
  }): Promise<ContextEdge[]>;
  listContextEdgesByChild(contextId: string): Promise<ContextEdgeByChild[]>;
  resolveRecord(id: string): Promise<{ id: string; parentId?: string } | null>;
}

async function entityIsControlledByCaller(
  store: LifecycleContextControlStore,
  callerId: string,
  ownerEntityId: string
): Promise<boolean> {
  const seen = new Set<string>();
  let currentId: string | undefined = ownerEntityId;
  while (currentId && !seen.has(currentId)) {
    if (currentId === callerId) return true;
    seen.add(currentId);
    currentId = (await store.resolveRecord(currentId))?.parentId;
  }
  return false;
}

/**
 * True when `callerId` owns the lifecycle path from `originContextId` to the
 * target context.
 *
 * Lifecycle teardown treats a nested lifecycle tree as one ownership unit, so
 * context-transition authorization follows the same durable topology. Every
 * traversed context must have exactly one lifecycle parent and every edge must
 * name an entity controlled by the caller. Missing owners, branches, and cycles
 * fail closed.
 */
export async function callerControlsLifecycleContext(
  store: LifecycleContextControlStore,
  callerId: string,
  originContextId: string | null,
  targetContextId: string
): Promise<boolean> {
  if (!originContextId) return false;
  const seen = new Set([targetContextId]);
  let currentContextId = targetContextId;
  while (currentContextId !== originContextId) {
    const parents = (await store.listContextEdgesByChild(currentContextId)).filter(
      (edge) => edge.kind === "lifecycle"
    );
    if (parents.length !== 1) return false;
    const parent = parents[0]!;
    if (
      !parent.ownerEntityId ||
      !(await entityIsControlledByCaller(store, callerId, parent.ownerEntityId))
    ) {
      return false;
    }
    if (seen.has(parent.ownerContextId)) return false;
    currentContextId = parent.ownerContextId;
    seen.add(currentContextId);
  }
  return true;
}

async function entitiesShareControlLineage(
  store: LifecycleContextControlStore,
  callerId: string,
  ownerEntityId: string
): Promise<boolean> {
  const reaches = async (startId: string, targetId: string): Promise<boolean> => {
    const seen = new Set<string>();
    let currentId: string | undefined = startId;
    while (currentId && !seen.has(currentId)) {
      if (currentId === targetId) return true;
      seen.add(currentId);
      currentId = (await store.resolveRecord(currentId))?.parentId;
    }
    return false;
  };
  return (await reaches(callerId, ownerEntityId)) || (await reaches(ownerEntityId, callerId));
}

interface LineageStep {
  childContextId: string;
  ownerContextId: string;
  ownerEntityId: string | null;
}

async function lineagePathToRoot(
  store: LifecycleContextControlStore,
  startContextId: string
): Promise<{ contexts: string[]; steps: LineageStep[] } | null> {
  const contexts = [startContextId];
  const steps: LineageStep[] = [];
  const seen = new Set(contexts);
  let current = startContextId;
  for (;;) {
    const parents = (await store.listContextEdgesByChild(current)).filter(
      (edge) => edge.kind === "lineage"
    );
    if (parents.length === 0) return { contexts, steps };
    // Conversation lineage has one authoritative parent. Multiple parents or a
    // cycle are corrupt topology and must not create an authority shortcut.
    if (parents.length !== 1) return null;
    const parent = parents[0]!;
    if (seen.has(parent.ownerContextId)) return null;
    steps.push({
      childContextId: current,
      ownerContextId: parent.ownerContextId,
      ownerEntityId: parent.ownerEntityId,
    });
    current = parent.ownerContextId;
    contexts.push(current);
    seen.add(current);
  }
}

/**
 * True when a caller may move an execution surface between two contexts it
 * controls. Lifecycle descendants retain directed ownership across their
 * complete, durably owned path.
 * Conversation-lineage movement is bidirectional (parent, child, or sibling),
 * but every edge on both paths must carry an entity owner in the caller's
 * durable entity ancestry. Merely knowing a fork context id never grants it.
 */
export async function callerControlsContextTransition(
  store: LifecycleContextControlStore,
  callerId: string,
  originContextId: string | null,
  targetContextId: string
): Promise<boolean> {
  if (!originContextId) return false;
  if (originContextId === targetContextId) return true;
  if (await callerControlsLifecycleContext(store, callerId, originContextId, targetContextId)) {
    return true;
  }

  const [originPath, targetPath] = await Promise.all([
    lineagePathToRoot(store, originContextId),
    lineagePathToRoot(store, targetContextId),
  ]);
  if (!originPath || !targetPath) return false;
  const targetContexts = new Set(targetPath.contexts);
  const commonContext = originPath.contexts.find((contextId) => targetContexts.has(contextId));
  if (!commonContext) return false;

  const stepsTo = (path: { steps: LineageStep[] }, contextId: string): LineageStep[] => {
    const index = path.steps.findIndex((step) => step.ownerContextId === contextId);
    return index < 0 ? [] : path.steps.slice(0, index + 1);
  };
  const traversed = [...stepsTo(originPath, commonContext), ...stepsTo(targetPath, commonContext)];
  if (traversed.length === 0) return false;
  for (const step of traversed) {
    if (
      !step.ownerEntityId ||
      !(await entitiesShareControlLineage(store, callerId, step.ownerEntityId))
    ) {
      return false;
    }
  }
  return true;
}
