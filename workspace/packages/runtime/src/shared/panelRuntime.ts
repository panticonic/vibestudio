import type { RpcClient } from "@vibestudio/rpc";
import type { PanelLifecycleResult, PanelPlacementHint } from "@vibestudio/shared/types";
import type {
  PanelTreeNode,
  PanelTreePage,
  PanelTreePageInput,
  PanelTreePath,
  PanelTreeRootGroupPage,
  PanelTreeRootGroupPageInput,
  PanelTreeSearchInput,
  PanelTreeSearchPage,
} from "@vibestudio/shared/panel/treeIndex";
import { isBrowserPanelSource, isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";
import { computePanelId, panelIdSegmentFromName } from "@vibestudio/shared/panelIdUtils";
import { browserSourceFromHostname, generateContextId } from "@vibestudio/shared/panelFactory";
import { validateStateArgs } from "@vibestudio/shared/stateArgsValidator";
import {
  panelFailure,
  PanelOperationError,
  rethrowPanelOperationError,
  type PanelDiagnosticPacket,
  type PanelObservation,
  type PanelSnapshotObservation,
} from "@vibestudio/shared/panel/observation";
import type { PanelFocusOptions, PanelHandle, PanelNavigateOptions } from "../core/index.js";
import { createCdpAutomation, type CdpAutomation } from "../panel/cdpAutomation.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "./handles.js";
import { readPanelStateArgs, updatePanelStateArgs } from "./panelStateArgsPersistence.js";
import { createWorkspaceStateDirectClient } from "./workspaceStateDirect.js";

interface PanelRuntimeMetadataResult {
  id?: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  runtimeEntityId?: string | null;
  contextId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  ref?: string | null;
  observation?: PanelObservation;
}

interface WorkspacePanelDetail {
  slot: { parent_slot_id: string | null; current_entity_title?: string | null };
  currentHistory: {
    source: string;
    context_id: string;
    state_args?: string | null;
    options?: string | null;
  };
  entity: {
    id: string;
    source: { effectiveVersion: string };
    activeBuildKey?: string;
  };
}

interface RuntimePanelEntity {
  id: string;
  contextId: string;
  source: { effectiveVersion: string };
  buildKey?: string;
}

export interface OpenPanelOptions {
  parentId?: string | null;
  /** Display title, overriding the manifest's. Free text; carries no identity. */
  title?: string;
  /**
   * Opt-in stable id segment, making the panel `{parentId}/{slug}`. The caller
   * owns uniqueness; never derive it from a title or other user-controlled text.
   */
  slug?: string;
  /** Present the new panel (default true); false creates it in the background. */
  focus?: boolean;
  contextId?: string;
  ref?: string;
  stateArgs?: Record<string, unknown>;
  /** Per-call visual placement override; wins over the target manifest default. */
  placement?: PanelPlacementHint;
}

export interface PanelRuntimeTree {
  self(): PanelHandle;
  get(id: string, kind?: "workspace" | "browser"): PanelHandle;
  rootGroups(input?: PanelTreeRootGroupPageInput): Promise<PanelTreeRootGroupPage>;
  page(input: PanelTreePageInput): Promise<PanelRuntimeTreePage>;
  path(id: string): Promise<PanelRuntimeTreePath | null>;
  search(input: PanelTreeSearchInput): Promise<PanelRuntimeTreeSearchPage>;
  parent(id: string): PanelHandle | null;
  navigate(id: string, source: string, options?: PanelNavigateOptions): Promise<PanelObservation>;
  navigateHistory(id: string, delta: -1 | 1): Promise<PanelObservation | null>;
}

export interface PanelRuntimeTreeEntry {
  node: PanelTreeNode;
  handle: PanelHandle;
}

export interface PanelRuntimeTreePage {
  revision: number;
  group: PanelTreePageInput["group"];
  entries: PanelRuntimeTreeEntry[];
  nextCursor: string | null;
}

export interface PanelRuntimeTreePath {
  revision: number;
  entries: PanelRuntimeTreeEntry[];
}

export interface PanelRuntimeTreeSearchPage {
  revision: number;
  hits: Array<{
    entry: PanelRuntimeTreeEntry;
    ancestors: PanelRuntimeTreeEntry[];
    ancestorsTruncated?: boolean;
  }>;
  nextCursor: string | null;
}

export interface PanelRuntimeApi {
  panelTree: PanelRuntimeTree;
  openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle>;
  getPanelHandle(id: string, kind?: "workspace" | "browser"): PanelHandle;
  fromMetadata(metadata: PanelHandleMetadata): PanelHandle;
}

export interface CreatePanelRuntimeOptions {
  rpc: Pick<RpcClient, "call" | "emit" | "on">;
  selfId?: string | null;
  selfRpcTargetId?: string | null;
  parentId?: string | null;
  defaultOpenParentId?: string | null | (() => string | null);
  effectiveVersion?: string | null;
  requesterPanelId?: string | null | (() => string | null);
  selfHandle?: () => PanelHandle;
  createCdp?: (metadata: PanelHandleMetadata) => CdpAutomation;
  /** Closure-held resolver for hosted runtimes that do not publish module globals. */
  loadModule?: (id: string) => unknown | Promise<unknown>;
  initialMetadata?: PanelHandleMetadata[];
  onOpen?: (entry: { source: string; id: string; kind: "workspace" | "browser" }) => void;
  onReload?: (id: string) => void;
  onClose?: (id: string) => void;
  onStateArgsSet?: (id: string) => void;
}

export function createPanelRuntime(options: CreatePanelRuntimeOptions): PanelRuntimeApi {
  const metadataCache = new Map<string, PanelHandleMetadata>();
  const workspaceState = createWorkspaceStateDirectClient(options.rpc);
  const callPanelState = async <T>(method: string, args: unknown[]): Promise<T> => {
    try {
      const directMethod = {
        rootGroups: "panelTreeRootGroups",
        page: "panelTreePage",
        path: "panelTreePath",
        detail: "panelTreeDetail",
        search: "panelTreeSearch",
      }[method];
      if (!directMethod) throw new Error(`Unknown workspace-state panel read: ${method}`);
      return await workspaceState.call<T>(directMethod, args);
    } catch (error) {
      rethrowPanelOperationError(error);
    }
  };
  const callView = <T>(method: string, args: unknown[]): Promise<T> =>
    options.rpc.call<T>("main", `view.${method}`, args);
  const getStateArgs = <T = Record<string, unknown>>(id: string): Promise<T> =>
    readPanelStateArgs<T>(options.rpc, id);
  const readMetadata = async (id: string): Promise<PanelRuntimeMetadataResult | null> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) return null;
    const storedOptions = detail.currentHistory.options
      ? (JSON.parse(detail.currentHistory.options) as { ref?: string })
      : {};
    return {
      id,
      title: detail.slot.current_entity_title ?? id,
      source: detail.currentHistory.source,
      kind: isBrowserPanelSource(detail.currentHistory.source) ? "browser" : "workspace",
      parentId: detail.slot.parent_slot_id,
      runtimeEntityId: detail.entity.id,
      contextId: detail.currentHistory.context_id,
      effectiveVersion: detail.entity.source.effectiveVersion,
      buildKey: detail.entity.activeBuildKey ?? null,
      ref: storedOptions.ref ?? null,
    };
  };

  const defaultOpenParentId = (): string | null => {
    const value = options.defaultOpenParentId;
    return typeof value === "function" ? value() : (value ?? null);
  };

  const requesterPanelId = (): string | null => {
    const value = options.requesterPanelId;
    return typeof value === "function" ? value() : (value ?? null);
  };

  const rememberMetadata = (metadata: PanelHandleMetadata): PanelHandleMetadata => {
    const next = { ...(metadataCache.get(metadata.id) ?? {}), ...metadata };
    metadataCache.set(metadata.id, next);
    return next;
  };

  const metadataForId = (
    id: string,
    overrides: Partial<PanelHandleMetadata> = {}
  ): PanelHandleMetadata => {
    const cached = metadataCache.get(id);
    const kind = overrides.kind ?? cached?.kind ?? "workspace";
    return rememberMetadata({
      id,
      title: id,
      source: kind === "browser" ? `browser:${id}` : id,
      kind,
      parentId: null,
      ...(cached ?? {}),
      ...overrides,
    });
  };

  const metadataFromResult = (
    id: string,
    meta: PanelRuntimeMetadataResult
  ): PanelHandleMetadata => ({
    id,
    title: meta.title,
    source: meta.source,
    kind: meta.kind,
    parentId: meta.parentId,
    contextId: meta.contextId ?? null,
    rpcTargetId: meta.runtimeEntityId ?? null,
    effectiveVersion: meta.effectiveVersion ?? null,
    buildKey: meta.buildKey ?? null,
    ref: meta.ref ?? null,
  });

  const createCdp = (metadata: PanelHandleMetadata): CdpAutomation =>
    options.createCdp?.(metadata) ??
    createCdpAutomation(options.rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId: requesterPanelId(),
      loadModule: options.loadModule,
      navigate: (url) => navigatePanel(metadata.id, url).then(() => undefined),
      navigateHistory: (delta) => navigateHistory(metadata.id, delta).then(() => undefined),
      reload: () => restartPanel(metadata.id),
    });

  const observePanel = async (id: string): Promise<PanelObservation> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    const runtime = await options.rpc.call<{
      lease: {
        holderLabel: string;
        platform: "desktop" | "headless" | "mobile";
        supportsCdp: boolean;
      } | null;
      observation: {
        url: string;
        loading: boolean;
        boot: {
          phase: "unavailable" | "loading" | "booting" | "ready" | "failed";
          message?: string;
          errorName?: string;
          stack?: string;
          updatedAt?: number;
        };
      } | null;
    }>("main", "panelRuntime.observeSlot", [id]);
    const storedOptions = detail.currentHistory.options
      ? (JSON.parse(detail.currentHistory.options) as { ref?: string })
      : {};
    const boot = runtime.observation?.boot;
    const phase = !runtime.lease
      ? ("assigning-host" as const)
      : !boot || boot.phase === "unavailable" || boot.phase === "loading"
        ? ("loading" as const)
        : boot.phase;
    const updatedAt = boot?.updatedAt ?? Date.now();
    const source = detail.currentHistory.source;
    const requestedRef = storedOptions.ref ?? "latest";
    const failure =
      phase === "failed"
        ? {
            code: "entry_threw" as const,
            stage: "boot" as const,
            message: boot?.message ?? "Panel boot failed",
            provenance: {
              panelId: id,
              runtimeEntityId: detail.entity.id,
              attemptId: `${detail.entity.id}@${detail.entity.activeBuildKey ?? "pending"}`,
              source,
              contextId: detail.currentHistory.context_id,
              requestedRef,
              effectiveVersion: detail.entity.source.effectiveVersion,
              buildKey: detail.entity.activeBuildKey ?? null,
            },
            diagnosticId: `panel-boot:${detail.entity.id}:${updatedAt}`,
            occurredAt: updatedAt,
            details: {
              ...(boot?.errorName ? { errorName: boot.errorName } : {}),
              ...(boot?.stack ? { stack: boot.stack } : {}),
            },
          }
        : undefined;
    return {
      panelId: id,
      title: detail.slot.current_entity_title ?? id,
      source,
      kind: isBrowserPanelSource(source) ? "browser" : "workspace",
      parentId: detail.slot.parent_slot_id,
      contextId: detail.currentHistory.context_id,
      requestedRef,
      runtimeEntityId: detail.entity.id,
      attemptId: `${detail.entity.id}@${detail.entity.activeBuildKey ?? "pending"}`,
      effectiveVersion: detail.entity.source.effectiveVersion || null,
      buildKey: detail.entity.activeBuildKey ?? null,
      phase,
      ...(failure ? { failure } : {}),
      ...(runtime.lease
        ? {
            host: {
              holderLabel: runtime.lease.holderLabel,
              platform: runtime.lease.platform,
              supportsInspection: runtime.lease.supportsCdp,
              view: {
                exists: runtime.observation !== null,
                ...(runtime.observation
                  ? {
                      url: runtime.observation.url,
                      loading: runtime.observation.loading,
                    }
                  : {}),
              },
              boot: boot ?? { phase: "unavailable" as const },
              ...(failure
                ? {
                    failure: {
                      code: failure.code,
                      stage: failure.stage,
                      message: failure.message,
                    },
                  }
                : {}),
            },
          }
        : {}),
      updatedAt,
    };
  };

  const ensurePanelHost = async (
    id: string,
    entity: RuntimePanelEntity,
    source: string,
    contextId: string,
    requestedRef: string
  ): Promise<void> => {
    const result = await options.rpc.call<{
      status: "assigned" | "already-held" | "mobile-held" | "unavailable";
    }>("main", "panelRuntime.ensureSlot", [id, entity.id]);
    if (result.status !== "unavailable") return;
    throw new PanelOperationError(
      panelFailure({
        code: "host_unavailable",
        stage: "host",
        message: "No panel host is available to present this runtime",
        provenance: {
          panelId: id,
          runtimeEntityId: entity.id,
          source,
          contextId,
          requestedRef,
          effectiveVersion: entity.source.effectiveVersion,
          buildKey: entity.buildKey ?? null,
        },
      })
    );
  };

  for (const metadata of options.initialMetadata ?? []) {
    rememberMetadata(metadata);
  }

  const waitUntilReady = async (initial: PanelObservation): Promise<PanelObservation> => {
    let observation = initial;
    while (observation.phase !== "ready") {
      if (observation.phase === "failed" && observation.failure) {
        throw new PanelOperationError(observation.failure);
      }
      if (observation.phase === "stopped") {
        throw new Error(`Panel ${observation.panelId} stopped before it became ready`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      observation = await observePanel(observation.panelId);
    }
    return observation;
  };

  const closePanel = async (id: string): Promise<PanelLifecycleResult> => {
    const closed = await workspaceState.call<{ closeId: string; closedCount: number }>(
      "slotClose",
      [id]
    );
    for (;;) {
      const page = await workspaceState.call<{
        items: Array<{ slotId: string; entityId: string | null }>;
        nextCursor: string | null;
      }>("slotCloseCleanupPage", [{ closeId: closed.closeId, limit: 200 }]);
      if (page.items.length === 0) break;
      for (const item of page.items) {
        if (item.entityId) {
          await options.rpc.call("main", "runtime.retireEntity", [{ id: item.entityId }]);
        }
      }
      await workspaceState.call("slotCloseCleanupAck", [page.items.map((item) => item.slotId)]);
      if (!page.nextCursor) break;
    }
    return {
      panelId: id,
      operation: "close",
      status: "closed",
      loaded: false,
      rebuilt: false,
      reloaded: false,
      closedCount: closed.closedCount,
    };
  };

  const navigatePanel = async (
    id: string,
    source: string,
    navigateOptions?: PanelNavigateOptions,
    historyMode: "append" | "replace" = "append"
  ): Promise<PanelObservation> => {
    const current = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!current) throw new Error(`Unknown panel slot: ${id}`);
    const external = isOpenPanelBrowserUrl(source);
    const panelMetadata = external
      ? null
      : await options.rpc.call<{
          title?: string;
          stateArgs?: unknown;
        } | null>("main", "build.getPanelMetadata", [source]);
    if (!external && !panelMetadata) throw new Error(`Unknown panel source: ${source}`);
    const stateArgsValidation = external
      ? { success: true as const, data: navigateOptions?.stateArgs ?? {} }
      : validateStateArgs(navigateOptions?.stateArgs ?? {}, panelMetadata?.stateArgs as never);
    if (!stateArgsValidation.success) {
      throw new Error(`Invalid stateArgs for ${source}: ${stateArgsValidation.error}`);
    }
    const stateArgs = stateArgsValidation.data as Record<string, unknown>;
    const storedOptions = current.currentHistory.options
      ? (JSON.parse(current.currentHistory.options) as {
          env?: Record<string, string>;
          ref?: string;
        })
      : {};
    const nextEnv = navigateOptions?.env ?? storedOptions.env;
    const contextId = navigateOptions?.contextId ?? current.currentHistory.context_id;
    const entryKey = `nav-${crypto.randomUUID()}`;
    const historySource = external ? `browser:${source}` : source;
    const entitySpec = {
      kind: "panel" as const,
      execution: external
        ? ({ surface: "external", url: source } as const)
        : ({
            surface: "code",
            source,
            ...(navigateOptions?.ref ? { ref: navigateOptions.ref } : {}),
          } as const),
      key: entryKey,
      contextId,
      stateArgs,
    };
    const next = await options.rpc.call<RuntimePanelEntity>("main", "runtime.createEntity", [
      entitySpec,
    ]);
    let committed = false;
    try {
      const transition = await workspaceState.call<{
        previousEntityId: string;
        currentEntityId: string;
      }>("slotCommitPreparedNavigation", [
        {
          slotId: id,
          expectedCurrentEntityId: current.entity.id,
          mutation: {
            kind: historyMode,
            entry: {
              entryKey,
              entityId: next.id,
              source: historySource,
              contextId,
              stateArgs,
              options: {
                ...(nextEnv ? { env: nextEnv } : {}),
                ...(navigateOptions?.ref ? { ref: navigateOptions.ref } : {}),
              },
            },
          },
        },
      ]);
      committed = true;
      await options.rpc.call("main", "panelRuntime.handoffSlot", [
        id,
        transition.previousEntityId,
        transition.currentEntityId,
      ]);
      if (transition.previousEntityId !== transition.currentEntityId) {
        await options.rpc.call("main", "runtime.retireEntity", [
          { id: transition.previousEntityId },
        ]);
      }
      await ensurePanelHost(
        id,
        next,
        historySource,
        contextId,
        navigateOptions?.ref ?? storedOptions.ref ?? "latest"
      );
    } catch (error) {
      if (!committed) {
        await options.rpc.call("main", "runtime.retireEntity", [{ id: next.id }]).catch(() => {});
      }
      throw error;
    }
    const title = external
      ? new URL(source).hostname || new URL(source).protocol.replace(/:$/, "") || "browser"
      : (panelMetadata?.title ?? source);
    await workspaceState.call("panelUpdateTitle", [id, title, { explicit: false }]);
    const observation = await observePanel(id);
    rememberMetadata({
      id,
      title,
      source: historySource,
      kind: external ? "browser" : "workspace",
      parentId: current.slot.parent_slot_id,
      contextId,
      rpcTargetId: next.id,
      effectiveVersion: next.source.effectiveVersion,
      buildKey: next.buildKey ?? null,
    });
    return waitUntilReady(observation);
  };

  const navigateHistory = async (id: string, delta: -1 | 1): Promise<PanelObservation | null> => {
    const current = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!current) throw new Error(`Unknown panel slot: ${id}`);
    const target = await workspaceState.call<{
      entry_key: string;
      entity_id: string;
      source: string;
      context_id: string;
      state_args: string | null;
      options: string | null;
    } | null>("slotHistoryRelative", [id, delta]);
    if (!target) return null;
    const external = target.source.startsWith("browser:");
    const source = external ? target.source.slice("browser:".length) : target.source;
    const storedOptions = target.options
      ? (JSON.parse(target.options) as {
          ref?: string;
        })
      : {};
    const spec = {
      kind: "panel" as const,
      execution: external
        ? ({ surface: "external", url: source } as const)
        : ({
            surface: "code",
            source,
            ...(storedOptions.ref ? { ref: storedOptions.ref } : {}),
          } as const),
      key: target.entry_key,
      contextId: target.context_id,
      stateArgs: target.state_args ? JSON.parse(target.state_args) : {},
    };
    const next = await options.rpc.call<RuntimePanelEntity>("main", "runtime.createEntity", [spec]);
    if (next.id !== target.entity_id) {
      await options.rpc.call("main", "runtime.retireEntity", [{ id: next.id }]).catch(() => {});
      throw new Error(
        `History entry ${target.entry_key} resolved to ${next.id}, expected ${target.entity_id}`
      );
    }
    const transition = await workspaceState.call<{
      previousEntityId: string;
      currentEntityId: string;
    }>("slotCommitPreparedNavigation", [
      {
        slotId: id,
        expectedCurrentEntityId: current.entity.id,
        mutation: { kind: "select", entryKey: target.entry_key },
      },
    ]);
    await options.rpc.call("main", "panelRuntime.handoffSlot", [
      id,
      transition.previousEntityId,
      transition.currentEntityId,
    ]);
    if (transition.previousEntityId !== transition.currentEntityId) {
      await options.rpc.call("main", "runtime.retireEntity", [{ id: transition.previousEntityId }]);
    }
    await ensurePanelHost(
      id,
      next,
      target.source,
      target.context_id,
      storedOptions.ref ?? "latest"
    );
    const observation = await observePanel(id);
    return waitUntilReady(observation);
  };

  const restartPanel = async (id: string): Promise<void> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    await options.rpc.call("main", "runtime.supervision.restart", [
      { kind: "panel", entityId: detail.entity.id },
    ]);
  };

  const rebuildPanel = async (id: string): Promise<PanelObservation> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    const storedOptions = detail.currentHistory.options
      ? (JSON.parse(detail.currentHistory.options) as {
          ref?: string;
          env?: Record<string, string>;
        })
      : {};
    const source = detail.currentHistory.source.startsWith("browser:")
      ? detail.currentHistory.source.slice("browser:".length)
      : detail.currentHistory.source;
    return navigatePanel(
      id,
      source,
      {
        contextId: detail.currentHistory.context_id,
        stateArgs: detail.currentHistory.state_args
          ? JSON.parse(detail.currentHistory.state_args)
          : {},
        ...(storedOptions.ref ? { ref: storedOptions.ref } : {}),
        ...(storedOptions.env ? { env: storedOptions.env } : {}),
      },
      "replace"
    );
  };

  const callPanelAgent = async (id: string, method: string, args: unknown[]): Promise<unknown> => {
    const allowed = new Set([
      "_agent.snapshot",
      "_agent.tree",
      "_agent.state",
      "_agent.routes",
      "_agent.setMode",
    ]);
    if (!allowed.has(method)) throw new Error(`Unknown panel agent method: ${method}`);
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    return options.rpc.call(detail.entity.id, method, args);
  };

  const snapshotPanel = async (id: string): Promise<PanelSnapshotObservation> => {
    const observation = await waitUntilReady(await observePanel(id));
    const document = (await callPanelAgent(id, "_agent.snapshot", [])) as {
      kind: "synth";
      text: string;
      structure: Record<string, unknown>;
    };
    if (!observation.runtimeEntityId) throw new Error(`Panel ${id} has no runtime entity`);
    return {
      panelId: id,
      attemptId: observation.attemptId,
      runtimeEntityId: observation.runtimeEntityId,
      buildKey: observation.buildKey,
      capturedAt: Date.now(),
      document,
    };
  };

  const diagnosePanel = async (id: string): Promise<PanelDiagnosticPacket> => {
    const observation = await observePanel(id);
    let consoleHistory: PanelDiagnosticPacket["consoleHistory"];
    try {
      const history = await options.rpc.call<{
        entries: never[];
        errors: never[];
        dropped: { entries: number; errors: number };
        capacity: { entries: number; errors: number };
      }>("main", "panelCdp.consoleHistory", [id, { limit: 200, errorLimit: 100 }]);
      consoleHistory = {
        available: true,
        ...history,
      };
    } catch (error) {
      consoleHistory = {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let document: PanelSnapshotObservation | undefined;
    if (observation.phase === "ready") {
      try {
        document = await snapshotPanel(id);
      } catch {
        // Diagnostics remain useful when the runtime does not expose the
        // optional inspection contract.
      }
    }
    return { observation, consoleHistory, ...(document ? { document } : {}) };
  };

  const ops: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await readMetadata(id);
      return meta ? rememberMetadata(metadataFromResult(id, meta)) : metadataForId(id);
    },
    observe: observePanel,
    diagnose: diagnosePanel,
    parent: (id, parentId) => {
      const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    reload: async (id) => {
      await restartPanel(id);
      const result = await waitUntilReady(await observePanel(id));
      options.onReload?.(id);
      return result;
    },
    close: async (id) => {
      const result = await closePanel(id);
      options.onClose?.(id);
      return result;
    },
    archive: async (id) => {
      await closePanel(id);
      options.onClose?.(id);
    },
    unload: (id) => options.rpc.call<PanelLifecycleResult>("main", "panelRuntime.unloadSlot", [id]),
    setTitle: (id, title, titleOptions) =>
      workspaceState.call("panelUpdateTitle", [id, title, titleOptions]),
    navigate: async (id, source, navigateOptions) => {
      return navigatePanel(id, source, navigateOptions);
    },
    movePanel: (id, newParentId, placement) =>
      workspaceState.call("slotMove", [id, newParentId, placement]),
    takeOver: async (id) => {
      await options.rpc.call("main", "panelRuntime.takeOverSlot", [id]);
      await options.rpc.call("main", "view.focusPanel", [id, {}]);
    },
    openDevTools: (id, mode) => callView("openPanelDevTools", [id, mode]),
    rebuild: async (id) => {
      const result = await rebuildPanel(id);
      options.onReload?.(id);
      return result;
    },
    focus: async (id, focusOptions) => {
      const anchorPanelId = focusOptions?.anchorPanelId ?? requesterPanelId();
      const resolved: PanelFocusOptions = {
        ...(focusOptions ?? {}),
        ...(anchorPanelId ? { anchorPanelId } : {}),
      };
      await options.rpc.call("main", "view.focusPanel", [id, resolved]);
      return waitUntilReady(await observePanel(id));
    },
    stateArgs: {
      get: getStateArgs,
      set: async (id, updates) => {
        const next = await updatePanelStateArgs(options.rpc, id, updates);
        options.onStateArgsSet?.(id);
        return next;
      },
    },
    snapshot: snapshotPanel,
    callAgent: callPanelAgent,
  };

  const fromMetadata = (input: PanelHandleMetadata): PanelHandle => {
    const metadata = rememberMetadata(input);
    return createPanelHandle({
      rpc: options.rpc,
      metadata,
      cdp: createCdp(metadata),
      ops,
    });
  };

  const hydrateNode = (node: PanelTreeNode): PanelRuntimeTreeEntry => ({
    node,
    handle: fromMetadata({
      id: node.slotId,
      title: node.title,
      source: node.source ?? node.slotId,
      kind: node.kind ?? "workspace",
      parentId: node.parentSlotId,
      contextId: node.contextId ?? null,
      rpcTargetId: node.runtimeEntityId ?? null,
      effectiveVersion: node.effectiveVersion ?? null,
      buildKey: node.buildKey ?? null,
      ref: node.ref ?? null,
    }),
  });

  const readPage = async (input: PanelTreePageInput): Promise<PanelRuntimeTreePage> => {
    const page = await callPanelState<PanelTreePage>("page", [input]);
    return {
      revision: page.revision,
      group: page.group,
      entries: page.nodes.map(hydrateNode),
      nextCursor: page.nextCursor,
    };
  };

  const panelTree: PanelRuntimeTree = {
    self() {
      if (options.selfHandle) return options.selfHandle();
      if (!options.selfId) {
        throw new Error("panelTree.self() is not available before runtime init");
      }
      return createPanelHandle({
        rpc: options.rpc,
        metadata: {
          id: options.selfId,
          title: options.selfId,
          source: options.selfId,
          kind: "workspace",
          parentId: options.parentId ?? null,
          rpcTargetId: options.selfRpcTargetId ?? options.selfId,
          effectiveVersion: options.effectiveVersion ?? null,
        },
        cdp: createCdp({
          id: options.selfId,
          kind: "workspace",
          parentId: options.parentId ?? null,
        }),
        ops,
      });
    },
    get(id, kind) {
      const metadata = metadataForId(id, kind ? { kind } : {});
      return fromMetadata(metadata);
    },
    rootGroups(input = {}) {
      return callPanelState<PanelTreeRootGroupPage>("rootGroups", [input]);
    },
    page(input) {
      return readPage(input);
    },
    async path(id) {
      const path = await callPanelState<PanelTreePath | null>("path", [id]);
      return path ? { revision: path.revision, entries: path.nodes.map(hydrateNode) } : null;
    },
    async search(input) {
      const page = await callPanelState<PanelTreeSearchPage>("search", [input]);
      return {
        revision: page.revision,
        hits: page.hits.map((hit) => ({
          entry: hydrateNode(hit.node),
          ancestors: hit.ancestors.map(hydrateNode),
          ...(hit.ancestorsTruncated ? { ancestorsTruncated: true } : {}),
        })),
        nextCursor: page.nextCursor,
      };
    },
    parent(id) {
      const parentId =
        options.selfId && id === options.selfId
          ? (options.parentId ?? metadataCache.get(id)?.parentId)
          : metadataCache.get(id)?.parentId;
      return parentId ? panelTree.get(parentId) : null;
    },
    navigate(id, source, navigateOptions) {
      return ops.navigate!(id, source, navigateOptions);
    },
    navigateHistory(id, delta) {
      return navigateHistory(id, delta);
    },
  };

  const openPanel = async (
    source: string,
    openOptions?: OpenPanelOptions
  ): Promise<PanelHandle> => {
    const parentId =
      openOptions?.parentId !== undefined ? openOptions.parentId : defaultOpenParentId();
    const external = isOpenPanelBrowserUrl(source);
    const execution = external
      ? ({ surface: "external", url: source } as const)
      : ({
          surface: "code",
          source,
          ...(openOptions?.ref ? { ref: openOptions.ref } : {}),
        } as const);
    const parsedUrl = external ? new URL(source) : null;
    const identitySource = parsedUrl
      ? browserSourceFromHostname(
          parsedUrl.hostname || parsedUrl.protocol.replace(/:$/, "") || "browser"
        )
      : source;
    const id = computePanelId({
      relativePath: identitySource,
      parent: parentId ? { id: parentId } : null,
      ...(openOptions?.slug ? { requestedId: panelIdSegmentFromName(openOptions.slug) } : {}),
      isRoot: parentId == null,
    });
    const entryKey = `nav-${crypto.randomUUID()}`;
    const contextId =
      openOptions?.contextId?.trim() || (external ? generateContextId(id) : undefined);
    const panelMetadata = external
      ? null
      : await options.rpc.call<{
          title?: string;
          stateArgs?: unknown;
          autoArchiveWhenEmpty?: boolean;
        } | null>("main", "build.getPanelMetadata", [source]);
    if (!external && !panelMetadata) {
      throw new Error(`Unknown panel source: ${source}`);
    }
    const stateArgsValidation = external
      ? { success: true as const, data: openOptions?.stateArgs ?? {} }
      : validateStateArgs(openOptions?.stateArgs ?? {}, panelMetadata?.stateArgs as never);
    if (!stateArgsValidation.success) {
      throw new Error(`Invalid stateArgs for ${source}: ${stateArgsValidation.error}`);
    }
    const stateArgs = stateArgsValidation.data as Record<string, unknown>;
    const entitySpec = {
      kind: "panel" as const,
      execution,
      key: entryKey,
      ...(contextId ? { contextId } : {}),
      stateArgs,
    };
    let runtimeEntity = external
      ? await options.rpc.call<RuntimePanelEntity>("main", "runtime.createEntity", [entitySpec])
      : await options.rpc.call<RuntimePanelEntity>("main", "runtime.reserveEntity", [entitySpec]);
    const historySource = external ? `browser:${source}` : source;
    try {
      await workspaceState.call("slotCreate", [
        {
          slotId: id,
          parentSlotId: parentId,
          initialEntry: {
            entryKey,
            entityId: runtimeEntity.id,
            source: historySource,
            contextId: runtimeEntity.contextId,
            stateArgs,
            options: {
              ...(openOptions?.ref ? { ref: openOptions.ref } : {}),
              ...(openOptions?.placement ? { placement: openOptions.placement } : {}),
            },
          },
        },
      ]);
      if (!external) {
        runtimeEntity = await options.rpc.call("main", "runtime.activateReservedEntity", [
          entitySpec,
        ]);
      }
    } catch (error) {
      await options.rpc
        .call("main", "runtime.retireEntity", [{ id: runtimeEntity.id }])
        .catch(() => {});
      throw error;
    }
    await ensurePanelHost(
      id,
      runtimeEntity,
      historySource,
      runtimeEntity.contextId,
      openOptions?.ref ?? "latest"
    );
    const title =
      openOptions?.title?.trim() ||
      panelMetadata?.title ||
      parsedUrl?.hostname ||
      parsedUrl?.protocol.replace(/:$/, "") ||
      source;
    await workspaceState.call("panelUpdateTitle", [id, title, { explicit: !!openOptions?.title }]);
    const observation = await observePanel(id);
    const panelHandle = fromMetadata({
      id,
      title,
      source: historySource,
      kind: external ? "browser" : "workspace",
      parentId,
      contextId: runtimeEntity.contextId,
      rpcTargetId: runtimeEntity.id,
      effectiveVersion: runtimeEntity.source.effectiveVersion || null,
      buildKey: runtimeEntity.buildKey ?? null,
    });
    options.onOpen?.({ source, id: panelHandle.id, kind: panelHandle.kind });
    if (openOptions?.focus !== false) await ops.focus?.(id);
    await waitUntilReady(observation);
    return panelHandle;
  };

  return {
    panelTree,
    openPanel,
    getPanelHandle: (id, kind) => panelTree.get(id, kind),
    fromMetadata,
  };
}

export function createRuntimeSelfHandle(options: {
  id: string;
  parentId?: string | null;
  parent?: () => PanelHandle | null;
}): PanelHandle {
  return createNonPanelRuntimeHandle(options);
}
