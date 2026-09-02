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
import type { PanelSearchResult, PanelSourceUsage } from "@vibestudio/shared/panelSearchTypes";
import type {
  WorkspacePanelCloseCleanupPage,
  WorkspacePanelDetail,
  WorkspacePanelTreePage,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeSearchPage,
  WorkspacePanelTopologyPage,
  WorkspacePanelTopologyPath,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type { PanelTreeNode, PanelTreePlacementHint } from "@vibestudio/shared/panel/treeIndex";
import {
  WORKSPACE_STATE_READ_POLICY as READ_POLICY,
  workspaceStateMethods,
} from "@vibestudio/service-schemas/workspaceState";
import type {
  SlotCommitPreparedNavigationInput,
  SlotCommitPreparedNavigationResult,
} from "@vibestudio/service-schemas/workspaceState";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { preparePanelAccessAuthority } from "./panelAccessPermission.js";
import { verifiedInitiatingUserId } from "@vibestudio/shared/serviceDispatcher";

export const WORKSPACE_DO_CLASS = "WorkspaceDO";

export type SlotStateChange =
  | {
      kind: "current-entity";
      slotId: string;
      previousEntityId: string | null;
      currentEntityId: string;
      presentation: "awaiting-execution" | "executable";
      /**
       * Exact durable execution intent committed by this mutation. Keeping the
       * in-process handoff alongside the invalidation lets the execution owner
       * start immediately without reading the same WorkspaceDO rows back
       * through a contended control-plane queue. Recovery remains level-
       * triggered from durable state when no handoff is available.
       */
      desiredExecution?: {
        source: string;
        key: string;
        contextId: string;
        stateArgs: unknown;
        ref?: string;
        artifact?: { buildKey: string; executionDigest: string };
      };
    }
  | { kind: "tree" }
  | { kind: "closed"; slotIds: string[] };

export interface WorkspaceStateServiceDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  /** Mechanical transport to Base's single workspace-presentation owner. */
  presentationDispatch(method: string, args: unknown[]): Promise<unknown>;
  /** Resolve compact unit decoration from the exact source coordinate in panel history. */
  /**
   * Notify the server's AlarmDriver that a DO's wake schedule changed, so it
   * can re-arm its timer. Called after `alarmSet`/`alarmClear` persist.
   */
  onAlarmChanged?: () => void;
  /**
   * Notify listeners that a tree query cache must be invalidated after a
   * durable slot mutation, regardless of which client initiated it.
   */
  onSlotStateChanged?: (change?: SlotStateChange) => void;
  /**
   * Publish changes to derived panel presentation without pretending that the
   * durable slot topology advanced. Presentation has its own monotonic event
   * revision and is refreshed by panel id on every connected client.
   */
  onPresentationChanged?: (panelIds: string[]) => void;
  /** Refresh the host's synchronous security-attribution projection after Base commits a title. */
  onEntityTitleChanged?: (entityId: string, title: string | undefined) => void;
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
  type RawTreeNode = WorkspacePanelTopologyPage["nodes"][number];
  type RawTreePage = WorkspacePanelTopologyPage;
  type RawTreePath = WorkspacePanelTopologyPath;
  const presentationOptions = (
    serialized: string | null | undefined
  ): { ref?: string | null; placement?: PanelTreePlacementHint } => {
    if (serialized == null || serialized === "") return {};
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw new Error("Workspace panel options are not valid current JSON", { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Workspace panel options must be a current JSON object");
    }
    const record = value as Record<string, unknown>;
    const result: { ref?: string | null; placement?: PanelTreePlacementHint } = {};
    if (Object.hasOwn(record, "ref")) {
      if (typeof record["ref"] !== "string" && record["ref"] !== null) {
        throw new Error("Workspace panel options.ref must be a string or null");
      }
      result.ref = record["ref"] as string | null;
    }
    if (!Object.hasOwn(record, "placement")) return result;
    const raw = record["placement"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Workspace panel options.placement must be an object");
    }
    const placementRecord = raw as Record<string, unknown>;
    const allowed = new Set(["disposition", "preferredWidth", "minWidth"]);
    const unknownKey = Object.keys(placementRecord).find((key) => !allowed.has(key));
    if (unknownKey) {
      throw new Error(`Workspace panel options.placement has unknown key ${unknownKey}`);
    }
    const placement: PanelTreePlacementHint = {};
    const dispositions = new Set(["side", "side-if-room", "replace", "split-below"]);
    if (Object.hasOwn(placementRecord, "disposition")) {
      const disposition = placementRecord["disposition"];
      if (typeof disposition !== "string" || !dispositions.has(disposition)) {
        throw new Error("Workspace panel options.placement.disposition is invalid");
      }
      placement.disposition = disposition as NonNullable<PanelTreePlacementHint["disposition"]>;
    }
    for (const key of ["preferredWidth", "minWidth"] as const) {
      if (!Object.hasOwn(placementRecord, key)) continue;
      const width = placementRecord[key];
      if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
        throw new Error(`Workspace panel options.placement.${key} must be a positive number`);
      }
      placement[key] = width;
    }
    result.placement = placement;
    return result;
  };
  // Titles and search metadata are a Base-owned projection of durable slot
  // state. They must never become a prerequisite for reading topology or
  // starting an execution. Keep the most recent projection in-process, seed it
  // from mutations that already carry a title, and repair cache misses in the
  // background. A cold/missing projection renders the source as its honest
  // fallback and invalidates the tree once the richer title arrives.
  const titleCache = new Map<string, string>();
  const titleRefreshes = new Map<string, Promise<void>>();
  const reportProjectionFailure = (operation: string, error: unknown) => {
    console.warn(
      `[workspace-state] Presentation projection ${operation} failed; durable slot state remains authoritative: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  };
  const observeTitle = (slotId: string, title: unknown): boolean => {
    if (typeof title !== "string" || title.trim().length === 0) return false;
    const normalized = title.trim();
    if (titleCache.get(slotId) === normalized) return false;
    titleCache.set(slotId, normalized);
    return true;
  };
  const refreshTitles = (slotIds: string[]): void => {
    const missing = [...new Set(slotIds)].filter(
      (slotId) => !titleCache.has(slotId) && !titleRefreshes.has(slotId)
    );
    if (missing.length === 0) return;
    const refresh = (
      deps.presentationDispatch("titlesForSlots", [missing]) as Promise<Record<string, string>>
    )
      .then((titles) => {
        const changed = missing.filter((slotId) => observeTitle(slotId, titles[slotId]));
        if (changed.length > 0) deps.onPresentationChanged?.(changed);
      })
      .catch((error) => reportProjectionFailure("title refresh", error))
      .finally(() => {
        for (const slotId of missing) {
          if (titleRefreshes.get(slotId) === refresh) titleRefreshes.delete(slotId);
        }
      });
    for (const slotId of missing) titleRefreshes.set(slotId, refresh);
  };
  const cachedTitlesForSlots = (slotIds: string[]): Record<string, string> => {
    refreshTitles(slotIds);
    return Object.fromEntries(
      slotIds.flatMap((slotId) => {
        const title = titleCache.get(slotId);
        return title ? [[slotId, title] as const] : [];
      })
    );
  };
  const project = (operation: string, method: string, args: unknown[]): void => {
    void deps
      .presentationDispatch(method, args)
      .catch((error) => reportProjectionFailure(operation, error));
  };
  const presentNodes = async (nodes: RawTreeNode[]): Promise<PanelTreeNode[]> => {
    const titles = cachedTitlesForSlots(nodes.map((node) => node.slotId));
    return nodes.map(({ options, ...node }) => {
      const parsedOptions = presentationOptions(options);
      return {
        ...node,
        // A slot id is an address, not a name. Slots created before titles were
        // recorded with the binding, and any node whose title write is still in
        // flight, fall back to the source they present — never to their id.
        title: titles[node.slotId] ?? node.source ?? node.slotId,
        ...(node.source
          ? {
              kind: node.source.startsWith("browser:")
                ? ("browser" as const)
                : ("workspace" as const),
            }
          : {}),
        ...parsedOptions,
      };
    });
  };
  const presentPage = async (page: RawTreePage): Promise<WorkspacePanelTreePage> => ({
    ...page,
    nodes: await presentNodes(page.nodes),
  });
  const presentDetail = async (
    detail: WorkspacePanelDetail | null
  ): Promise<WorkspacePanelDetail | null> => {
    if (!detail) return null;
    const titles = cachedTitlesForSlots([detail.slot.slot_id]);
    return {
      ...detail,
      slot: {
        ...detail.slot,
        current_entity_title:
          titles[detail.slot.slot_id] ?? detail.currentHistory.source ?? detail.slot.slot_id,
      },
    };
  };
  const panelTarget = async (slotId: string): Promise<PanelAccessPermissionTarget> => {
    const detail = await presentDetail(
      await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [slotId])
    );
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
      "workspace-state.slot.updateCurrentStateArgs.contextBoundary": (ctx, [slotId]) =>
        preparePanelMutation(ctx, "stateArgs.set", String(slotId)),
      "workspace-state.slot.commitPreparedNavigation.contextBoundary": async (ctx, [input]) => {
        const navigation = input as SlotCommitPreparedNavigationInput;
        const target = await panelTarget(navigation.slotId);
        if (navigation.mutation.kind !== "select") {
          target.requestedContextId = navigation.mutation.entry.contextId;
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
      "panelTree.rootsForCaller": async (ctx, [input]) =>
        presentPage(
          await dispatch<RawTreePage>("panelTreePage", [
            {
              group: {
                kind: "roots",
                ownerUserId: verifiedInitiatingUserId(ctx) ?? null,
              },
              ...input,
            },
          ])
        ),
      "panelTree.page": async (_ctx, [input]) =>
        presentPage(await dispatch<RawTreePage>("panelTreePage", [input])),
      "panelTree.path": async (_ctx, [slotId]) => {
        const value = await dispatch<RawTreePath | null>("panelTreePath", [slotId]);
        return value ? { ...value, nodes: await presentNodes(value.nodes) } : null;
      },
      "panelTree.detail": async (_ctx, [slotId]) =>
        presentDetail(await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [slotId])),
      "panelTree.search": async (_ctx, [input]) => {
        const search = (await deps.presentationDispatch("search", [
          input.query,
          input.limit,
          input.cursor,
        ])) as { results: PanelSearchResult[]; nextCursor: string | null };
        let revision = 0;
        const hits: WorkspacePanelTreeSearchPage["hits"] = [];
        for (const result of search.results) {
          const value = await dispatch<RawTreePath | null>("panelTreePath", [result.id]);
          if (!value) continue;
          revision = value.revision;
          const nodes = await presentNodes(value.nodes);
          const node = nodes.at(-1);
          if (!node) continue;
          const ancestorCount = Math.max(0, nodes.length - 1);
          const ancestors = nodes.slice(Math.max(0, ancestorCount - 12), -1);
          hits.push({
            node,
            ancestors,
            ...(ancestorCount > ancestors.length ? { ancestorsTruncated: true } : {}),
          });
        }
        return { revision, hits, nextCursor: search.nextCursor };
      },
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
        const ownerUserId = verifiedInitiatingUserId(ctx);
        // `title` is presentation, not slot state: it travels with the binding
        // below and never reaches the state engine.
        const { title, ...slotInput } = input;
        await dispatch<undefined>("slotCreate", [
          { ...slotInput, ...(ownerUserId ? { ownerUserId } : {}) },
        ]);
        if (input.title) observeTitle(input.slotId, input.title);
        // The reservation and slot binding above are the durable execution
        // fact. Publish it before touching the optional presentation index so
        // a cold Base DO can never hold first paint or runtime activation.
        deps.onSlotStateChanged?.(
          input.initialEntry
            ? {
                kind: "current-entity",
                slotId: input.slotId,
                previousEntityId: null,
                currentEntityId: input.initialEntry.entityId,
                presentation: String(input.initialEntry.source).startsWith("browser:")
                  ? "executable"
                  : "awaiting-execution",
                ...(!String(input.initialEntry.source).startsWith("browser:")
                  ? {
                      desiredExecution: {
                        source: input.initialEntry.source,
                        key: input.initialEntry.entryKey,
                        contextId: input.initialEntry.contextId,
                        stateArgs: input.initialEntry.stateArgs ?? {},
                        ...(typeof input.initialEntry.options?.ref === "string" &&
                        input.initialEntry.options.ref.length > 0
                          ? { ref: input.initialEntry.options.ref }
                          : {}),
                        ...(input.initialEntry.options?.artifact
                          ? { artifact: input.initialEntry.options.artifact }
                          : {}),
                      },
                    }
                  : {}),
              }
            : { kind: "tree" }
        );
        if (input.initialEntry) {
          project("slot bind", "bindSlot", [
            input.slotId,
            input.initialEntry.entityId,
            input.initialEntry.source,
            title ?? null,
          ]);
          if (title) deps.onEntityTitleChanged?.(input.initialEntry.entityId, title);
        }
      },
      "slot.commitPreparedNavigation": async (_ctx, [input]) => {
        // As on `slot.create`, `title` is presentation and travels with the
        // binding rather than the history mutation.
        const { title, ...navigation } = input;
        const result = await dispatch<SlotCommitPreparedNavigationResult>(
          "slotCommitPreparedNavigation",
          [navigation]
        );
        const detail = await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [
          input.slotId,
        ]);
        if (input.title) observeTitle(input.slotId, input.title);
        deps.onSlotStateChanged?.({
          kind: "current-entity",
          slotId: input.slotId,
          previousEntityId: result.previousEntityId,
          currentEntityId: result.currentEntityId,
          presentation: "executable",
        });
        if (detail) {
          project("navigation bind", "bindSlot", [
            input.slotId,
            detail.entity.id,
            detail.currentHistory.source,
            title ?? null,
          ]);
          if (title) deps.onEntityTitleChanged?.(detail.entity.id, title);
        }
        return result;
      },
      "slot.updateCurrentStateArgs": async (_ctx, [slotId, stateArgs]) => {
        await dispatch<undefined>("slotUpdateCurrentStateArgs", [slotId, stateArgs]);
        deps.onSlotStateChanged?.();
      },
      "slot.move": async (ctx, [slotId, parentSlotId, placement]) => {
        // Ownership attribution comes from the verified caller, never a
        // caller-supplied fourth wire argument.
        const ownerUserId = verifiedInitiatingUserId(ctx);
        await dispatch<undefined>("slotMove", [slotId, parentSlotId, placement, ownerUserId]);
        deps.onSlotStateChanged?.();
      },
      "slot.close": async (_ctx, [slotId]) => {
        const result = await dispatch<{ closeId: string; closedCount: number }>("slotClose", [
          slotId,
        ]);
        const removed: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await dispatch<WorkspacePanelCloseCleanupPage>("slotCloseCleanupPage", [
            { closeId: result.closeId, cursor, limit: 200 },
          ]);
          removed.push(...page.items.map((item) => item.slotId));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (removed.length > 0) {
          for (const slotId of removed) titleCache.delete(slotId);
          project("closed-slot removal", "removeSlots", [removed]);
        }
        deps.onSlotStateChanged?.({ kind: "closed", slotIds: removed });
        return result;
      },
      "slot.closeCleanupPage": (_ctx, [input]) =>
        dispatch<unknown>("slotCloseCleanupPage", [input]),
      "slot.closeOwnedRoots": async (_ctx, [ownerUserId]) => {
        const result = await dispatch<{ rootIds: string[]; closedIds: string[] }>(
          "slotCloseOwnedRoots",
          [ownerUserId]
        );
        if (result.closedIds.length > 0) {
          for (const slotId of result.closedIds) titleCache.delete(slotId);
          project("closed-slot removal", "removeSlots", [result.closedIds]);
        }
        deps.onSlotStateChanged?.({ kind: "closed", slotIds: result.closedIds });
        return result;
      },
      "slot.closeCleanupAck": (_ctx, [slotIds]) =>
        dispatch<undefined>("slotCloseCleanupAck", [slotIds]),
      "panel.search": (_ctx, [query, limit]) =>
        deps
          .presentationDispatch("search", [query, limit])
          .then((value) => (value as { results: PanelSearchResult[] }).results),
      "panel.sourceUsage": (_ctx, [limit]) =>
        deps.presentationDispatch("sourceUsage", [limit]) as Promise<PanelSourceUsage[]>,
      "panel.index": async (_ctx, [input]) => {
        const detail = await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [input.id]);
        if (!detail) return null;
        const entityId = detail.entity.id;
        const explicit = (await deps.presentationDispatch("isEntityTitleExplicit", [
          entityId,
        ])) as boolean;
        const titles = explicit
          ? ((await deps.presentationDispatch("titlesForSlots", [[input.id]])) as Record<
              string,
              string
            >)
          : {};
        const effectiveTitle = explicit && titles[input.id] ? titles[input.id] : input.title;
        await deps.presentationDispatch("indexPanel", [
          {
            ...input,
            source: detail.currentHistory.source,
            ...(effectiveTitle ? { title: effectiveTitle } : {}),
          },
          entityId,
        ]);
        // indexPanel deliberately preserves a newer inferred runtime title.
        // Seed a cold cache from the index input, but never let a later index
        // pass overwrite a title already observed from the running document.
        const titleChanged = explicit
          ? observeTitle(input.id, effectiveTitle)
          : !titleCache.has(input.id) && observeTitle(input.id, effectiveTitle);
        if (titleChanged) deps.onPresentationChanged?.([input.id]);
        if (effectiveTitle) deps.onEntityTitleChanged?.(entityId, effectiveTitle);
        return entityId;
      },
      "panel.updateTitle": async (_ctx, [slotId, title, options]) => {
        const detail = await dispatch<WorkspacePanelDetail | null>("panelTreeDetail", [slotId]);
        const entityId = detail?.entity.id ?? null;
        if (!entityId) return null;
        if (!options?.explicit) {
          const explicit = (await deps.presentationDispatch("isEntityTitleExplicit", [
            entityId,
          ])) as boolean;
          if (explicit) return entityId;
        }
        const normalizedTitle = typeof title === "string" && title.trim() ? title.trim() : null;
        await deps.presentationDispatch("updatePanelTitle", [
          slotId,
          entityId,
          normalizedTitle,
          options,
        ]);
        const titleChanged = normalizedTitle
          ? observeTitle(slotId, normalizedTitle)
          : titleCache.delete(slotId);
        if (titleChanged) deps.onPresentationChanged?.([slotId]);
        deps.onEntityTitleChanged?.(entityId, normalizedTitle ?? undefined);
        return entityId;
      },
      "panel.incrementAccess": async (_ctx, [slotId]) => {
        await deps.presentationDispatch("incrementAccess", [slotId]);
      },
      "panel.rebuildIndex": async () => {
        await deps.presentationDispatch("rebuildIndex", []);
        deps.onSlotStateChanged?.({ kind: "tree" });
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
