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
  type RpcEventContext,
} from "@vibestudio/rpc";
import { RPC_METHODS } from "@vibestudio/shared/approvalContract";
import { appMethods } from "@vibestudio/shared/serviceSchemas/app";
import {
  accountMethods,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/shared/serviceSchemas/account";
import { eventsMethods } from "@vibestudio/shared/serviceSchemas/events";
import { extensionsMethods } from "@vibestudio/shared/serviceSchemas/extensions";
import { menuMethods } from "@vibestudio/shared/serviceSchemas/menu";
import { notificationMethods } from "@vibestudio/shared/serviceSchemas/notification";
import { panelMethods } from "@vibestudio/shared/serviceSchemas/panel";
import { panelTreeMethods } from "@vibestudio/shared/serviceSchemas/panelTree";
import { paletteMethods } from "@vibestudio/shared/serviceSchemas/palette";
import {
  remoteCredMethods,
  type RemoteCredCurrent as RemoteCredCurrentContract,
  type RemoteCredDeviceRecord,
  type RemoteCredPairingInvite,
} from "@vibestudio/shared/serviceSchemas/remoteCred";
import { settingsMethods } from "@vibestudio/shared/serviceSchemas/settings";
import { shellApprovalMethods } from "@vibestudio/shared/serviceSchemas/shellApproval";
import { autofillMethods } from "@vibestudio/shared/serviceSchemas/autofill";
import { blobstoreMethods } from "@vibestudio/shared/serviceSchemas/blobstore";
import { viewMethods } from "@vibestudio/shared/serviceSchemas/view";
import { workspaceMethods } from "@vibestudio/shared/serviceSchemas/workspace";
import { workspacePresenceMethods } from "@vibestudio/shared/serviceSchemas/workspacePresence";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  createDurableObjectServiceClient,
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@vibestudio/shared/userlandServiceRpc";
import type { ChannelInvite } from "@vibestudio/shared/channelInvites";
import {
  channelInviteFromNotification,
  type UserNotification,
  type UserNotificationAcknowledgementResult,
  type UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import type { PanelLocation } from "@vibestudio/shared/panelLocation";
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
const shellApprovalClient = createTypedServiceClient(
  "shellApproval",
  shellApprovalMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const appClient = createTypedServiceClient("app", appMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const accountClient = createTypedServiceClient("account", accountMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const eventsClient = createTypedServiceClient("events", eventsMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const extensionsClient = createTypedServiceClient(
  "extensions",
  extensionsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const menuClient = createTypedServiceClient("menu", menuMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const panelClient = createTypedServiceClient("panel", panelMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const panelTreeClient = createTypedServiceClient(
  "panelTree",
  panelTreeMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const paletteClient = createTypedServiceClient("palette", paletteMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
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
const settingsClient = createTypedServiceClient(
  "settings",
  settingsMethods,
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
const blobstoreClient = createTypedServiceClient(
  "blobstore",
  blobstoreMethods,
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
  MovePanelRequest,
  PaletteCommand,
  Panel,
  PanelTreeSnapshot,
} from "@vibestudio/shared/types";
import type { BrowserNavigationIntent } from "@vibestudio/shared/panelCommands";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@vibestudio/shared/hostTargets";
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
// =============================================================================
// Panel Service
// =============================================================================
export const panel = {
  getTreeSnapshot: () => panelClient.getTreeSnapshot(),
  /** Authenticated server read that performs per-account first-attach seeding. */
  ensureOwnerTree: () => panelTreeClient.getTreeSnapshot(),
  getFocusedPanelId: () => panelClient.getFocusedPanelId(),
  ensureLoaded: (panelId: string) => panelClient.ensureLoaded(panelId),
  updateTheme: (theme: ThemeAppearance) => panelClient.updateTheme(theme),
  updateThemeConfig: (config: ThemeConfig) => panelClient.updateThemeConfig(config),
  openDevTools: (panelId: string) => panelTreeClient.openDevTools(panelId),
  getChromeState: (panelId: string) => panelClient.getChromeState(panelId),
  getRuntimeLease: (panelId: string) => panelTreeClient.getRuntimeLease(panelId),
  takeOver: (panelId: string) => panelClient.takeOver(panelId),
  togglePin: (panelId: string) => panelClient.togglePin(panelId),
  listPinnedPanelIds: () => panelClient.listPinnedPanelIds(),
  getAddressOptions: (source: string, ref?: string) => panelClient.getAddressOptions(source, ref),
  getBrowserAddressOptions: (query: string) => panelClient.getBrowserAddressOptions(query),
  markBrowserNavigationIntent: (panelId: string, intent: BrowserNavigationIntent) =>
    panelClient.markBrowserNavigationIntent(panelId, intent),
  reload: (panelId: string) => panelTreeClient.reload(panelId),
  reloadView: (panelId: string) => panelClient.reloadView(panelId),
  forceReloadView: (panelId: string) => panelClient.forceReloadView(panelId),
  rebuildPanel: (panelId: string) => panelTreeClient.rebuildPanel(panelId),
  rebuildAndReload: (panelId: string) => panelTreeClient.rebuildAndReload(panelId),
  navigateHistory: (panelId: string, delta: -1 | 1) =>
    panelTreeClient.navigateHistory(panelId, delta),
  unload: (panelId: string) => panelTreeClient.unload(panelId),
  archive: (panelId: string) => panelTreeClient.archive(panelId),
  updatePanelState: (
    panelId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ) => panelTreeClient.updatePanelState(panelId, state),
  createAboutPanel: (page: string) =>
    panelTreeClient.create(`about/${page}`, {
      name: `${page}~${Date.now().toString(36)}`,
      focus: true,
    }),
  /** Create a panel from any source path (not prefixed with "about/"). */
  navigate: (
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ) => panelTreeClient.navigate(panelId, source, options),
  createPanel: (
    source: string,
    options?: {
      name?: string;
      isRoot?: boolean;
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
      focus?: boolean;
    }
  ) =>
    panelTreeClient.create(source, {
      name: options?.name,
      ref: options?.ref,
      contextId: options?.contextId,
      parentId: options?.isRoot === false ? undefined : null,
      focus: options?.focus ?? true,
      stateArgs: options?.stateArgs,
    }),
  createChild: (
    parentId: string,
    source: string,
    options?: {
      name?: string;
      focus?: boolean;
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ) =>
    panelTreeClient.create(source, {
      parentId,
      name: options?.name,
      focus: options?.focus,
      ref: options?.ref,
      contextId: options?.contextId,
      stateArgs: options?.stateArgs,
    }),
  createBrowser: (
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) => panelTreeClient.create(url, { parentId: null, name: options?.name, focus: options?.focus }),
  createBrowserChild: (
    parentId: string,
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) =>
    panelTreeClient.create(url, {
      parentId,
      name: options?.name,
      focus: options?.focus,
    }),
  movePanel: (request: MovePanelRequest) => panelTreeClient.movePanel(request),
  getCollapsedIds: () => panelTreeClient.getCollapsedIds(),
  setCollapsed: (panelId: string, collapsed: boolean) =>
    panelTreeClient.setCollapsed(panelId, collapsed),
  expandIds: (panelIds: string[]) => panelTreeClient.expandIds(panelIds),
};
// =============================================================================
// Palette Service (chrome lists + dispatches panel-contributed commands)
// =============================================================================
export const palette = {
  register: (commands: PaletteCommand[]) => paletteClient.register(commands),
  unregister: () => paletteClient.unregister(),
  list: () => paletteClient.list(),
  run: (panelId: string, commandId: string) => paletteClient.run(panelId, commandId),
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
    panelId: string;
    bounds: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.bindNativePanelSlot(request),
  updateNativePanelSlot: (request: {
    nativeSlotId: string;
    bounds?: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.updateNativePanelSlot(request),
  clearNativePanelSlot: (request: { nativeSlotId: string }) =>
    viewClient.clearNativePanelSlot(request),
  setHostedShellReady: (request: { ready: boolean }) => viewClient.setHostedShellReady(request),
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
  showPanelContext: (panelId: string, position: Position) =>
    menuClient.showPanelContext(panelId, position),
};
// =============================================================================
// Workspace Service
// =============================================================================
export const workspace = {
  list: () => workspaceClient.list(),
  create: (
    name: string,
    opts?: {
      forkFrom?: string;
    }
  ) => workspaceClient.create(name, opts),
  select: (name: string) => workspaceClient.select(name),
  delete: (name: string) => workspaceClient.delete(name),
  getActive: () => workspaceClient.getActive(),
  hostTargets: {
    list: (target: HostTarget) => workspaceClient.hostTargets.list(target),
    getSelection: (target: HostTarget) => workspaceClient.hostTargets.getSelection(target),
    setSelection: (target: HostTarget, input: HostTargetSelectionInput) =>
      workspaceClient.hostTargets.setSelection(target, input),
    clearSelection: (target: HostTarget) => workspaceClient.hostTargets.clearSelection(target),
    versions: (target: HostTarget, sourceOrName: string) =>
      workspaceClient.hostTargets.versions(target, sourceOrName),
    preparePinnedRef: (target: HostTarget, sourceOrName: string, ref: string) =>
      workspaceClient.hostTargets.preparePinnedRef(target, sourceOrName, ref),
    launch: (target: HostTarget) => workspaceClient.hostTargets.launch(target),
    beginLaunch: (target: HostTarget) => workspaceClient.hostTargets.beginLaunch(target),
    getLaunchSession: (sessionId: string) =>
      workspaceClient.hostTargets.getLaunchSession(sessionId),
    resolveLaunchSessionApproval: (sessionId: string, decision: "once" | "deny") =>
      workspaceClient.hostTargets.resolveLaunchSessionApproval(sessionId, decision),
    cancelLaunchSession: (sessionId: string) =>
      workspaceClient.hostTargets.cancelLaunchSession(sessionId),
  },
};
// =============================================================================
// Settings Service
// =============================================================================
export const settings = {
  getData: () => settingsClient.getData(),
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
export type DeviceRecord = RemoteCredDeviceRecord;
export type PairingInvite = RemoteCredPairingInvite;
export const remoteCred = {
  getCurrent: () => remoteCredClient.getCurrent(),
  pair: (link: string) => remoteCredClient.pair({ link }),
  pairDevice: async (args?: { workspace?: string; ttlMs?: number }) =>
    (await remoteCredClient.pairDevice(args)).pairing,
  listDevices: () => remoteCredClient.listDevices(),
  revokeDevice: (deviceId: string) => remoteCredClient.revokeDevice(deviceId),
  clear: () => remoteCredClient.clear(),
  relaunch: () => remoteCredClient.relaunch(),
};
// =============================================================================
// Autofill Service
// =============================================================================
export const autofill = {
  confirmSave: (panelId: string, action: "save" | "never" | "dismiss") =>
    autofillClient.confirmSave(panelId, action),
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
export type { WorkspacePresenceEntry } from "@vibestudio/shared/serviceSchemas/workspacePresence";
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
    const profile = await accountClient.updateProfile(input);
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

function findOwnedChannelPanel(
  snapshot: PanelTreeSnapshot,
  owner: string,
  channelId: string
): Panel | null {
  const group = snapshot.forest.find((candidate) => candidate.owner === owner);
  if (!group) return null;
  const visit = (panels: Panel[]): Panel | null => {
    for (const candidate of panels) {
      if (
        candidate.snapshot.source === "panels/chat" &&
        candidate.snapshot.stateArgs?.["channelName"] === channelId
      ) {
        return candidate;
      }
      const descendant = visit(candidate.children);
      if (descendant) return descendant;
    }
    return null;
  };
  return visit(group.rootPanels);
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
    const [profile, snapshot] = await Promise.all([
      account.getProfile(),
      panelTreeClient.getTreeSnapshot(),
    ]);
    const existing = profile ? findOwnedChannelPanel(snapshot, profile.userId, channelId) : null;
    if (existing) {
      await panelTreeClient.focus(existing.id);
      return { id: existing.id };
    }

    const service = channelClient(channelId);
    const [config, contextId] = await Promise.all([
      service.call<{ title?: string } | null>("getConfig"),
      service.call<string | null>("getContextId"),
    ]);
    if (!contextId) {
      throw new Error("This conversation is not ready yet. Please try again in a moment.");
    }
    return panelTreeClient.create("panels/chat", {
      parentId: null,
      focus: true,
      contextId,
      name: config?.title?.trim() || undefined,
      stateArgs: { channelName: channelId, contextId },
    });
  },
};
// =============================================================================
// Events Service
// =============================================================================
// Re-export event types from shared module
export type { EventName, EventPayloads } from "@vibestudio/shared/events";
import type { EventName } from "@vibestudio/shared/events";
export const events = {
  subscribe: (event: EventName) => eventsClient.subscribe(event),
  unsubscribe: (event: EventName) => eventsClient.unsubscribe(event),
  unsubscribeAll: () => eventsClient.unsubscribeAll(),
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
// =============================================================================
// Workspace Unit Service
// =============================================================================
export const workspaceUnits = {
  list: () => workspaceClient.units.list(),
  versions: (name: string) => workspaceClient.units.versions(name),
  rollback: (name: string, opts?: { buildKey?: string }) =>
    workspaceClient.units.rollback(name, opts),
  restart: (name: string) => workspaceClient.units.restart(name),
  logs: (
    name: string,
    opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
  ) => workspaceClient.units.logs(name, opts),
  diagnostics: (
    name: string,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: "debug" | "info" | "warn" | "error";
      limit?: number;
      errorLimit?: number;
    }
  ) => workspaceClient.units.diagnostics(name, opts),
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
    shellApprovalClient.resolveBootstrap(approvalId, decision),
  resolveUserland: (approvalId: string, choice: string | "dismiss") =>
    shellApprovalClient.resolveUserland(approvalId, choice),
  resolveExternalAgent: (approvalId: string, behavior: "allow" | "deny") =>
    shellApprovalClient.resolveExternalAgent(approvalId, behavior),
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
  heartbeat: () => rpc.call<undefined>("main", RPC_METHODS.shellPresence.heartbeat, []),
};
// =============================================================================
// RPC Event Listener (for useShellEvent hook)
// =============================================================================
/**
 * Register a listener for RPC events.
 * Used by the useShellEvent hook.
 */
export const onRpcEvent = (
  event: string,
  listener: (event: RpcEventContext) => void
): (() => void) => rpc.on(event, listener);
