/**
 * Shell Client - Typed wrappers for shell service calls via RPC.
 *
 * This module provides a typed API for shell to call main process services.
 * Uses a direct @workspace/rpc bridge from the shell transport global.
 */
import {
  createRpcClient,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { appMethods } from "@vibestudio/service-schemas/app";
import {
  accountMethods,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/service-schemas/account";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { HostLaunchClient } from "@vibestudio/service-schemas/clients/hostLaunchClient";
import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { menuMethods, type PanelContextPresentation } from "@vibestudio/service-schemas/menu";
import { notificationMethods } from "@vibestudio/service-schemas/notification";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import { createPanelRuntime } from "@workspace/runtime/panel-runtime";
import {
  remoteCredMethods,
  type RemoteCredCurrent as RemoteCredCurrentContract,
} from "@vibestudio/service-schemas/remoteCred";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { shellPresenceMethods } from "@vibestudio/service-schemas/shellPresence";
import { autofillMethods } from "@vibestudio/service-schemas/autofill";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { buildMethods } from "@vibestudio/service-schemas/build";
import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { viewMethods } from "@vibestudio/service-schemas/view";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import {
  runtimeMethods,
  type RuntimeSupervisionEntityKey,
} from "@vibestudio/service-schemas/runtime";
import { workspaceStateMethods } from "@vibestudio/service-schemas/workspaceState";
import {
  vcsMethods,
  type VcsCompareResult,
  type VcsIntegrationChoice,
} from "@vibestudio/service-schemas/vcs";
import {
  hubControlMethods,
  type HubDevice,
  type HubPairingInvite,
} from "@vibestudio/service-schemas/hubControl";
import { workspacePresenceMethods } from "@vibestudio/service-schemas/workspacePresence";
import { browserEnvironmentMethods } from "@vibestudio/service-schemas/browserEnvironment";
import { createBrowserDataClient } from "@vibestudio/browser-data/client";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  createDurableObjectServiceClient,
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
import type { ChannelInvite } from "@vibestudio/shared/channelInvites";
import {
  channelInviteFromNotification,
  type UserNotification,
  type UserNotificationAcknowledgementResult,
  type UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import type { PanelLocation } from "@vibestudio/shared/panelLocation";
import type { PanelPlacementHint } from "@vibestudio/shared/types";
import { decodePanelStateArgs } from "@vibestudio/shared/panelStateArgs";
import {
  browserUrlFromPanelSource,
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type BrowserHistoryAddressRow,
} from "@vibestudio/shared/panelChrome";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { createTemplateManagementClient } from "@workspace/template-management";
// Type for the shell transport bridge injected by the preload script
type ShellTransportBridge = {
  send: (envelope: RpcEnvelope) => Promise<void>;
  onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
};
type IncomingPairLinkBridge = {
  getPending: () => Promise<ConnectPairing | null>;
  onLink: (handler: (link: ConnectPairing) => void) => () => void;
};
type IncomingPanelLocationBridge = {
  getPending: () => Promise<PanelLocation | null>;
  onLocation: (handler: (location: PanelLocation) => void) => () => void;
  prepareWorkspaceRelaunch: (location: PanelLocation | null) => Promise<void>;
};
const g = globalThis as unknown as {
  __vibestudioTransport?: ShellTransportBridge;
  __vibestudioIncomingPairLink?: IncomingPairLinkBridge;
  __vibestudioIncomingPanelLocation?: IncomingPanelLocationBridge;
};
if (!g.__vibestudioTransport) throw new Error("Shell transport not available");
const transport: EnvelopeRpcTransport = {
  send: (envelope) => assertPresent(g.__vibestudioTransport).send(envelope),
  onMessage: (handler) => assertPresent(g.__vibestudioTransport).onMessage(handler),
  status: () => "connected",
  ready: () => Promise.resolve(),
  onStatusChange: () => () => {},
};
const rpc: RpcClient = createRpcClient({
  selfId: "shell",
  callerKind: "shell",
  transport,
});

const nativeSlotProtocolStateKey = "__vibestudioNativeSlotProtocolState";
const nativeSlotProtocolGlobal = globalThis as typeof globalThis & {
  [nativeSlotProtocolStateKey]?: { rendererInstanceId: string; nextBindingSequence: number };
};
const nativeSlotProtocolState = (nativeSlotProtocolGlobal[nativeSlotProtocolStateKey] ??= {
  rendererInstanceId:
    globalThis.crypto?.randomUUID?.() ??
    `shell-renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  nextBindingSequence: 0,
});

/** Stable across component remounts/HMR and replaced by a full renderer document reload. */
export const nativeSlotRendererInstanceId = nativeSlotProtocolState.rendererInstanceId;
export function nextNativeSlotBindingSequence(): number {
  return ++nativeSlotProtocolState.nextBindingSequence;
}
export const hostLaunch = new HostLaunchClient((service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const shellApprovalClient = createTypedServiceClient(
  "shellApproval",
  shellApprovalMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const shellPresenceClient = createTypedServiceClient(
  "shellPresence",
  shellPresenceMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const appClient = createTypedServiceClient("app", appMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const accountClient = createTypedServiceClient("account", accountMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
// Electron chrome owns a distinct event domain that projects workspace events
// together with native host state. Other runtimes use the canonical `events`.
const eventsClient = new EventsClient(rpc, undefined, "desktopEvents");
const extensionsClient = createTypedServiceClient(
  "extensions",
  extensionsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const browserDataClient = createBrowserDataClient({
  callService: (service, method, args) => rpc.call("main", `${service}.${method}`, args),
  callTarget: (targetId, method, args) => rpc.call(targetId, method, args),
});
const browserEnvironmentClient = createTypedServiceClient(
  "browserEnvironment",
  browserEnvironmentMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const menuClient = createTypedServiceClient("menu", menuMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const productPanelRuntime = createPanelRuntime({ rpc });
const focusPanel = async (panelId: string): Promise<PanelFocusResult> => {
  await productPanelRuntime.panelTree.get(panelId).focus();
  return {
    panelId,
    status: "loaded",
    focused: true,
    loaded: true,
  };
};
const notificationClient = createTypedServiceClient(
  "notification",
  notificationMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const remoteCredClient = createTypedServiceClient(
  "remoteCred",
  remoteCredMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const autofillClient = createTypedServiceClient(
  "autofill",
  autofillMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const viewClient = createTypedServiceClient("view", viewMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const workspaceClient = createTypedServiceClient(
  "workspace",
  workspaceMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const runtimeClient = createTypedServiceClient("runtime", runtimeMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const buildClient = createTypedServiceClient("build", buildMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const workspaceStateClient = createTypedServiceClient(
  "workspace-state",
  workspaceStateMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const panelRuntimeClient = createTypedServiceClient(
  "panelRuntime",
  panelRuntimeMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const vcsClient = createTypedServiceClient("vcs", vcsMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const hubControlClient = createTypedServiceClient(
  "hubControl",
  hubControlMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const blobstoreClient = createTypedServiceClient(
  "blobstore",
  blobstoreMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const credentialsClient = createTypedServiceClient(
  "credentials",
  credentialsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const workspacePresenceClient = createTypedServiceClient(
  "workspacePresence",
  workspacePresenceMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
import type {
  ThemeMode,
  ThemeAppearance,
  ThemeConfig,
  PanelFocusResult,
  MovePanelRequest,
  PaletteCommand,
} from "@vibestudio/shared/types";
import type { BrowserNavigationIntent } from "@vibestudio/shared/panelCommands";
// =============================================================================
// App Service
// =============================================================================
export const app = {
  getInfo: () => appClient.getInfo(),
  getSystemTheme: () => appClient.getSystemTheme(),
  setThemeMode: (mode: ThemeMode) => appClient.setThemeMode(mode),
  openDevTools: () => appClient.openDevTools(),
  openExternal: (url: string) => appClient.openExternal(url),
  clearBuildCache: () => appClient.clearBuildCache(),
  applyUpdate: (appId: string) => appClient.applyUpdate(appId),
  listPendingUpdates: () => appClient.listPendingUpdates(),
};

async function collectBrowserSessionRows(): Promise<BrowserHistoryAddressRow[]> {
  const profile = await accountClient.getProfile();
  if (!profile?.userId) return [];
  const rows: BrowserHistoryAddressRow[] = [];
  const groups: Array<Parameters<typeof workspaceStateClient.panelTree.page>[0]["group"]> = [
    { kind: "roots", ownerUserId: profile.userId },
  ];
  while (groups.length > 0) {
    const group = groups.shift()!;
    let cursor: string | undefined;
    do {
      const page = await workspaceStateClient.panelTree.page({
        group,
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      for (const node of page.nodes) {
        if (node.childCount > 0) {
          groups.push({ kind: "children", parentSlotId: node.slotId });
        }
        const sourceUrl = node.source ? browserUrlFromPanelSource(node.source) : null;
        if (!sourceUrl) continue;
        const chrome = await viewClient.getChromeState(node.slotId).catch(() => null);
        rows.push({
          url: chrome?.kind === "browser" ? chrome.resolvedUrl || sourceUrl : sourceUrl,
          title: chrome?.kind === "browser" ? chrome.title : node.title,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return rows;
}

async function getPanelStateArgs(panelId: string): Promise<Record<string, unknown>> {
  const detail = await workspaceStateClient.panelTree.detail(panelId);
  if (!detail) throw new Error(`Panel not found: ${panelId}`);
  return decodePanelStateArgs(detail.currentHistory.state_args);
}

// =============================================================================
// Panel Service
// =============================================================================
export const panel = {
  getRootGroups: (input: Parameters<typeof workspaceStateClient.panelTree.rootGroups>[0]) =>
    workspaceStateClient.panelTree.rootGroups(input),
  getTreePage: (input: Parameters<typeof workspaceStateClient.panelTree.page>[0]) =>
    workspaceStateClient.panelTree.page(input),
  getTreePath: (panelId: string) => workspaceStateClient.panelTree.path(panelId),
  searchTree: (input: Parameters<typeof workspaceStateClient.panelTree.search>[0]) =>
    workspaceStateClient.panelTree.search(input),
  observe: (panelId: string) => productPanelRuntime.panelTree.get(panelId).observe(),
  getPresentation: (panelId: string) => viewClient.getPresentation(panelId),
  getFocusedPanelId: () => viewClient.getFocusedPanelId(),
  setFocusedPanelId: (panelId: string) => viewClient.setFocusedPanelId(panelId),
  focus: focusPanel,
  /** Per-device persisted PanelLayout (validated/pruned again shell-side on restore). */
  getPanelLayout: () => viewClient.getPanelLayout(),
  savePanelLayout: (layout: Parameters<typeof viewClient.savePanelLayout>[0]) =>
    viewClient.savePanelLayout(layout),
  ensureLoaded: (panelId: string) => viewClient.ensurePanelLoaded(panelId),
  updateTheme: (theme: ThemeAppearance) => viewClient.updateTheme(theme),
  updateThemeConfig: (config: ThemeConfig) => viewClient.updateThemeConfig(config),
  openDevTools: (panelId: string) => viewClient.openPanelDevTools(panelId),
  getChromeState: (panelId: string) => viewClient.getChromeState(panelId),
  getRuntimeLease: async (panelId: string) => {
    const detail = await workspaceStateClient.panelTree.detail(panelId);
    if (!detail) return null;
    const snapshot = await panelRuntimeClient.getSnapshot();
    return snapshot.leases.find((lease) => lease.runtimeEntityId === detail.entity.id) ?? null;
  },
  takeOver: (panelId: string) => productPanelRuntime.panelTree.get(panelId).takeOver(),
  togglePin: (panelId: string) => viewClient.togglePin(panelId),
  listPinnedPanelIds: () => viewClient.listPinnedPanelIds(),
  getAddressOptions: (source: string) =>
    getSharedPanelAddressOptions({
      source,
      repoProvider: { sourceTree: () => workspaceClient.sourceTree() },
    }),
  getBrowserAddressOptions: async (query: string) =>
    getSharedBrowserAddressOptions({
      query,
      sessionRows: await collectBrowserSessionRows(),
      browserData: {
        searchHistoryForAutocomplete: (value, limit) =>
          browserDataClient.searchHistoryForAutocomplete(value, limit),
        getHistory: (input) => browserDataClient.getHistory(input),
        searchBookmarks: (value) => browserDataClient.searchBookmarks(value),
        getSearchEngines: () => browserDataClient.getSearchEngines(),
      },
    }),
  markBrowserNavigationIntent: (panelId: string, intent: BrowserNavigationIntent) =>
    viewClient.markBrowserNavigationIntent(panelId, intent),
  reload: (panelId: string) => productPanelRuntime.panelTree.get(panelId).reload(),
  reloadView: (panelId: string) => productPanelRuntime.panelTree.get(panelId).reload(),
  forceReloadView: (panelId: string) => viewClient.browserForceReload(panelId),
  findInPage: (panelId: string, text: string, options: { forward: boolean; findNext: boolean }) =>
    viewClient.findInPage(panelId, text, options),
  stopFindInPage: (panelId: string) => viewClient.stopFindInPage(panelId),
  getBrowserSiteState: (panelId: string) => viewClient.getBrowserSiteState(panelId),
  toggleBrowserBookmark: (panelId: string) => viewClient.toggleBrowserBookmark(panelId),
  setBrowserZoom: (panelId: string, zoomFactor: number) =>
    viewClient.setBrowserZoom(panelId, zoomFactor),
  clearBrowserSiteData: (panelId: string) => viewClient.clearBrowserSiteData(panelId),
  printBrowserPage: (panelId: string) => viewClient.printBrowserPage(panelId),
  saveBrowserPagePdf: (panelId: string) => viewClient.saveBrowserPagePdf(panelId),
  stopBrowserMedia: (panelId: string) => viewClient.stopBrowserMedia(panelId),
  rebuildPanel: (panelId: string) => productPanelRuntime.panelTree.get(panelId).rebuild(),
  navigateHistory: (panelId: string, delta: -1 | 1) =>
    productPanelRuntime.panelTree.navigateHistory(panelId, delta),
  unload: (panelId: string) => productPanelRuntime.panelTree.get(panelId).unload(),
  archive: (panelId: string) => workspaceStateClient.slot.close(panelId),
  createAboutPanel: async (page: string) => {
    const createOptions =
      page === "new" ? { slug: `new-${crypto.randomUUID().slice(0, 8)}`, focus: true } : undefined;
    const result = await viewClient.createPanel(null, `about/${page}`, createOptions);
    return { ...result, kind: "workspace" as const };
  },
  /** Create a panel from any source path (not prefixed with "about/"). */
  navigate: (
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ) =>
    productPanelRuntime.panelTree
      .navigate(panelId, source, options)
      .then((observation) => ({ id: observation.panelId, title: observation.title })),
  /** Create a root panel; use createChild for an explicit parent relationship. */
  createPanel: async (
    source: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      isRoot?: boolean;
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
      placement?: PanelPlacementHint;
      focus?: boolean;
    }
  ) => {
    const parentIdPromise =
      options?.isRoot === false ? panel.getFocusedPanelId() : Promise.resolve(null);
    return parentIdPromise.then((parentId) =>
      viewClient.createPanel(parentId, source, {
        title: options?.title,
        slug: options?.slug,
        contextId: options?.contextId,
        focus: options?.focus ?? true,
        stateArgs: options?.stateArgs,
        placement: options?.placement,
        ref: options?.ref,
      })
    );
  },
  createChild: (
    parentId: string,
    source: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      focus?: boolean;
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
      placement?: PanelPlacementHint;
    }
  ) =>
    viewClient.createPanel(parentId, source, {
      title: options?.title,
      slug: options?.slug,
      focus: options?.focus,
      contextId: options?.contextId,
      stateArgs: options?.stateArgs,
      placement: options?.placement,
      ref: options?.ref,
    }),
  createBrowser: (
    url: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      focus?: boolean;
    }
  ) =>
    productPanelRuntime.openPanel(url, {
      parentId: null,
      title: options?.title,
      slug: options?.slug,
      focus: options?.focus,
    }),
  createBrowserChild: (
    parentId: string,
    url: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      focus?: boolean;
    }
  ) =>
    productPanelRuntime.openPanel(url, {
      parentId,
      title: options?.title,
      slug: options?.slug,
      focus: options?.focus,
    }),
  movePanel: (request: MovePanelRequest) =>
    workspaceStateClient.slot.move(request.panelId, request.newParentId, {
      ...(request.beforePanelId !== undefined ? { beforeSlotId: request.beforePanelId } : {}),
      ...(request.afterPanelId !== undefined ? { afterSlotId: request.afterPanelId } : {}),
    }),
  getCollapsedIds: () => viewClient.getCollapsedPanelIds(),
  setCollapsed: (panelId: string, collapsed: boolean) =>
    viewClient.setPanelCollapsed(panelId, collapsed),
  expandIds: (panelIds: string[]) => viewClient.expandPanelIds(panelIds),
};
// =============================================================================
// Command palette (shell-local registry over attributed panel ↔ shell events)
// =============================================================================
type PanelPaletteContribution = {
  panelId: string;
  commands: PaletteCommand[];
};

const paletteContributions = new Map<string, PaletteCommand[]>();
const isPaletteCommand = (value: unknown): value is PaletteCommand => {
  const command = value as Partial<PaletteCommand> | null;
  return (
    !!command &&
    typeof command === "object" &&
    typeof command.id === "string" &&
    typeof command.label === "string" &&
    (command.hint === undefined || typeof command.hint === "string") &&
    (command.section === undefined || typeof command.section === "string")
  );
};

rpc.on("runtime:palette-contribution", ({ caller, payload }) => {
  if (caller.callerKind !== "panel" && caller.callerKind !== "app") return;
  const commands = (payload as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(commands) || !commands.every(isPaletteCommand)) return;
  const panelId = caller.callerPanelId ?? caller.callerId;
  if (commands.length === 0) paletteContributions.delete(panelId);
  else paletteContributions.set(panelId, commands);
});

export const palette = {
  list: async (): Promise<PanelPaletteContribution[]> => {
    const focusedPanelId = await viewClient.getFocusedPanelId().catch(() => null);
    return [...paletteContributions]
      .map(([panelId, commands]) => ({ panelId, commands }))
      .sort((a, b) => (a.panelId === focusedPanelId ? -1 : b.panelId === focusedPanelId ? 1 : 0));
  },
  run: (panelId: string, commandId: string) =>
    rpc.emit(panelId, "runtime:palette-run", { commandId }),
};
// =============================================================================
// View Service
// =============================================================================
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ShellOverlayRow {
  label: string;
  meta?: string;
  labelRanges?: Array<{ start: number; end: number }>;
  metaRanges?: Array<{ start: number; end: number }>;
  icon?: string;
  selected?: boolean;
  type: string;
  payload?: unknown;
}
export interface NativeShellOverlayOptions {
  id: string;
  rows: ShellOverlayRow[];
  empty: string;
  bounds: Bounds;
  focus?: boolean;
}
export interface NativeShellOverlayEvent {
  overlayId: string;
  type: string;
  payload?: unknown;
}
export interface NativePanelSlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type NativePanelSlotSyncResult =
  | { status: "bound" | "updated" }
  | { status: "missing"; reason: string };
type NativeShellOverlayBridge = {
  on: (handler: (event: NativeShellOverlayEvent) => void) => () => void;
};
export const view = {
  forwardMouseClick: (viewId: string, point: { x: number; y: number }) =>
    viewClient.forwardMouseClick(viewId, point),
  setThemeCss: (css: string) => viewClient.setThemeCss(css),
  bindNativePanelSlot: (request: {
    nativeSlotId: string;
    bindingId: string;
    rendererInstanceId: string;
    bindingSequence: number;
    operationSequence: number;
    panelId: string;
    bounds: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.bindNativePanelSlot(request),
  updateNativePanelSlot: (request: {
    nativeSlotId: string;
    bindingId: string;
    rendererInstanceId: string;
    bindingSequence: number;
    operationSequence: number;
    bounds?: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.updateNativePanelSlot(request),
  clearNativePanelSlot: (request: {
    nativeSlotId: string;
    bindingId: string;
    rendererInstanceId: string;
    bindingSequence: number;
    operationSequence: number;
  }) => viewClient.clearNativePanelSlot(request),
  setHostedShellReady: (request: { ready: boolean; rendererInstanceId: string }) =>
    viewClient.setHostedShellReady(request),
  setShellOverlay: (active: boolean) => viewClient.setShellOverlay(active),
  showNativeShellOverlay: (options: NativeShellOverlayOptions) =>
    viewClient.showNativeShellOverlay(options),
  updateNativeShellOverlay: (
    options: Partial<NativeShellOverlayOptions> & {
      id?: string;
    }
  ) => viewClient.updateNativeShellOverlay(options),
  hideNativeShellOverlay: (id?: string) => viewClient.hideNativeShellOverlay(id),
  showContentOverlay: (options: Parameters<typeof viewClient.showContentOverlay>[0]) =>
    viewClient.showContentOverlay(options),
  updateContentOverlay: (options: Parameters<typeof viewClient.updateContentOverlay>[0]) =>
    viewClient.updateContentOverlay(options),
  hideContentOverlay: () => viewClient.hideContentOverlay(),
  browserNavigate: (browserId: string, url: string) => viewClient.browserNavigate(browserId, url),
  browserGoBack: (browserId: string) => viewClient.browserGoBack(browserId),
  browserGoForward: (browserId: string) => viewClient.browserGoForward(browserId),
  browserReload: (browserId: string) => viewClient.browserReload(browserId),
  browserForceReload: (browserId: string) => viewClient.browserForceReload(browserId),
  browserStop: (browserId: string) => viewClient.browserStop(browserId),
};
export const nativeShellOverlay = {
  on: (handler: (event: NativeShellOverlayEvent) => void) => {
    const bridge = (
      globalThis as unknown as {
        __vibestudioShellOverlay?: NativeShellOverlayBridge;
      }
    ).__vibestudioShellOverlay;
    if (!bridge) return () => {};
    return bridge.on(handler);
  },
};
type ContentOverlayHostBridge = {
  on: (handler: (payload: unknown) => void) => () => void;
};
/**
 * Receives intent payloads emitted by the content-overlay surface (forwarded by
 * main to the hosted shell). The bridge is injected by the app preload; absent
 * outside Electron, where `.on` is a no-op.
 */
export const contentOverlay = {
  on: (handler: (payload: unknown) => void) => {
    const bridge = (
      globalThis as unknown as {
        __vibestudioContentOverlayHost?: ContentOverlayHostBridge;
      }
    ).__vibestudioContentOverlayHost;
    if (!bridge) return () => {};
    return bridge.on(handler);
  },
};
type ShellNetworkBridge = {
  notifyNetworkOnline?: () => void;
};
/**
 * Forwards the renderer's `window` `online` event to main (fire-and-forget) so
 * main can nudge a possibly-stale server pipe awake after a network flap. The
 * bridge is injected by the app preload (`__vibestudioApp`); absent outside
 * Electron, where it is a no-op.
 */
export const shellNetwork = {
  notifyOnline: () => {
    const bridge = (globalThis as unknown as { __vibestudioApp?: ShellNetworkBridge })
      .__vibestudioApp;
    bridge?.notifyNetworkOnline?.();
  },
};
export const incomingPairLink = {
  getPending: () => g.__vibestudioIncomingPairLink?.getPending() ?? Promise.resolve(null),
  onLink: (handler: (link: ConnectPairing) => void) =>
    g.__vibestudioIncomingPairLink?.onLink(handler) ?? (() => {}),
};
export const incomingPanelLocation = {
  getPending: () => g.__vibestudioIncomingPanelLocation?.getPending() ?? Promise.resolve(null),
  onLocation: (handler: (location: PanelLocation) => void) =>
    g.__vibestudioIncomingPanelLocation?.onLocation(handler) ?? (() => {}),
  prepareWorkspaceRelaunch: (location: PanelLocation | null) =>
    g.__vibestudioIncomingPanelLocation?.prepareWorkspaceRelaunch(location) ?? Promise.resolve(),
};
// =============================================================================
// Menu Service
// =============================================================================
interface Position {
  x: number;
  y: number;
}
export const menu = {
  showHamburger: (position: Position) => menuClient.showHamburger(position),
  showContext: (items: Array<{ id: string; label: string }>, position: Position) =>
    menuClient.showContext(items, position),
  showPanelContext: (
    panelId: string,
    position: Position,
    presentation?: PanelContextPresentation
  ) => menuClient.showPanelContext(panelId, position, presentation),
};
// =============================================================================
// Workspace Service
// =============================================================================
export const workspace = {
  list: () => hubControlClient.listWorkspaces(),
  create: (
    name: string,
    opts?: {
      forkFrom?: string;
      rootTemplate?: WorkspaceTemplatePin;
    }
  ) =>
    hubControlClient.createWorkspace({
      workspace: name,
      ...(opts?.forkFrom ? { forkFrom: opts.forkFrom } : {}),
      ...(opts?.rootTemplate ? { rootTemplate: opts.rootTemplate } : {}),
    }),
  select: async (name: string) => {
    const entry = (await hubControlClient.listWorkspaces()).find(
      (workspace) => workspace.name === name
    );
    if (!entry) throw new Error(`Workspace "${name}" is not visible to this account`);
    return hubControlClient.routeWorkspace({ workspaceId: entry.workspaceId });
  },
  delete: async (name: string) => {
    await hubControlClient.deleteWorkspace({ workspace: name });
  },
  getActive: () => workspaceClient.getActive(),
  getConfig: () => workspaceClient.getConfig(),
};

// =============================================================================
// Templates Service
// =============================================================================
// Template mutations return immediately after asking through the normal
// approval surface. The shell intentionally renders that state as a human
// message rather than exposing the approval record identity.
export const templates = createTemplateManagementClient((extension, method, args) =>
  extensionsClient.invoke(extension, method, args)
);
export const credentials = {
  requestCredentialInput: (input: Parameters<typeof credentialsClient.requestCredentialInput>[0]) =>
    credentialsClient.requestCredentialInput(input),
};
/** Standard semantic VCS review flow, including coordinator-owned external deltas. */
export const vcs = {
  status: (contextId: string) => vcsClient.status({ contextId }),
  compareDelta: async (contextId: string, sourceDeltaId: string) => {
    const status = await vcsClient.status({ contextId });
    return vcsClient.compare({
      target: status.workingHead,
      sourceDeltaId,
      view: "changes",
      limit: 200,
    });
  },
  integrateDelta: (
    contextId: string,
    expectedWorkingHead: VcsCompareResult["target"],
    sourceDeltaId: string,
    decision: VcsIntegrationChoice
  ) =>
    vcsClient.integrate({
      commandId: crypto.randomUUID(),
      contextId,
      expectedWorkingHead,
      sourceDeltaId,
      decision,
    }),
};
// =============================================================================
// Remote credential store
// =============================================================================
export interface RemoteCredCurrent {
  connected: RemoteCredCurrentContract["connected"];
  configured: RemoteCredCurrentContract["configured"];
  isActive: RemoteCredCurrentContract["isActive"];
  deviceId?: RemoteCredCurrentContract["deviceId"];
  workspaceName?: RemoteCredCurrentContract["workspaceName"];
}
export type DeviceRecord = HubDevice;
export type PairingInvite = HubPairingInvite;
export const remoteCred = {
  getCurrent: () => remoteCredClient.getCurrent(),
  pair: (link: string, label?: string) => remoteCredClient.pair({ link, label }),
  reconnectNow: () => remoteCredClient.reconnectNow(),
  clear: () => remoteCredClient.clear(),
  relaunch: () => remoteCredClient.relaunch(),
};
/** The stable server-wide control service, composed directly over the hub pipe. */
export const hubControl = hubControlClient;
// =============================================================================
// Autofill Service
// =============================================================================
export const autofill = {
  confirmSave: (panelId: string, action: "save" | "never" | "dismiss") =>
    autofillClient.confirmSave(panelId, action),
  confirmFormFill: (panelId: string, action: "save" | "dismiss") =>
    autofillClient.confirmFormFill(panelId, action),
};
// =============================================================================
// Blobstore Service (content-addressed read surface — diff-review lazy fetch)
// =============================================================================
export const blobstore = {
  getText: (digest: string) => blobstoreClient.getText(digest),
  getBase64: (digest: string) => blobstoreClient.getBase64(digest),
  stat: (digest: string) => blobstoreClient.stat(digest),
};
// =============================================================================
// Workspace Presence Service (WP8 §4 — who's connected to this workspace)
// =============================================================================
// Host presence built from live session facts (zero channel coupling). Read
// once on mount, then keep fresh via the `workspace-presence-changed` event.
export type { WorkspacePresenceEntry } from "@vibestudio/shared/workspacePresence";
export const workspacePresence = {
  list: () => workspacePresenceClient.list(),
};
// =============================================================================
// Account profile projection (principal identity + owner labels)
// =============================================================================
export type ShellAccountProfile = AccountProfile;
export type ShellAccountProfileUpdate = AccountProfileUpdate;

export const ACCOUNT_PROFILE_CHANGED_EVENT = "account-profile-changed";

export const account = {
  getProfile: () => accountClient.getProfile(),
  resolveProfiles: (userIds: readonly string[]) => accountClient.resolveProfiles([...userIds]),
  updateProfile: async (input: ShellAccountProfileUpdate) => {
    const profile = await hubControlClient.updateProfile(input);
    window.dispatchEvent(
      new CustomEvent<ShellAccountProfile>(ACCOUNT_PROFILE_CHANGED_EVENT, { detail: profile })
    );
    return profile;
  },
};
// =============================================================================
// Durable account-scoped user notification inbox
// =============================================================================
const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const userNotificationStore = createGadServiceClient(rpc);
const resolvedChannelClients = new Map<string, DurableObjectServiceClient>();

function channelClient(channelId: string): DurableObjectServiceClient {
  let client = resolvedChannelClients.get(channelId);
  if (!client) {
    client = createDurableObjectServiceClient(rpc, CHANNEL_SERVICE_PROTOCOL, channelId);
    resolvedChannelClients.set(channelId, client);
  }
  return client;
}

export interface ShellChannelInvite extends ChannelInvite {
  channelTitle: string;
  inviter?: ShellAccountProfile;
}

export interface ShellUserNotification extends UserNotification {
  /** Present for the built-in `channel.invite` kind after shell hydration. */
  channelInvite?: ShellChannelInvite;
}

async function describeChannelInvite(invite: ChannelInvite): Promise<ShellChannelInvite> {
  const config = await channelClient(invite.channelId).call<{ title?: string } | null>("getConfig");
  return {
    ...invite,
    channelTitle: config?.title?.trim() || invite.channelId,
  };
}

export const userNotifications = {
  /** Read one durable account inbox; never enumerate producer/channel DOs. */
  async list(): Promise<ShellUserNotification[]> {
    const { notifications } = await userNotificationStore.call<UserNotificationListResult>(
      "listUserNotificationsForMe"
    );
    const channelInvites = notifications
      .map((notification) => channelInviteFromNotification(notification))
      .filter((invite): invite is ChannelInvite => invite !== null);
    const inviterUserIds = [
      ...new Set(
        channelInvites
          .map((invite) =>
            invite.addedBy.startsWith("user:") ? invite.addedBy.slice("user:".length) : null
          )
          .filter((userId): userId is string => Boolean(userId))
      ),
    ];
    const profilesPromise = inviterUserIds.length
      ? account
          .resolveProfiles(inviterUserIds)
          .catch((): Record<string, ShellAccountProfile> => ({}))
      : Promise.resolve({} as Record<string, ShellAccountProfile>);
    const [described, profiles] = await Promise.all([
      Promise.all(
        channelInvites.map((invite) =>
          describeChannelInvite(invite).catch(() => ({
            ...invite,
            channelTitle: invite.channelId,
          }))
        )
      ),
      profilesPromise,
    ]);
    const hydratedInvites = new Map<string, ShellChannelInvite>();
    for (const invite of described) {
      const inviterUserId = invite.addedBy.startsWith("user:")
        ? invite.addedBy.slice("user:".length)
        : null;
      const inviter = inviterUserId ? profiles[inviterUserId] : undefined;
      hydratedInvites.set(invite.channelId, inviter ? { ...invite, inviter } : invite);
    }
    return notifications.map((notification) => {
      const invite = channelInviteFromNotification(notification);
      const channelInvite = invite ? hydratedInvites.get(invite.channelId) : undefined;
      return channelInvite ? { ...notification, channelInvite } : notification;
    });
  },

  async acknowledge(id: string): Promise<boolean> {
    const result = await userNotificationStore.call<UserNotificationAcknowledgementResult>(
      "acknowledgeUserNotification",
      { id }
    );
    return result.acknowledged;
  },

  /** Open the known invited channel in its owning context. Acknowledgement is
   * deliberately separate so a failed panel creation never consumes the invite. */
  async openChannel(channelId: string): Promise<{ id: string }> {
    const profile = await account.getProfile();
    const findInGroup = async (
      group: Parameters<typeof workspaceStateClient.panelTree.page>[0]["group"]
    ): Promise<string | null> => {
      let cursor: string | undefined;
      do {
        const page = await workspaceStateClient.panelTree.page({
          group,
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        for (const node of page.nodes) {
          const [observation, stateArgs] = await Promise.all([
            productPanelRuntime.panelTree.get(node.slotId).observe(),
            getPanelStateArgs(node.slotId),
          ]);
          if (observation.source === "panels/chat" && stateArgs["channelName"] === channelId) {
            return node.slotId;
          }
          if (node.childCount > 0) {
            const nested = await findInGroup({ kind: "children", parentSlotId: node.slotId });
            if (nested) return nested;
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return null;
    };
    const existingId = profile
      ? await findInGroup({ kind: "roots", ownerUserId: profile.userId })
      : null;
    if (existingId) {
      await productPanelRuntime.panelTree.get(existingId).focus();
      return { id: existingId };
    }

    const service = channelClient(channelId);
    const [config, contextId] = await Promise.all([
      service.call<{ title?: string } | null>("getConfig"),
      service.call<string | null>("getContextId"),
    ]);
    if (!contextId) {
      throw new Error("This conversation is not ready yet. Please try again in a moment.");
    }
    const handle = await productPanelRuntime.openPanel("panels/chat", {
      parentId: null,
      focus: true,
      contextId,
      title: config?.title?.trim() || undefined,
      stateArgs: { channelName: channelId },
    });
    return { id: handle.id };
  },
};
// =============================================================================
// Events Service
// =============================================================================
// Re-export event types from shared module
export type { EventName, EventPayloads } from "@vibestudio/shared/events";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
export const events = {
  subscribe: (event: EventName) => eventsClient.subscribe(event),
  unsubscribe: (event: EventName) => eventsClient.unsubscribe(event),
  unsubscribeAll: () => eventsClient.unsubscribeAll(),
  on: <E extends EventName>(event: E, listener: (payload: EventPayloads[E]) => void) =>
    eventsClient.on(event, listener),
};

/**
 * Events addressed to this exact authenticated shell RPC session.
 *
 * This is deliberately separate from `events`: direct events do not own or
 * join an `events.watch` response, and watched broadcasts never arrive here.
 */
export const directEvents = {
  on: <E extends EventName>(event: E, listener: (payload: EventPayloads[E]) => void) =>
    rpc.on(event, ({ payload }) => listener(payload as EventPayloads[E])),
};
// =============================================================================
// Notification Service
// =============================================================================
import type { NotificationPayload } from "@vibestudio/shared/events";
export const notification = {
  show: (
    opts: Omit<NotificationPayload, "id"> & {
      id?: string;
    }
  ) => notificationClient.show(opts),
  reportAction: (id: string, actionId: string) => notificationClient.reportAction(id, actionId),
  dismiss: (id: string) => notificationClient.dismiss(id),
};
// =============================================================================
// Extensions Service
// =============================================================================
export const extensions = {
  invoke: (name: string, method: string, args: unknown[] = []) =>
    extensionsClient.invoke(name, method, args),
};
export const browserData = browserDataClient;
export const browserEnvironment = browserEnvironmentClient;
// =============================================================================
// Runtime supervision
// =============================================================================
export const supervisedUnits = {
  list: () => runtimeClient.supervision.list(),
  versions: (releaseId: string) => runtimeClient.supervision.versions({ kind: "app", releaseId }),
  rollback: (releaseId: string, opts?: { buildKey?: string }) =>
    runtimeClient.supervision.rollback({ kind: "app", releaseId }, opts),
  restart: (identity: RuntimeSupervisionEntityKey) => runtimeClient.supervision.restart(identity),
  recoverExecution: (
    entityId: string,
    expectedExecutionDigest: string,
    strategy: "restore-exact" | "replace-incarnation"
  ) => runtimeClient.recoverExecution({ entityId, expectedExecutionDigest, strategy }),
  activate: (kind: "app" | "extension", releaseId: string) =>
    runtimeClient.supervision.activate({ kind, releaseId }),
  prepare: (kind: "app" | "extension", releaseId: string, ref: string) =>
    runtimeClient.supervision.prepare({ kind, releaseId }, { ref }),
  logs: (
    identity: RuntimeSupervisionEntityKey,
    opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
  ) => runtimeClient.supervision.logs(identity, opts),
  health: (
    identity: RuntimeSupervisionEntityKey,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: "debug" | "info" | "warn" | "error";
      limit?: number;
      errorLimit?: number;
    }
  ) => runtimeClient.supervision.health(identity, opts),
};
export const buildUnits = {
  list: () => buildClient.listUnits(),
};
// =============================================================================
// Shell Approval Service (consent approval queue)
// =============================================================================
import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { assertPresent } from "../utils/assertPresent";
export const shellApproval = {
  resolve: (approvalId: string, decision: ApprovalDecision) =>
    shellApprovalClient.resolve(approvalId, decision),
  resolveBootstrap: (approvalId: string, decision: Extract<ApprovalDecision, "once" | "deny">) =>
    shellApprovalClient.resolveBootstrap([approvalId], decision),
  resolveInstallReview: (
    approvalId: string,
    resolution: import("@vibestudio/shared/authority/unitInstallReview").TemplateInstallResolution
  ) => shellApprovalClient.resolveInstallReview(approvalId, resolution),
  resolveMissionReview: (
    approvalId: string,
    resolution: { decision: "approve"; selectedAuthorityKeys: string[] } | { decision: "dismiss" }
  ) => shellApprovalClient.resolveMissionReview(approvalId, resolution),
  submitClientConfig: (approvalId: string, values: Record<string, string>) =>
    shellApprovalClient.submitClientConfig(approvalId, values),
  submitCredentialInput: (approvalId: string, values: Record<string, string>) =>
    shellApprovalClient.submitCredentialInput(approvalId, values),
  submitSecretInput: (approvalId: string, values: Record<string, string>) =>
    shellApprovalClient.submitSecretInput(approvalId, values),
  listPending: () => shellApprovalClient.listPending(),
};
// =============================================================================
// Shell Presence Service
// =============================================================================
export const shellPresence = {
  heartbeat: () => shellPresenceClient.heartbeat(),
};
