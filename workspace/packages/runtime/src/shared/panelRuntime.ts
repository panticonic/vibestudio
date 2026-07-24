import type { RpcClient } from "@vibestudio/rpc";
import type { PanelLifecycleResult, PanelPlacementHint } from "@vibestudio/shared/types";
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

export interface PanelRuntimeListItem {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  ref?: string | null;
  children?: PanelRuntimeListItem[];
}

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
  observation: PanelObservation;
}

export interface OpenPanelOptions {
  parentId?: string | null;
  name?: string;
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
  list(): Promise<PanelHandle[]>;
  roots(): Promise<PanelHandle[]>;
  children(id: string): Promise<PanelHandle[]>;
  parent(id: string): PanelHandle | null;
  navigate(
    id: string,
    source: string,
    options?: PanelNavigateOptions
  ): Promise<PanelObservation>;
}

export interface PanelRuntimeApi {
  panelTree: PanelRuntimeTree;
  openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle>;
  listPanels(): Promise<PanelHandle[]>;
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
  const callPanel = async <T>(method: string, args: unknown[]): Promise<T> => {
    try {
      return await options.rpc.call<T>("main", `panelTree.${method}`, args);
    } catch (error) {
      rethrowPanelOperationError(error);
    }
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

  const itemToMetadata = (item: PanelRuntimeListItem): PanelHandleMetadata =>
    rememberMetadata({
      id: item.panelId,
      title: item.title,
      source: item.source,
      kind: item.kind,
      parentId: item.parentId,
      contextId: item.contextId,
      rpcTargetId: item.runtimeEntityId ?? null,
      effectiveVersion: item.effectiveVersion ?? null,
      buildKey: item.buildKey ?? null,
      ref: item.ref ?? null,
    });

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
    });

  for (const metadata of options.initialMetadata ?? []) {
    rememberMetadata(metadata);
  }

  const ops: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await callPanel<PanelRuntimeMetadataResult | null>("metadata", [id]);
      return meta ? rememberMetadata(metadataFromResult(id, meta)) : metadataForId(id);
    },
    observe: (id) => callPanel<PanelObservation>("observe", [id]),
    diagnose: (id) => callPanel<PanelDiagnosticPacket>("diagnose", [id]),
    children: (id) => panelTree.children(id),
    parent: (id, parentId) => {
      const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    reload: async (id) => {
      const result = await callPanel<PanelObservation>("reload", [id]);
      options.onReload?.(id);
      return result;
    },
    close: async (id) => {
      const result = await callPanel<PanelLifecycleResult>("close", [id]);
      options.onClose?.(id);
      return result;
    },
    archive: async (id) => {
      await callPanel("archive", [id]);
      options.onClose?.(id);
    },
    unload: (id) => callPanel<PanelLifecycleResult>("unload", [id]),
    navigate: async (id, source, navigateOptions) => {
      const result = await callPanel<PanelRuntimeMetadataResult>("navigate", [
        id,
        source,
        navigateOptions,
      ]);
      if (!result.observation) {
        throw new Error(`panelTree.navigate returned no canonical observation for ${id}`);
      }
      return result.observation;
    },
    movePanel: (id, newParentId, targetPosition) =>
      callPanel("movePanel", [{ panelId: id, newParentId, targetPosition }]),
    takeOver: (id) => callPanel("takeOver", [id]),
    openDevTools: (id, mode) => callPanel("openDevTools", [id, mode]),
    rebuild: async (id) => {
      const result = await callPanel<PanelObservation>("rebuildPanel", [id]);
      options.onReload?.(id);
      return result;
    },
    updatePanelState: (id, state) => callPanel("updatePanelState", [id, state]),
    focus: (id, focusOptions) => {
      if (!focusOptions) return callPanel("focus", [id]);
      const anchorPanelId = focusOptions.anchorPanelId ?? requesterPanelId();
      const resolved: PanelFocusOptions = {
        ...focusOptions,
        ...(anchorPanelId ? { anchorPanelId } : {}),
      };
      return callPanel("focus", [id, resolved]);
    },
    stateArgs: {
      get: (id) => callPanel("getStateArgs", [id]),
      set: async (id, updates) => {
        const next = await callPanel<Record<string, unknown>>("setStateArgs", [id, updates]);
        options.onStateArgsSet?.(id);
        return next;
      },
    },
    snapshot: (id) => callPanel<PanelSnapshotObservation>("snapshot", [id]),
    callAgent: (id, method, args) => callPanel("callAgent", [id, method, args]),
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

  const hydrate = (item: PanelRuntimeListItem): PanelHandle => fromMetadata(itemToMetadata(item));

  const flatten = (items: PanelRuntimeListItem[]): PanelRuntimeListItem[] => {
    const out: PanelRuntimeListItem[] = [];
    const visit = (item: PanelRuntimeListItem) => {
      out.push(item);
      for (const child of item.children ?? []) visit(child);
    };
    for (const item of items) visit(item);
    return out;
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
    async list() {
      return flatten(await callPanel<PanelRuntimeListItem[]>("list", [null])).map(hydrate);
    },
    async roots() {
      return (await callPanel<PanelRuntimeListItem[]>("roots", [])).map(hydrate);
    },
    async children(id) {
      return (await callPanel<PanelRuntimeListItem[]>("list", [id])).map(hydrate);
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
  };

  const openPanel = async (
    source: string,
    openOptions?: OpenPanelOptions
  ): Promise<PanelHandle> => {
    const parentId =
      openOptions?.parentId !== undefined ? openOptions.parentId : defaultOpenParentId();
    const result = await callPanel<{
      id: string;
      title: string;
      kind: "workspace" | "browser";
      parentId?: string | null;
      contextId?: string;
      runtimeEntityId?: string | null;
      effectiveVersion?: string | null;
      buildKey?: string | null;
      observation: PanelObservation;
    }>("create", [source, { ...openOptions, parentId }]);
    const handle = hydrate({
      panelId: result.id,
      title: result.title,
      source: result.kind === "browser" ? `browser:${source}` : source,
      kind: result.kind,
      parentId: result.parentId ?? parentId,
      contextId: result.contextId ?? openOptions?.contextId ?? "",
      runtimeEntityId: result.runtimeEntityId ?? null,
      effectiveVersion: result.effectiveVersion ?? null,
      buildKey: result.buildKey ?? null,
    });
    options.onOpen?.({ source, id: handle.id, kind: handle.kind });
    let observation = result.observation;
    const deadline = Date.now() + 90_000;
    while (observation.phase !== "ready") {
      if (observation.phase === "failed" && observation.failure) {
        throw new PanelOperationError(observation.failure);
      }
      if (Date.now() >= deadline) {
        throw new PanelOperationError(
          panelFailure({
            code: "runtime_handshake_timeout",
            stage: "boot",
            message: "Panel did not become ready within 90000ms",
            provenance: {
              panelId: observation.panelId,
              runtimeEntityId: observation.runtimeEntityId,
              attemptId: observation.attemptId,
              source: observation.source,
              contextId: observation.contextId,
              requestedRef: observation.requestedRef,
              effectiveVersion: observation.effectiveVersion,
              buildKey: observation.buildKey,
            },
            details: { lastPhase: observation.phase, host: observation.host ?? null },
          })
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      observation = await handle.observe();
    }
    return handle;
  };

  return {
    panelTree,
    openPanel,
    listPanels: () => panelTree.list(),
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
