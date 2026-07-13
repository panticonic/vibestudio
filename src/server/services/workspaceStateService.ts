/**
 * workspace-state — read/write surface over slot.* and entity.* on WorkspaceDO.
 *
 * Replaces the old workspace-sync op-log service. Reads (slot.list/get/history,
 * entity.resolveActive) are open to all runtime kinds; writes (slot create /
 * appendHistory / setCurrent / replaceHistory / setParent / close) are gated to
 * the shipped shell, approved shell app, and server. Panels and workers
 * manipulate slots via runtime.*, not directly here.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { PanelSearchResult } from "@vibestudio/shared/panelSearchTypes";
import {
  WORKSPACE_STATE_READ_POLICY as READ_POLICY,
  workspaceStateMethods,
} from "@vibestudio/service-schemas/workspaceState";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

export const WORKSPACE_DO_CLASS = "WorkspaceDO";

export interface WorkspaceStateServiceDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  /**
   * Optional hook for mirroring authoritative panel titles into the
   * server-side display-title registry. Called whenever `panel.updateTitle`
   * succeeds.
   */
  onPanelTitleChanged?: (panelEntityId: string, title: string) => void;
  /**
   * Notify the server's AlarmDriver that a DO's wake schedule changed, so it
   * can re-arm its timer. Called after `alarmSet`/`alarmClear` persist.
   */
  onAlarmChanged?: () => void;
  onHeartbeatRegistryChanged?: () => void;
  /**
   * Notify listeners that the panel slot/history tree changed (create, navigate,
   * move, close, …) so the server's in-memory panel-tree mirror can re-sync and
   * re-broadcast. Fires after any mutating `slot.*` method persists — regardless
   * of which client initiated it — which is what keeps every client's mirror
   * consistent with the authoritative WorkspaceDO.
   */
  onSlotStateChanged?: () => void;
}

export function createWorkspaceStateService(deps: WorkspaceStateServiceDeps): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: WORKSPACE_DO_CLASS,
    objectKey: deps.workspaceId,
  };
  const dispatch = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;

  return {
    name: "workspace-state",
    description: "Workspace slot/entity state (WorkspaceDO).",
    policy: READ_POLICY,
    methods: workspaceStateMethods,
    handler: defineServiceHandler("workspace-state", workspaceStateMethods, {
      "slot.list": () => dispatch<unknown>("slotListOpen", []),
      "slot.get": (_ctx, [slotId]) => dispatch<unknown>("slotGet", [slotId]),
      "slot.history": (_ctx, [slotId]) => dispatch<unknown>("slotHistory", [slotId]),
      "entity.resolveActive": (_ctx, [id]) =>
        dispatch<EntityRecord | null>("entityResolveActive", [id]),
      "slot.resolveByEntity": (_ctx, [entityId]) =>
        dispatch<string | null>("slotResolveByEntity", [entityId]),
      "slot.create": async (ctx, [input]) => {
        await dispatch<undefined>("slotCreate", [
          { ...input, ...(ctx.caller.subject ? { ownerUserId: ctx.caller.subject.userId } : {}) },
        ]);
        deps.onSlotStateChanged?.();
      },
      "slot.appendHistory": async (_ctx, [slotId, entry]) => {
        const result = await dispatch<number>("slotAppendHistory", [slotId, entry]);
        deps.onSlotStateChanged?.();
        return result;
      },
      "slot.setCurrent": async (_ctx, [slotId, entryKey]) => {
        await dispatch<undefined>("slotSetCurrent", [slotId, entryKey]);
        deps.onSlotStateChanged?.();
      },
      "slot.updateCurrentStateArgs": async (_ctx, [slotId, stateArgs]) => {
        await dispatch<undefined>("slotUpdateCurrentStateArgs", [slotId, stateArgs]);
        deps.onSlotStateChanged?.();
      },
      "slot.replaceHistory": async (_ctx, [slotId, entries, cursor]) => {
        await dispatch<undefined>("slotReplaceHistory", [slotId, entries, cursor]);
        deps.onSlotStateChanged?.();
      },
      "slot.setParent": async (_ctx, [slotId, parentSlotId]) => {
        await dispatch<undefined>("slotSetParent", [slotId, parentSlotId]);
        deps.onSlotStateChanged?.();
      },
      "slot.setPosition": async (_ctx, [slotId, positionId]) => {
        await dispatch<undefined>("slotSetPosition", [slotId, positionId]);
        deps.onSlotStateChanged?.();
      },
      "slot.move": async (ctx, [slotId, parentSlotId, positionId]) => {
        // Ownership attribution comes from the verified caller, never a
        // caller-supplied fourth wire argument.
        const ownerUserId = ctx.caller.subject?.userId;
        await dispatch<undefined>("slotMove", [slotId, parentSlotId, positionId, ownerUserId]);
        deps.onSlotStateChanged?.();
      },
      "slot.close": async (_ctx, [slotId]) => {
        await dispatch<undefined>("slotClose", [slotId]);
        deps.onSlotStateChanged?.();
      },
      "panel.search": (_ctx, [query, limit]) =>
        dispatch<PanelSearchResult[]>("panelSearch", [query, limit]),
      "panel.index": async (_ctx, [input]) => {
        // The DO returns the slot's current entity id when it stamped a
        // title onto entities.display_title — we pass that on (rather than
        // the slot id) so cache mirrors stay keyed correctly.
        const entityId = await dispatch<string | null>("panelIndex", [input]);
        if (entityId && input?.title) {
          deps.onPanelTitleChanged?.(entityId, input.title);
        }
      },
      "panel.updateTitle": async (_ctx, [slotId, title]) => {
        const entityId = await dispatch<string | null>("panelUpdateTitle", [slotId, title]);
        if (entityId) {
          deps.onPanelTitleChanged?.(entityId, title);
        }
      },
      "panel.incrementAccess": async (_ctx, [entityId]) => {
        await dispatch<undefined>("panelIncrementAccess", [entityId]);
      },
      "panel.rebuildIndex": async () => {
        await dispatch<undefined>("panelRebuildIndex", []);
      },
      lifecycleLeaseUpsert: async (_ctx, [input]) => {
        await dispatch<undefined>("lifecycleLeaseUpsert", [input]);
      },
      lifecycleLeaseClear: async (_ctx, [input]) => {
        await dispatch<undefined>("lifecycleLeaseClear", [input]);
      },
      alarmSet: async (_ctx, [input]) => {
        await dispatch<undefined>("alarmSet", [input]);
        deps.onAlarmChanged?.();
      },
      alarmClear: async (_ctx, [input]) => {
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

function isHeartbeatCodeOwnedRegistration(input: unknown): boolean {
  return (
    !!input && typeof input === "object" && (input as { kind?: unknown }).kind === "code-owned"
  );
}
