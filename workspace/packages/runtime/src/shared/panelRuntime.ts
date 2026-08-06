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
import {
  browserUrlFromPanelSource,
  isBrowserPanelSource,
  isOpenPanelBrowserUrl,
} from "@vibestudio/shared/panelChrome";
import { normalizePanelTitle } from "@vibestudio/shared/panel/title";
import {
  computePanelId,
  derivePanelOperationIdentity,
  panelIdSegmentFromName,
} from "@vibestudio/shared/panelIdUtils";
import { browserSourceFromHostname, generateContextId } from "@vibestudio/shared/panelFactory";
import { validateStateArgs } from "@vibestudio/shared/stateArgsValidator";
import {
  panelFailure,
  panelFailureFromError,
  PanelOperationError,
  rethrowPanelOperationError,
  type PanelDiagnosticPacket,
  type PanelObservation,
  type PanelSnapshotObservation,
} from "@vibestudio/shared/panel/observation";
import type {
  PanelFocusOptions,
  PanelHandle,
  PanelNavigateOptions,
  PanelWaitOptions,
} from "../core/index.js";
import { createCdpAutomation, type CdpAutomation } from "../panel/cdpAutomation.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "./handles.js";
import { readPanelStateArgs, updatePanelStateArgs } from "./panelStateArgsPersistence.js";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { callWorkspaceState, createRuntimeWorkspaceStateClient } from "./workspaceStateClient.js";
import {
  commitPreparedPanelNavigation,
  type PanelNavigationCommitResult,
  type PanelNavigationTransactionClients,
} from "@vibestudio/shell-core/panelNavigationTransaction";

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

interface EnsurePanelSlotResult {
  status: "assigned" | "already-held" | "mobile-held" | "unavailable";
  lease: {
    holderLabel: string;
    platform: "desktop" | "headless" | "mobile";
    supportsCdp: boolean;
  } | null;
}

const BROWSER_READY_STABILITY_DELAY_MS = 50;

/**
 * Does the loaded browser document belong to the requested navigation?
 *
 * Redirects are normal document loads, not foreign documents: http→https
 * upgrades, trailing-slash normalization, and in-site auth bounces all land on
 * the requested site with a different href. Matching the full href would keep
 * such a panel "loading" forever, so site-addressed sources match at host
 * granularity. Null-origin sources (data:, blob:, about:) carry no host and
 * still require the exact document — that is what excludes the pre-navigation
 * about:blank view.
 */
function browserDocumentMatchesSource(viewUrl: string, source: string): boolean {
  const requestedUrl = browserUrlFromPanelSource(source);
  if (!requestedUrl || !viewUrl) return false;
  let view: URL;
  let requested: URL;
  try {
    view = new URL(viewUrl);
    requested = new URL(requestedUrl);
  } catch {
    // Not every embedded URL is accepted by URL implementations identically.
    // Exact equality is still safer than declaring an unrelated document ready.
    return viewUrl === requestedUrl;
  }
  if (requested.hostname !== "") {
    return view.hostname === requested.hostname;
  }
  return view.href === requested.href;
}

/** Lifecycle-poll delay that rejects promptly when the caller aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CreatePanelSlotOptions {
  parentId?: string | null;
  /** Display title, overriding the manifest's. Free text; carries no identity. */
  title?: string;
  /**
   * Opt-in stable id segment, making the panel `{parentId}/{slug}`. The caller
   * owns uniqueness; never derive it from a title or other user-controlled text.
   */
  slug?: string;
  /** Stable identity for one logical open. Reuse resumes the same slot/entity. */
  operationId?: string;
  contextId?: string;
  ref?: string;
  stateArgs?: Record<string, unknown>;
  /** Per-call visual placement override; wins over the target manifest default. */
  placement?: PanelPlacementHint;
}

export interface OpenPanelOptions extends CreatePanelSlotOptions {
  /** Present and focus the new panel (default true); false still waits for readiness. */
  focus?: boolean;
  /** Cancel this readiness observation without rolling back the committed slot. */
  signal?: AbortSignal;
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
  navigateHistory(
    id: string,
    delta: -1 | 1,
    options?: PanelWaitOptions
  ): Promise<PanelObservation | null>;
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
  /** Commit an executable, unloaded slot without allocating a presentation lease. */
  createPanelSlot(source: string, options?: CreatePanelSlotOptions): Promise<PanelHandle>;
  /** Create, present, and wait for the selected runtime attempt to become ready. */
  openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle>;
  getPanelHandle(id: string, kind?: "workspace" | "browser"): PanelHandle;
  fromMetadata(metadata: PanelHandleMetadata): PanelHandle;
}

export interface CreatePanelRuntimeOptions {
  rpc: Pick<RpcClient, "call" | "emit" | "on">;
  /** Focus a live panel when this runtime has a native presentation host. */
  focusPanel?: (id: string, options?: PanelFocusOptions) => Promise<void>;
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
  /** Host-side timing sink for durable panel creation stages. */
  onCreateSlotTiming?: (event: {
    panelId: string;
    kind: "workspace" | "browser";
    stage:
      | "runtime.createEntity"
      | "runtime.reserveEntity"
      | "workspace-state.slot.create"
      | "runtime.activateReservedEntity"
      | "panel.updateTitle";
    durationMs: number;
    outcome: "ok" | "error";
  }) => void;
}

export function createPanelRuntime(options: CreatePanelRuntimeOptions): PanelRuntimeApi {
  const metadataCache = new Map<string, PanelHandleMetadata>();
  const callState = <T>(method: string, args: unknown[]): Promise<T> =>
    callWorkspaceState<T>(options.rpc, method, args);
  const workspaceState = createRuntimeWorkspaceStateClient(options.rpc);
  const navigationClients: PanelNavigationTransactionClients = {
    runtime: {
      retireEntity: (id) => options.rpc.call("main", "runtime.retireEntity", [{ id }]),
    },
    workspaceState: {
      commitPreparedNavigation: (input) => workspaceState.commitPreparedNavigation(input),
    },
  };
  const reportNavigationCleanup = (result: PanelNavigationCommitResult): void => {
    if (result.retirement.status !== "failed") return;
    const error = result.retirement.error;
    console.warn(
      `[panel.navigate] Runtime ${result.previousEntityId} was displaced but could not be retired: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  };
  const callPanelState = async <T>(method: string, args: unknown[]): Promise<T> => {
    try {
      const read = {
        rootGroups: () => workspaceState.getPanelTreeRootGroups(args[0] as never),
        page: () => workspaceState.getPanelTreePage(args[0] as never),
        path: () => workspaceState.getPanelTreePath(asPanelSlotId(String(args[0]))),
        detail: () => workspaceState.getPanelDetail(asPanelSlotId(String(args[0]))),
        search: () => workspaceState.searchPanelTree(args[0] as never),
      }[method];
      if (!read) throw new Error(`Unknown workspace-state panel read: ${method}`);
      return (await read()) as T;
    } catch (error) {
      rethrowPanelOperationError(error);
    }
  };
  const callView = <T>(method: string, args: unknown[]): Promise<T> =>
    options.rpc.call<T>("main", `view.${method}`, args);
  const ensurePanelMaterialized = async (id: string): Promise<void> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    const result = await options.rpc.call<EnsurePanelSlotResult>(
      "main",
      "panelRuntime.ensureSlot",
      [id, detail.entity.id]
    );
    if (result.status === "assigned" || result.status === "already-held") return;
    const holder = result.lease?.holderLabel;
    throw new PanelOperationError(
      panelFailure({
        code: "host_unavailable",
        stage: "host",
        message:
          result.status === "mobile-held"
            ? `Panel ${id} is currently presented by ${holder ?? "a mobile host"}, which cannot serve programmatic inspection`
            : `No presentation host is available for panel ${id}`,
        provenance: {
          panelId: id,
          runtimeEntityId: detail.entity.id,
          attemptId: `${detail.entity.id}@${detail.entity.activeBuildKey ?? "pending"}`,
          source: detail.currentHistory.source,
          contextId: detail.currentHistory.context_id,
          requestedRef:
            (detail.currentHistory.options
              ? (JSON.parse(detail.currentHistory.options) as { ref?: string }).ref
              : undefined) ?? "latest",
          effectiveVersion: detail.entity.source.effectiveVersion,
          buildKey: detail.entity.activeBuildKey ?? null,
        },
        details: { ensureStatus: result.status },
      })
    );
  };
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
        view: {
          url: string;
          loading: boolean;
        };
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
    const source = detail.currentHistory.source;
    const boot = runtime.observation?.boot;
    // External browser panels do not execute Vibestudio's managed bootstrap,
    // so their boot handshake is intentionally unavailable.  The browser
    // document itself is the readiness contract for those panels; requiring a
    // managed boot phase here leaves every data/http panel in an endless
    // loading state even though its CDP target and document are usable.
    const browserDocumentReady =
      isBrowserPanelSource(source) &&
      runtime.observation !== null &&
      runtime.observation.view.loading === false &&
      browserDocumentMatchesSource(runtime.observation.view.url, source);
    const phase = !runtime.lease
      ? ("assigning-host" as const)
      : browserDocumentReady
        ? ("ready" as const)
        : !boot || boot.phase === "unavailable" || boot.phase === "loading"
          ? ("loading" as const)
          : boot.phase;
    const updatedAt = boot?.updatedAt ?? Date.now();
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
                      url: runtime.observation.view.url,
                      loading: runtime.observation.view.loading,
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

  for (const metadata of options.initialMetadata ?? []) {
    rememberMetadata(metadata);
  }

  const waitUntilReady = async (
    initial: PanelObservation,
    signal?: AbortSignal
  ): Promise<PanelObservation> => {
    let observation = initial;
    let stableBrowserIdentity: string | null = null;
    let pollDelayMs = 50;
    for (;;) {
      signal?.throwIfAborted();
      if (observation.phase === "failed" && observation.failure) {
        throw new PanelOperationError(observation.failure);
      }
      if (observation.phase === "stopped") {
        throw new Error(`Panel ${observation.panelId} stopped before it became ready`);
      }
      if (observation.phase === "ready") {
        if (!isBrowserPanelSource(observation.source)) return observation;
        const browserIdentity = [
          observation.runtimeEntityId ?? "",
          observation.attemptId ?? "",
          observation.source,
        ].join("\0");
        if (stableBrowserIdentity === browserIdentity) return observation;
        // External-document readiness is a native navigation boundary. Require
        // the same incarnation to remain ready across one host refresh so the
        // caller cannot obtain a CDP page in the gap between a false loading
        // sample and the subsequent navigation event.
        stableBrowserIdentity = browserIdentity;
        await abortableDelay(BROWSER_READY_STABILITY_DELAY_MS, signal);
        observation = await observePanel(observation.panelId);
        continue;
      }
      stableBrowserIdentity = null;
      await abortableDelay(pollDelayMs, signal);
      pollDelayMs = Math.min(pollDelayMs * 2, 500);
      observation = await observePanel(observation.panelId);
    }
  };

  const closePanel = async (id: string): Promise<PanelLifecycleResult> => {
    const closed = await workspaceState.closeSlot(asPanelSlotId(id));
    for (;;) {
      const page = await workspaceState.getCloseCleanupPage({
        closeId: closed.closeId,
        limit: 200,
      });
      if (page.items.length === 0) break;
      for (const item of page.items) {
        if (item.entityId) {
          await options.rpc.call("main", "runtime.retireEntity", [{ id: item.entityId }]);
        }
      }
      await workspaceState.acknowledgeCloseCleanup(
        page.items.map((item) => asPanelSlotId(item.slotId))
      );
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
        } | null>("main", "build.getPanelMetadata", [
          source,
          navigateOptions?.ref ??
            `ctx:${navigateOptions?.contextId ?? current.currentHistory.context_id}`,
        ]);
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
    const transition = await commitPreparedPanelNavigation(navigationClients, {
      slotId: asPanelSlotId(id),
      expectedCurrentEntityId: asPanelEntityId(current.entity.id),
      mutation: {
        kind: historyMode,
        entry: {
          entryKey,
          entityId: asPanelEntityId(next.id),
          source: historySource,
          contextId,
          stateArgs,
          options: {
            ...(nextEnv ? { env: nextEnv } : {}),
            ...(navigateOptions?.ref ? { ref: navigateOptions.ref } : {}),
          },
        },
      },
    });
    reportNavigationCleanup(transition);
    const title =
      normalizePanelTitle(
        external
          ? new URL(source).hostname || new URL(source).protocol.replace(/:$/, "") || "browser"
          : (panelMetadata?.title ?? source)
      ) ?? "panel";
    await callState("panel.updateTitle", [id, title, { explicit: false }]);
    await ensurePanelMaterialized(id);
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
    return waitUntilReady(observation, navigateOptions?.signal);
  };

  const navigateHistory = async (
    id: string,
    delta: -1 | 1,
    waitOptions?: PanelWaitOptions
  ): Promise<PanelObservation | null> => {
    const current = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!current) throw new Error(`Unknown panel slot: ${id}`);
    const target = await callState<{
      entry_key: string;
      entity_id: string;
      source: string;
      context_id: string;
      state_args: string | null;
      options: string | null;
    } | null>("slot.historyRelative", [id, delta]);
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
    const transition = await commitPreparedPanelNavigation(navigationClients, {
      slotId: asPanelSlotId(id),
      expectedCurrentEntityId: asPanelEntityId(current.entity.id),
      mutation: { kind: "select", entryKey: target.entry_key },
    });
    reportNavigationCleanup(transition);
    await ensurePanelMaterialized(id);
    const observation = await observePanel(id);
    return waitUntilReady(observation, waitOptions?.signal);
  };

  const restartPanel = async (id: string): Promise<void> => {
    const detail = await callPanelState<WorkspacePanelDetail | null>("detail", [id]);
    if (!detail) throw new Error(`Unknown panel slot: ${id}`);
    await ensurePanelMaterialized(id);
    await options.rpc.call("main", "runtime.supervision.restart", [
      { kind: "panel", entityId: detail.entity.id },
    ]);
  };

  const rebuildPanel = async (
    id: string,
    waitOptions?: PanelWaitOptions
  ): Promise<PanelObservation> => {
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
        ...(waitOptions?.signal ? { signal: waitOptions.signal } : {}),
      },
      "replace"
    );
  };

  const panelAgentRouteFailure = (
    id: string,
    observation: PanelObservation,
    error: unknown,
    details: Record<string, unknown>
  ): PanelOperationError =>
    new PanelOperationError(
      panelFailure({
        code: "host_unavailable",
        stage: "runtime",
        message: `Panel ${id} runtime target ${observation.runtimeEntityId ?? "unassigned"} is not reachable`,
        provenance: {
          panelId: id,
          runtimeEntityId: observation.runtimeEntityId,
          attemptId: observation.attemptId,
          source: observation.source,
          contextId: observation.contextId,
          requestedRef: observation.requestedRef,
          effectiveVersion: observation.effectiveVersion,
          buildKey: observation.buildKey,
        },
        details,
      }),
      error
    );

  const rpcErrorCode = (error: unknown): string | null => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
  };

  const invokeReadyPanelAgent = async <T>(
    id: string,
    method: string,
    args: unknown[],
    waitOptions?: PanelWaitOptions
  ): Promise<{ observation: PanelObservation; runtimeEntityId: string; result: T }> => {
    await ensurePanelMaterialized(id);
    let observation = await waitUntilReady(await observePanel(id), waitOptions?.signal);
    if (!observation.runtimeEntityId) throw new Error(`Panel ${id} has no runtime entity`);
    const expectedRuntimeEntityId = observation.runtimeEntityId;
    try {
      return {
        observation,
        runtimeEntityId: expectedRuntimeEntityId,
        result: (await options.rpc.call(expectedRuntimeEntityId, method, args)) as T,
      };
    } catch (error) {
      const errorCode = rpcErrorCode(error);
      if (errorCode !== "TARGET_NOT_REACHABLE" && errorCode !== "RECONNECT_GRACE_EXPIRED") {
        throw error;
      }
      const current = await observePanel(id);
      if (!current.runtimeEntityId || current.runtimeEntityId === expectedRuntimeEntityId) {
        throw panelAgentRouteFailure(id, current, error, {
          agentMethod: method,
          routeFailureCode: errorCode,
          expectedRuntimeEntityId,
          currentRuntimeEntityId: current.runtimeEntityId,
          currentAttemptId: current.attemptId,
          recovery: "not-attempted-same-runtime",
        });
      }
      // The slot demonstrably advanced after the readiness observation. Wait
      // for that exact replacement attempt, then invoke it once. This is not a
      // transport retry of the failed target and never creates another panel.
      observation = await waitUntilReady(current, waitOptions?.signal);
      const replacementRuntimeEntityId = observation.runtimeEntityId;
      if (!replacementRuntimeEntityId) throw new Error(`Panel ${id} has no runtime entity`);
      try {
        return {
          observation,
          runtimeEntityId: replacementRuntimeEntityId,
          result: (await options.rpc.call(replacementRuntimeEntityId, method, args)) as T,
        };
      } catch (replacementError) {
        throw panelAgentRouteFailure(id, observation, replacementError, {
          agentMethod: method,
          routeFailureCode: rpcErrorCode(replacementError),
          expectedRuntimeEntityId,
          replacementRuntimeEntityId,
          replacementAttemptId: observation.attemptId,
          recovery: "replacement-route-failed",
        });
      }
    }
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
    return (await invokeReadyPanelAgent(id, method, args)).result;
  };

  const snapshotPanel = async (
    id: string,
    waitOptions?: PanelWaitOptions
  ): Promise<PanelSnapshotObservation> => {
    const {
      observation,
      runtimeEntityId,
      result: document,
    } = await invokeReadyPanelAgent<{
      kind: "synth";
      text: string;
      structure: Record<string, unknown>;
    }>(id, "_agent.snapshot", [], waitOptions);
    return {
      panelId: id,
      attemptId: observation.attemptId,
      runtimeEntityId,
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
    return { observation, consoleHistory };
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
    reload: async (id, waitOptions) => {
      await restartPanel(id);
      const result = await waitUntilReady(await observePanel(id), waitOptions?.signal);
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
      callState("panel.updateTitle", [id, normalizePanelTitle(title) ?? "", titleOptions]),
    navigate: async (id, source, navigateOptions) => {
      return navigatePanel(id, source, navigateOptions);
    },
    movePanel: (id, newParentId, placement) =>
      workspaceState.moveSlot(
        asPanelSlotId(id),
        newParentId === null ? null : asPanelSlotId(newParentId),
        placement
      ),
    takeOver: async (id) => {
      await options.rpc.call("main", "panelRuntime.takeOverSlot", [id]);
      await options.focusPanel?.(id);
    },
    openDevTools: (id, mode) => callView("openPanelDevTools", [id, mode]),
    rebuild: async (id, waitOptions) => {
      const result = await rebuildPanel(id, waitOptions);
      options.onReload?.(id);
      return result;
    },
    focus: async (id, focusOptions) => {
      const anchorPanelId = focusOptions?.anchorPanelId ?? requesterPanelId();
      const resolved: PanelFocusOptions = {
        ...(focusOptions?.placement ? { placement: focusOptions.placement } : {}),
        ...(anchorPanelId ? { anchorPanelId } : {}),
      };
      if (options.focusPanel) await options.focusPanel(id, resolved);
      else await ensurePanelMaterialized(id);
      return waitUntilReady(await observePanel(id), focusOptions?.signal);
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
      return navigatePanel(id, source, navigateOptions);
    },
    navigateHistory(id, delta, waitOptions) {
      return navigateHistory(id, delta, waitOptions);
    },
  };

  const createPanelSlot = async (
    source: string,
    openOptions?: CreatePanelSlotOptions
  ): Promise<PanelHandle> => {
    if (openOptions?.slug && openOptions.operationId) {
      throw new Error("Panel creation accepts either slug or operationId, not both");
    }
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
    const requestedContextId = openOptions?.contextId?.trim() || undefined;
    const operationIdentity = openOptions?.operationId
      ? await derivePanelOperationIdentity({
          operationId: openOptions.operationId,
          source,
          contextId: requestedContextId,
          parentId,
          ref: openOptions.ref,
        })
      : undefined;
    const operationSegment = operationIdentity?.operationSegment;
    const id = computePanelId({
      relativePath: identitySource,
      parent: parentId ? { id: parentId } : null,
      ...(openOptions?.slug
        ? { requestedId: panelIdSegmentFromName(openOptions.slug) }
        : operationSegment
          ? { requestedId: operationSegment }
          : {}),
      isRoot: parentId == null,
    });
    const entryKey = operationIdentity?.entryKey ?? `nav-${crypto.randomUUID()}`;
    const panelKind = external ? ("browser" as const) : ("workspace" as const);
    const timed = async <T>(
      stage:
        | "runtime.createEntity"
        | "runtime.reserveEntity"
        | "workspace-state.slot.create"
        | "runtime.activateReservedEntity"
        | "panel.updateTitle",
      operation: () => Promise<T>
    ): Promise<T> => {
      const startedAt = Date.now();
      try {
        const result = await operation();
        options.onCreateSlotTiming?.({
          panelId: id,
          kind: panelKind,
          stage,
          durationMs: Date.now() - startedAt,
          outcome: "ok",
        });
        return result;
      } catch (error) {
        options.onCreateSlotTiming?.({
          panelId: id,
          kind: panelKind,
          stage,
          durationMs: Date.now() - startedAt,
          outcome: "error",
        });
        throw error;
      }
    };
    const contextId = requestedContextId ?? (external ? generateContextId(id) : undefined);
    const panelMetadata = external
      ? null
      : await options.rpc.call<{
          title?: string;
          stateArgs?: unknown;
          autoArchiveWhenEmpty?: boolean;
        } | null>("main", "build.getPanelMetadata", [
          source,
          openOptions?.ref ?? (contextId ? `ctx:${contextId}` : undefined),
        ]);
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
    let runtimeEntity = await timed(
      external ? "runtime.createEntity" : "runtime.reserveEntity",
      () =>
        external
          ? options.rpc.call<RuntimePanelEntity>("main", "runtime.createEntity", [entitySpec])
          : options.rpc.call<RuntimePanelEntity>("main", "runtime.reserveEntity", [entitySpec])
    );
    const historySource = external ? `browser:${source}` : source;
    let slotCommitted = false;
    const rethrowCommittedFailure = (error: unknown): never => {
      if (error instanceof PanelOperationError) throw error;
      const remoteFailure = panelFailureFromError(error);
      if (remoteFailure) throw new PanelOperationError(remoteFailure, error);
      throw new PanelOperationError(
        panelFailure({
          code: "unknown_failure",
          stage: "runtime",
          message: `Panel ${id} was created, but the post-commit operation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          provenance: {
            panelId: id,
            runtimeEntityId: runtimeEntity.id,
            source: historySource,
            contextId: runtimeEntity.contextId,
            requestedRef: openOptions?.ref ?? "latest",
            effectiveVersion: runtimeEntity.source.effectiveVersion || null,
            buildKey: runtimeEntity.buildKey ?? null,
          },
          details: { slotCommitted: true },
        }),
        error
      );
    };
    try {
      await timed("workspace-state.slot.create", () =>
        workspaceState.createSlot({
          slotId: asPanelSlotId(id),
          parentSlotId: parentId === null ? null : asPanelSlotId(parentId),
          initialEntry: {
            entryKey,
            entityId: asPanelEntityId(runtimeEntity.id),
            source: historySource,
            contextId: runtimeEntity.contextId,
            stateArgs,
            options: {
              ...(openOptions?.ref ? { ref: openOptions.ref } : {}),
              ...(openOptions?.placement ? { placement: openOptions.placement } : {}),
            },
          },
        })
      );
      slotCommitted = true;
    } catch (error) {
      if (slotCommitted) rethrowCommittedFailure(error);
      // The slot write may have committed even when its response was lost.
      // Reservations are durable and garbage-collected; retiring here can
      // destroy the entity referenced by an idempotently resumed live slot.
      throw error;
    }
    try {
      // A code panel is a two-phase publication: its stable entity coordinate
      // is reserved first, then the slot commits that coordinate, and only then
      // may the sealed execution become active. Drive that protocol here just
      // as the host shell does. Slot observation remains crash recovery; it is
      // not the success path and panel creation must not depend on a pub/sub
      // notification being observed at exactly the right moment.
      if (!external) {
        runtimeEntity = await timed("runtime.activateReservedEntity", () =>
          options.rpc.call<RuntimePanelEntity>("main", "runtime.activateReservedEntity", [
            entitySpec,
          ])
        );
      }
      const explicitTitle = normalizePanelTitle(openOptions?.title);
      const title =
        explicitTitle ??
        normalizePanelTitle(panelMetadata?.title) ??
        normalizePanelTitle(parsedUrl?.hostname) ??
        normalizePanelTitle(parsedUrl?.protocol.replace(/:$/, "")) ??
        normalizePanelTitle(source) ??
        "panel";
      await timed("panel.updateTitle", () =>
        callState("panel.updateTitle", [id, title, { explicit: explicitTitle !== undefined }])
      );
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
      return panelHandle;
    } catch (error) {
      return rethrowCommittedFailure(error);
    }
  };

  const openPanel = async (
    source: string,
    openOptions?: OpenPanelOptions
  ): Promise<PanelHandle> => {
    const panelHandle = await createPanelSlot(source, openOptions);
    let observation: PanelObservation | null = null;
    try {
      if (openOptions?.focus !== false) {
        const anchorPanelId = requesterPanelId();
        const focusOptions: PanelFocusOptions = {
          ...(openOptions?.placement ? { placement: openOptions.placement } : {}),
          ...(anchorPanelId ? { anchorPanelId } : {}),
        };
        if (options.focusPanel) await options.focusPanel(panelHandle.id, focusOptions);
        else await ensurePanelMaterialized(panelHandle.id);
        observation = await waitUntilReady(await observePanel(panelHandle.id), openOptions?.signal);
      } else {
        await ensurePanelMaterialized(panelHandle.id);
        observation = await waitUntilReady(await observePanel(panelHandle.id), openOptions?.signal);
      }
    } catch (error) {
      if (error instanceof PanelOperationError) throw error;
      const remoteFailure = panelFailureFromError(error);
      if (remoteFailure) throw new PanelOperationError(remoteFailure, error);
      const committedMetadata = metadataCache.get(panelHandle.id);
      throw new PanelOperationError(
        panelFailure({
          code: "unknown_failure",
          stage: "runtime",
          message: `Panel ${panelHandle.id} was created, but readiness could not be determined: ${
            error instanceof Error ? error.message : String(error)
          }`,
          provenance: {
            panelId: panelHandle.id,
            runtimeEntityId: observation?.runtimeEntityId ?? committedMetadata?.rpcTargetId,
            ...(observation?.attemptId ? { attemptId: observation.attemptId } : {}),
            source: observation?.source ?? panelHandle.source,
            contextId: observation?.contextId ?? committedMetadata?.contextId ?? "",
            requestedRef: observation?.requestedRef ?? committedMetadata?.ref ?? "latest",
            effectiveVersion: observation?.effectiveVersion ?? committedMetadata?.effectiveVersion,
            buildKey: observation?.buildKey ?? committedMetadata?.buildKey,
          },
          details: {
            slotCommitted: true,
            ...(observation ? { lastPhase: observation.phase } : {}),
          },
        }),
        error
      );
    }
    const readyMetadata = await readMetadata(panelHandle.id);
    return readyMetadata
      ? fromMetadata({
          id: panelHandle.id,
          title: readyMetadata.title,
          source: readyMetadata.source,
          kind: readyMetadata.kind,
          parentId: readyMetadata.parentId,
          contextId: readyMetadata.contextId,
          rpcTargetId: readyMetadata.runtimeEntityId,
          effectiveVersion: readyMetadata.effectiveVersion,
          buildKey: readyMetadata.buildKey,
          ref: readyMetadata.ref,
        })
      : panelHandle;
  };

  return {
    panelTree,
    createPanelSlot,
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
