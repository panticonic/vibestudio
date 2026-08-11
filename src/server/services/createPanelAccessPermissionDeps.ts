import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AppHost } from "../appHost.js";
import type { ContextBoundaryDeps } from "./contextBoundary.js";
import type { PanelAccessPermissionDeps } from "./panelAccessPermission.js";
import {
  callerControlsContextTransition,
  type LifecycleContextControlStore,
} from "./lifecycleContextControl.js";

export function createPanelAccessPermissionDeps(input: {
  contextBoundary: ContextBoundaryDeps;
  entityCache: EntityCache;
  lifecycleContextStore: LifecycleContextControlStore;
  getAppHost(): AppHost | null;
}): PanelAccessPermissionDeps {
  const { contextBoundary, entityCache } = input;
  return {
    ...contextBoundary,
    resolveCallerContext: async (callerId) => entityCache.resolveContext(callerId),
    resolveEntityContext: (entityId) => entityCache.resolveContext(entityId),
    isEntityControlledBy: (entityId, callerId) => {
      const visited = new Set<string>();
      let current = entityCache.resolve(entityId);
      while (current && !visited.has(current.id)) {
        if (current.parentId === callerId) return true;
        visited.add(current.id);
        current = current.parentId ? entityCache.resolve(current.parentId) : null;
      }
      return false;
    },
    controlsLifecycleContext: (
      callerId: string,
      originContextId: string | null,
      targetContextId: string
    ) =>
      callerControlsContextTransition(
        input.lifecycleContextStore,
        callerId,
        originContextId,
        targetContextId
      ),
    resolveSubjectCaller: (entityId) => {
      const record = entityCache.resolveActive(entityId);
      const kind = record?.kind;
      if (
        !record ||
        (kind !== "panel" && kind !== "app" && kind !== "worker" && kind !== "do") ||
        !record.activeExecutionDigest ||
        !record.activeAuthority
      ) {
        return null;
      }
      return createVerifiedCaller(record.id, kind, {
        callerId: record.id,
        callerKind: kind,
        repoPath: record.source.repoPath,
        effectiveVersion: record.source.effectiveVersion,
        executionDigest: record.activeExecutionDigest,
        requested: record.activeAuthority.requests,
      });
    },
    hasAppCapability: (callerId, capability) =>
      input.getAppHost()?.hasAppCapability(callerId, capability) ?? false,
  };
}
