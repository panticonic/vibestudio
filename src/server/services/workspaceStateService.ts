/**
 * workspace-state — read/write surface over slot.* and entity.* on WorkspaceDO.
 *
 * Reads are bounded and addressed; no read reconstructs the full forest or history.
 * Writes are gated to the shipped shell, approved shell app, and server.
 * Panels and workers manipulate slots via runtime.*, not directly here.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { PanelSearchResult } from "@vibestudio/shared/panelSearchTypes";
import type {
  WorkspacePanelDetail,
  WorkspacePanelTreePage,
  WorkspacePanelTreePath,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeSearchPage,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import {
  WORKSPACE_STATE_READ_POLICY as READ_POLICY,
  workspaceStateMethods,
} from "@vibestudio/service-schemas/workspaceState";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { preparePanelAccessAuthority } from "./panelAccessPermission.js";

export const WORKSPACE_DO_CLASS = "WorkspaceDO";

export interface WorkspaceStateServiceDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  /**
   * Optional hook for mirroring authoritative panel titles into the
   * server-side display-title registry. Called whenever `panel.updateTitle`
   * succeeds.
   */
  onPanelTitleChanged?: (panelEntityId: string, title: string, explicit: boolean) => void;
  /**
   * Notify the server's AlarmDriver that a DO's wake schedule changed, so it
   * can re-arm its timer. Called after `alarmSet`/`alarmClear` persist.
   */
  onAlarmChanged?: () => void;
  onHeartbeatRegistryChanged?: () => void;
  /**
   * Notify listeners that a tree query cache must be invalidated after a
   * durable slot mutation, regardless of which client initiated it.
   */
  onSlotStateChanged?: () => void;
  panelAccess: PanelAccessPermissionDeps;
}

export function createWorkspaceStateService(deps: WorkspaceStateServiceDeps): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: WORKSPACE_DO_CLASS,
    objectKey: deps.workspaceId,
  };
  const dispatch = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;
  const panelTarget = async (slotId: string): Promise<PanelAccessPermissionTarget> => {
    const detail = await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [slotId]);
    if (!detail) return { id: slotId };
    return {
      id: slotId,
      title: detail.slot.current_entity_title ?? slotId,
      source: detail.currentHistory.source,
      kind: detail.currentHistory.source.startsWith("browser:") ? "browser" : "workspace",
      runtimeEntityId: detail.entity.id,
      contextId: detail.currentHistory.context_id,
    };
  };
  const preparePanelMutation = async (
    ctx: import("@vibestudio/shared/serviceDispatcher").ServiceContext,
    operation: import("@vibestudio/shared/panelAccessPolicy").PanelAccessOperation,
    slotId: string
  ) => ({
    selections: await preparePanelAccessAuthority(
      deps.panelAccess,
      ctx,
      operation,
      await panelTarget(slotId)
    ),
    payload: null,
  });

  return {
    name: "workspace-state",
    description: "Workspace slot/entity state (WorkspaceDO).",
    authority: READ_POLICY,
    methods: workspaceStateMethods,
    authorityPreparation: {
      "workspace-state.slot.create.contextBoundary": async (ctx, [input]) => {
        const createInput = input as {
          parentSlotId?: string | null;
          initialEntry?: { contextId?: string };
        };
        const parentSlotId =
          typeof createInput.parentSlotId === "string" && createInput.parentSlotId.length > 0
            ? createInput.parentSlotId
            : null;
        const target: PanelAccessPermissionTarget = parentSlotId
          ? await panelTarget(parentSlotId)
          : { id: "workspace-root" };
        const requestedContextId = createInput.initialEntry?.contextId;
        if (typeof requestedContextId === "string" && requestedContextId.length > 0) {
          target.requestedContextId = requestedContextId;
        }
        return {
          selections: await preparePanelAccessAuthority(deps.panelAccess, ctx, "openPanel", target),
          payload: null,
        };
      },
      "workspace-state.slot.commitPreparedNavigation.contextBoundary": async (ctx, [input]) => {
        const commitInput = input as {
          slotId?: string;
          mutation?: { entry?: { contextId?: string } };
        };
        if (typeof commitInput.slotId !== "string" || commitInput.slotId.length === 0) {
          return { selections: [], payload: null };
        }
        const target = await panelTarget(commitInput.slotId);
        const requestedContextId = commitInput.mutation?.entry?.contextId;
        if (typeof requestedContextId === "string" && requestedContextId.length > 0) {
          target.requestedContextId = requestedContextId;
        }
        return {
          selections: await preparePanelAccessAuthority(
            deps.panelAccess,
            ctx,
            "replacePanel",
            target
          ),
          payload: null,
        };
      },
      "workspace-state.slot.updateCurrentStateArgs.contextBoundary": (ctx, [slotId]) =>
        preparePanelMutation(ctx, "stateArgs.set", String(slotId)),
      "workspace-state.slot.move.contextBoundary": (ctx, [slotId]) =>
        preparePanelMutation(ctx, "movePanel", String(slotId)),
      "workspace-state.slot.close.contextBoundary": (ctx, [slotId]) =>
        preparePanelMutation(ctx, "close", String(slotId)),
      "workspace-state.panel.updateTitle.contextBoundary": (ctx, [slotId]) =>
        preparePanelMutation(ctx, "updatePanelState", String(slotId)),
    },
    handler: defineServiceHandler("workspace-state", workspaceStateMethods, {
      "panelTree.rootGroups": (_ctx, [input]) =>
        dispatch<WorkspacePanelTreeRootGroupPage>("panelTreeRootGroups", [input]),
      "panelTree.page": (_ctx, [input]) =>
        dispatch<WorkspacePanelTreePage>("panelTreePage", [input]),
      "panelTree.path": (_ctx, [slotId]) =>
        dispatch<WorkspacePanelTreePath | null>("panelTreePath", [slotId]),
      "panelTree.detail": (_ctx, [slotId]) =>
        dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [slotId]),
      "panelTree.search": (_ctx, [input]) =>
        dispatch<WorkspacePanelTreeSearchPage>("panelTreeSearch", [input]),
      "slot.get": (_ctx, [slotId]) => dispatch<unknown>("slotGet", [slotId]),
      "slot.historyRelative": (_ctx, [slotId, delta]) =>
        dispatch<unknown>("slotHistoryRelative", [slotId, delta]),
      "slot.historyEntry": (_ctx, [slotId, entryKey]) =>
        dispatch<unknown>("slotHistoryEntry", [slotId, entryKey]),
      "entity.resolveActive": (_ctx, [id]) =>
        dispatch<EntityRecord | null>("entityResolveActive", [id]),
      "entity.resolve": (_ctx, [id]) => dispatch<EntityRecord | null>("entityResolve", [id]),
      "slot.resolveByEntity": (_ctx, [entityId]) =>
        dispatch<string | null>("slotResolveByEntity", [entityId]),
      "slot.create": async (ctx, [input]) => {
        await dispatch<undefined>("slotCreate", [
          { ...input, ...(ctx.caller.subject ? { ownerUserId: ctx.caller.subject.userId } : {}) },
        ]);
        deps.onSlotStateChanged?.();
      },
      "slot.commitPreparedNavigation": async (_ctx, [input]) => {
        const result = await dispatch<unknown>("slotCommitPreparedNavigation", [input]);
        deps.onSlotStateChanged?.();
        return result;
      },
      "slot.updateCurrentStateArgs": async (_ctx, [slotId, stateArgs]) => {
        await dispatch<undefined>("slotUpdateCurrentStateArgs", [slotId, stateArgs]);
        deps.onSlotStateChanged?.();
      },
      "slot.move": async (ctx, [slotId, parentSlotId, placement]) => {
        // Ownership attribution comes from the verified caller, never a
        // caller-supplied fourth wire argument.
        const ownerUserId = ctx.caller.subject?.userId;
        await dispatch<undefined>("slotMove", [slotId, parentSlotId, placement, ownerUserId]);
        deps.onSlotStateChanged?.();
      },
      "slot.close": async (_ctx, [slotId]) => {
        const result = await dispatch<unknown>("slotClose", [slotId]);
        deps.onSlotStateChanged?.();
        return result;
      },
      "slot.closeCleanupPage": (_ctx, [input]) =>
        dispatch<unknown>("slotCloseCleanupPage", [input]),
      "slot.closeOwnedRoots": async (_ctx, [ownerUserId]) => {
        const result = await dispatch<unknown>("slotCloseOwnedRoots", [ownerUserId]);
        deps.onSlotStateChanged?.();
        return result;
      },
      "slot.closeCleanupAck": (_ctx, [slotIds]) =>
        dispatch<undefined>("slotCloseCleanupAck", [slotIds]),
      "panel.search": (_ctx, [query, limit]) =>
        dispatch<PanelSearchResult[]>("panelSearch", [query, limit]),
      "panel.index": async (_ctx, [input]) => {
        const entityId = await dispatch<string | null>("panelIndex", [input]);
        if (entityId && input?.title) deps.onPanelTitleChanged?.(entityId, input.title, false);
        return entityId;
      },
      "panel.updateTitle": async (_ctx, [slotId, title, options]) => {
        const entityId = await dispatch<string | null>("panelUpdateTitle", [slotId, title]);
        if (entityId) deps.onPanelTitleChanged?.(entityId, title, options?.explicit === true);
        return entityId;
      },
      "panel.incrementAccess": async (_ctx, [entityId]) => {
        await dispatch<undefined>("panelIncrementAccess", [entityId]);
      },
      "panel.rebuildIndex": async () => {
        await dispatch<undefined>("panelRebuildIndex", []);
      },
      lifecycleLeaseUpsert: async (_ctx, [input]) => {
        assertOwnLifecycleKey(_ctx.caller, input, "upsert a lifecycle lease for");
        await dispatch<undefined>("lifecycleLeaseUpsert", [input]);
      },
      lifecycleLeaseClear: async (_ctx, [input]) => {
        assertOwnLifecycleKey(_ctx.caller, input, "clear a lifecycle lease for");
        await dispatch<undefined>("lifecycleLeaseClear", [input]);
      },
      alarmSet: async (_ctx, [input]) => {
        assertOwnLifecycleKey(_ctx.caller, input, "set an alarm for");
        await dispatch<undefined>("alarmSet", [
          {
            ...input,
            ...(_ctx.caller.testPolicy ? { testPolicy: _ctx.caller.testPolicy } : {}),
          },
        ]);
        deps.onAlarmChanged?.();
      },
      alarmClear: async (_ctx, [input]) => {
        assertOwnLifecycleKey(_ctx.caller, input, "clear an alarm for");
        await dispatch<undefined>("alarmClear", [input]);
        deps.onAlarmChanged?.();
      },
      heartbeatRegister: async (_ctx, [input]) => {
        await dispatch<undefined>("heartbeatRegister", [input]);
        if (isHeartbeatCodeOwnedRegistration(input)) {
          deps.onHeartbeatRegistryChanged?.();
        }
      },
      heartbeatRemove: async (_ctx, [input]) => {
        await dispatch<undefined>("heartbeatRemove", [input]);
      },
    }),
  };
}

function assertOwnLifecycleKey(
  caller: import("@vibestudio/shared/serviceDispatcher").VerifiedCaller,
  key: { source: string; className: string; objectKey: string },
  verb: string
): void {
  if (caller.hostOriginated) return;
  const ownerId = `do:${key.source}:${key.className}:${key.objectKey}`;
  if (caller.runtime.kind !== "do" || caller.runtime.id !== ownerId) {
    throw new Error(`${caller.runtime.id} cannot ${verb} ${ownerId}`);
  }
}

function isHeartbeatCodeOwnedRegistration(input: unknown): boolean {
  return (
    !!input && typeof input === "object" && (input as { kind?: unknown }).kind === "code-owned"
  );
}
