import type { RpcClient } from "@vibestudio/rpc";
import {
  panelTreeMethods,
  type PanelTreeListItem,
  type PanelTreeMetadata,
} from "@vibestudio/service-schemas/panelTree";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { PanelHandle, PanelNavigateOptions } from "../core/index.js";
import { createCdpAutomation, type CdpAutomation } from "../panel/cdpAutomation.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "./handles.js";

export interface OpenPanelOptions {
  parentId?: string | null;
  name?: string;
  focus?: boolean;
  contextId?: string;
  ref?: string;
  stateArgs?: Record<string, unknown>;
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
  ): Promise<{ id: string; title: string }>;
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
  executionDigest?: string | null;
  requesterPanelId?: string | null | (() => string | null);
  selfHandle?: () => PanelHandle;
  createCdp?: (metadata: PanelHandleMetadata) => CdpAutomation;
  initialMetadata?: PanelHandleMetadata[];
  onOpen?: (entry: { source: string; id: string; kind: "workspace" | "browser" }) => void;
  onReload?: (id: string) => void;
  onClose?: (id: string) => void;
  onStateArgsSet?: (id: string) => void;
}

export function createPanelRuntime(options: CreatePanelRuntimeOptions): PanelRuntimeApi {
  const metadataCache = new Map<string, PanelHandleMetadata>();
  const panelTreeService = createTypedServiceClient(
    "panelTree",
    panelTreeMethods,
    (_service, method, args) => options.rpc.call("main", `panelTree.${method}`, args)
  );

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

  const itemToMetadata = (item: PanelTreeListItem): PanelHandleMetadata =>
    rememberMetadata({
      id: item.panelId,
      title: item.title,
      source: item.source,
      kind: item.kind,
      parentId: item.parentId,
      contextId: item.contextId,
      rpcTargetId: item.runtimeEntityId ?? null,
      executionDigest: item.executionDigest ?? null,
    });

  const metadataFromResult = (id: string, meta: PanelTreeMetadata): PanelHandleMetadata => ({
    id,
    title: meta.title,
    source: meta.source,
    kind: meta.kind,
    parentId: meta.parentId,
    contextId: meta.contextId ?? null,
    rpcTargetId: meta.runtimeEntityId ?? null,
    executionDigest: meta.executionDigest ?? null,
    ref: meta.ref ?? null,
  });

  const createCdp = (metadata: PanelHandleMetadata): CdpAutomation =>
    options.createCdp?.(metadata) ??
    createCdpAutomation(options.rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId: requesterPanelId(),
    });

  for (const metadata of options.initialMetadata ?? []) {
    rememberMetadata(metadata);
  }

  const ops: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await panelTreeService.metadata(id);
      return meta ? rememberMetadata(metadataFromResult(id, meta)) : metadataForId(id);
    },
    children: (id) => panelTree.children(id),
    parent: (id, parentId) => {
      const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    ensureLoaded: (id) => panelTreeService.ensureLoaded(id),
    isLoaded: async (id) => {
      try {
        const lease = await panelTreeService.getRuntimeLease(id);
        return lease !== null;
      } catch {
        return false;
      }
    },
    reload: async (id) => {
      const result = await panelTreeService.reload(id);
      options.onReload?.(id);
      return result;
    },
    close: async (id) => {
      const result = await panelTreeService.close(id);
      options.onClose?.(id);
      return result;
    },
    archive: async (id) => {
      await panelTreeService.archive(id);
      options.onClose?.(id);
    },
    unload: (id) => panelTreeService.unload(id),
    navigate: async (id, source, navigateOptions) => {
      const result = await panelTreeService.navigate(id, source, navigateOptions);
      if (!result) throw new Error(`Panel not found: ${id}`);
      return { id: result.id, title: result.title };
    },
    movePanel: (id, newParentId, targetPosition) =>
      panelTreeService.movePanel({ panelId: id, newParentId, targetPosition }),
    takeOver: async (id) => {
      await panelTreeService.takeOver(id);
    },
    openDevTools: (id, mode) => panelTreeService.openDevTools(id, mode),
    rebuildPanel: (id) => panelTreeService.rebuildPanel(id),
    rebuildAndReload: async (id) => {
      const result = await panelTreeService.rebuildAndReload(id);
      options.onReload?.(id);
      return result;
    },
    updatePanelState: (id, state) => panelTreeService.updatePanelState(id, state),
    focus: async (id) => {
      await panelTreeService.focus(id);
    },
    stateArgs: {
      get: async <T = Record<string, unknown>>(id: string): Promise<T> =>
        (await panelTreeService.getStateArgs(id)) as T,
      set: async (id, updates) => {
        const next = await panelTreeService.setStateArgs(id, updates);
        options.onStateArgsSet?.(id);
        return next;
      },
    },
    snapshot: (id) => panelTreeService.snapshot(id),
    callAgent: (id, method, args) => panelTreeService.callAgent(id, method, args),
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

  const hydrate = (item: PanelTreeListItem): PanelHandle => fromMetadata(itemToMetadata(item));

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
          executionDigest: options.executionDigest ?? null,
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
      return (await panelTreeService.list(null)).map(hydrate);
    },
    async roots() {
      return (await panelTreeService.roots()).map(hydrate);
    },
    async children(id) {
      return (await panelTreeService.list(id)).map(hydrate);
    },
    parent(id) {
      const parentId =
        options.selfId && id === options.selfId
          ? (options.parentId ?? metadataCache.get(id)?.parentId)
          : metadataCache.get(id)?.parentId;
      return parentId ? panelTree.get(parentId) : null;
    },
    async navigate(id, source, navigateOptions) {
      const result = await panelTreeService.navigate(id, source, navigateOptions);
      if (!result) throw new Error(`Panel not found: ${id}`);
      return { id: result.id, title: result.title };
    },
  };

  const openPanel = async (
    source: string,
    openOptions?: OpenPanelOptions
  ): Promise<PanelHandle> => {
    const parentId =
      openOptions?.parentId !== undefined ? openOptions.parentId : defaultOpenParentId();
    const result = await panelTreeService.create(source, { ...openOptions, parentId });
    const handle = hydrate({
      panelId: result.id,
      title: result.title,
      source: result.kind === "browser" ? `browser:${source}` : source,
      kind: result.kind,
      parentId: result.parentId ?? parentId,
      contextId: result.contextId ?? openOptions?.contextId ?? "",
      runtimeEntityId: result.runtimeEntityId ?? null,
      executionDigest: result.executionDigest ?? null,
    });
    options.onOpen?.({ source, id: handle.id, kind: handle.kind });
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
