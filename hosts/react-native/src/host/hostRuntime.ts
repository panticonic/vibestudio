import {
  ClientArtifactCache,
  ClientLauncher,
  ClientUpdateObserver,
  buildHostDescriptor,
  parseClientIntentLink,
  clientIntentLink,
  launchEntries,
  textParamOf,
  type LaunchEntry,
  invokeBackgroundIntent,
  isClientLink,
  principalGrantsOverCall,
  type Call,
  type ClientArtifactFetch,
  type ClientArtifactStore,
  type ClientUpdate,
  type LaunchState,
  type LaunchedClient,
  type UpdatePolicy,
} from "@vibestudio/client-host-core";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { createTypedRpcServiceClient } from "@vibestudio/shared/typedRpcServiceClient";
import { channelClientRpcMethods } from "@vibestudio/service-schemas/channel";
import { createRpcMethodCaller } from "@vibestudio/shared/rpcMethods";
import { createGadServiceClient } from "@vibestudio/service-schemas/clients/gadServiceClient";
import type { PushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";
import type { NotificationsHostEvent } from "@vibestudio/rn-client-api/notificationsProtocol";
import { mainRpcMethod } from "@vibestudio/service-schemas/mainRpc";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import { parsePanelLocationLink } from "@vibestudio/shared/panelLocation";
import type { FreshShellPairing } from "@vibestudio/mobile-iroh";
import { encodeRpcJson } from "@vibestudio/rpc";
import type {
  ClientHostEvent,
  ClientIntent,
  UpdateOffer,
} from "@vibestudio/rn-client-api/protocol";
import {
  clientPrincipalId,
  isClientCapability,
  type ClientCapability,
  type ClientSelection,
} from "@vibestudio/workspace-contracts/clients";
import type { EventPayloads, SupervisionChange } from "@vibestudio/shared/events";
import { ClientInstance, type DeviceCapabilityPorts } from "./clientInstance";
import type { DeviceConnection, DevicePorts } from "./deviceConnection";
import { WorkspacePipes, createSessionOpeners } from "./hostConnections";
import {
  isForegroundIntent,
  launchSurfaces,
  pickBackgroundIntent,
  pickShareTarget,
} from "./integration";
import type { HostState } from "./hostState";
import type {
  ConversationLaunch,
  HostNotifications,
  ReplyOutcome,
} from "./notifications/hostNotifications";
import type { BackgroundApprovalDecision } from "./notifications/actionQueue";
import type {
  ClientStopReason,
  HostRuntimeEvent,
  HostRuntimeNativeModule,
  NativeClientBundle,
} from "./nativeHostRuntime";
import { createStore, type Store } from "./store";
import { BrokerError } from "./ports";
import type { InstalledLauncher } from "@vibestudio/rn-client-api/integrationProtocol";

/** The capabilities this host binary implements (a subset of the catalog for android and ios). */
export const MOBILE_HOST_CAPABILITIES: readonly ClientCapability[] = [
  "device-session",
  "panel-hosting",
  "approval-surface",
  "hub-control",
  "notifications",
  "notifications.reply",
  "clipboard",
  "open-external",
  "browser-import",
  "integration.install",
];

/**
 * The foreground intent a conversation notification opens, and its parameter
 * (the channel id). A client that wants conversation notifications, bubbles
 * and notification presses routed to it declares exactly this.
 */
export const CONVERSATION_INTENT = "open-conversation";
export const CONVERSATION_PARAM = "conversation";

/** What the host's own screen shows (pairing, review, messages); a running client has its own screen. */
export interface HostUiState {
  phase:
    | "starting"
    | "needs-pairing"
    | "connecting"
    | "launching"
    | "running"
    /** Paired and connected with no client running (the last one was closed). */
    | "idle"
    | "failed";
  message: string;
  busy: boolean;
  /** A pairing link waiting for the person's confirmation. */
  pendingPairing: FreshShellPairing | null;
  /** The launch gate: reviews to answer before the client starts. */
  approvals: PendingUnitInstallReviewApproval[];
  /** Where the launch is, for the timeline. */
  launchStatus: "approval-required" | "preparing" | "ready" | null;
  launchDetail: string | null;
  /** Running clients, by title. */
  running: Array<{ tag: string; title: string }>;
  /** The clients this device can run, with their development mode (docs/client-hosts-and-clients-plan.md 7.4). */
  clients: Array<{ id: string; title: string; development: boolean }>;
}

const INITIAL_UI: HostUiState = {
  phase: "starting",
  message: "Starting Vibestudio...",
  busy: true,
  pendingPairing: null,
  approvals: [],
  launchStatus: null,
  launchDetail: null,
  running: [],
  clients: [],
};

/** The server events the host runtime acts on. `EventsClient` implements it. */
export interface HostEvents {
  on<E extends "clients:changed" | "shell-approval:resolved" | "supervision:changed">(
    event: E,
    listener: (payload: EventPayloads[E]) => void
  ): () => void;
  subscribe(
    event: "clients:changed" | "shell-approval:resolved" | "supervision:changed"
  ): Promise<void>;
  unsubscribe(event: "supervision:changed"): Promise<void>;
  unsubscribeAll(): Promise<void>;
}

/** Where links reach the process: deep links, universal links, a launch URL. */
export interface HostLinkSource {
  onUrl(handler: (url: string) => void): () => void;
  initialUrl(): Promise<string | null>;
}

export interface HostLinkPorts {
  isConnectLink(url: string): boolean;
  /** Parse a pairing link into its pairing; throws a message fit to show when it is invalid. */
  parseConnectLink(url: string): FreshShellPairing;
  /** True when this link was already consumed (replay); false otherwise. */
  consumeReplay(url: string): Promise<boolean>;
  markConsumed(url: string): Promise<void>;
  /** Native USB provisioning approval for this exact link. */
  consumeUsbApproval(url: string): Promise<boolean>;
}

export interface HostRuntimePorts {
  native: Pick<
    HostRuntimeNativeModule,
    | "markReady"
    | "startClient"
    | "reloadClient"
    | "stopClient"
    | "focusClient"
    | "showHostSurface"
    | "requestPinShortcut"
    | "publishLaunchSurfaces"
    | "disablePinnedShortcuts"
    | "respond"
    | "reject"
    | "emit"
    | "artifactMaterializeBuild"
    | "artifactRetainBuilds"
  >;
  onNativeEvent(handler: (event: HostRuntimeEvent) => void): () => void;
  device: DevicePorts;
  artifactStore: ClientArtifactStore;
  /** The server's events over the launch connection (resubscribed on recovery). */
  events(connection: DeviceConnection): HostEvents;
  /** `gateway.fetch` over the launch connection. */
  artifactFetch(connection: DeviceConnection): ClientArtifactFetch;
  state: HostState;
  deviceCapabilities: DeviceCapabilityPorts;
  notifications: HostNotifications;
  links: HostLinkPorts;
  linkSource: HostLinkSource;
  platform: "android" | "ios";
  hostVersion: string;
  /** Where native reports the process's foreground state (Android; absent where the app lifecycle already is the process's). */
  processForeground?: { set(foreground: boolean): void };
  smokePhase?: (phase: string) => void;
}

interface Running {
  instance: ClientInstance;
  tag: string;
  source: string;
  title: string;
  buildKey: string;
  observer: ClientUpdateObserver;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnitInstallReview(value: unknown): value is PendingUnitInstallReviewApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "unit-install-review"
  );
}

/** An error with its stack and, for an AggregateError, every member: what the device log needs to find a root cause. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const members = error instanceof AggregateError ? error.errors.map(describeFailure) : [];
  return [error.stack ?? error.message, ...members.map((member) => `  caused by: ${member}`)].join(
    "\n"
  );
}

/**
 * The mobile host runtime (docs/client-hosts-and-clients-plan.md §4.1, §5.3).
 *
 * It starts with the process, owns the device (credential, the one physical
 * connection per reach, pairing, push, the verified artifact cache) and runs
 * each client in its own React Native instance behind a capability broker. It
 * knows no client: what to launch is the server's answer to `clients.launch`.
 *
 * Nothing here waits on a timer. A launch that needs review or is still
 * preparing is continued by the server's own events (`clients:changed`,
 * `shell-approval:resolved`) or by the person's answer.
 */
interface ActiveLaunch {
  readonly launcher: ClientLauncher;
  readonly select: ClientSelection;
  readonly reloadTag: string | null;
  status: "preparing" | "approval-required";
  detail: string | null;
  approvals: PendingUnitInstallReviewApproval[];
}

function launchKey(select: ClientSelection): string {
  return JSON.stringify(select);
}

export class HostRuntime {
  readonly ui: Store<HostUiState> = createStore(INITIAL_UI);
  private connection: DeviceConnection | null = null;
  private pipes: WorkspacePipes | null = null;
  private events: HostEvents | null = null;
  private readonly running = new Map<string, Running>();
  private stopEvents: Array<() => void> = [];
  private releaseNative: (() => void) | null = null;
  /** In-flight launches by selection: each client's launch has its own reviews and generation. */
  private readonly launches = new Map<string, ActiveLaunch>();
  private cache: ClientArtifactCache | null = null;
  private pairing: Promise<boolean> | null = null;

  constructor(private readonly ports: HostRuntimePorts) {}

  private smoke(phase: string): void {
    this.ports.smokePhase?.(phase);
  }

  private patch(change: Partial<HostUiState>): void {
    this.ui.set({ ...this.ui.get(), ...change });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * Attach to native, tell it the host is ready for client requests, then bring
   * the device up: reconnect when paired, otherwise wait for a pairing.
   */
  async start(): Promise<void> {
    await this.ports.state.load();
    this.releaseNotificationEvents = this.ports.notifications.onEvent((event) =>
      this.deliverNotificationEvent(event)
    );
    await this.ports.notifications.start();
    this.releaseNative = this.ports.onNativeEvent((event) => this.onNativeEvent(event));
    // Links, shares and background intents reach the host whichever screen is
    // showing, so they are observed here, before native is released. Those that
    // arrive while the device is still coming up are handled once it is.
    this.releaseLinks = this.ports.linkSource.onUrl((url) =>
      this.whenLive(() => this.handleLink(url).then(() => undefined))
    );
    await this.ports.native.markReady();
    await this.bringUp();
    this.live = true;
    const initial = await this.ports.linkSource.initialUrl();
    if (initial) await this.guarded(() => this.handleLink(initial).then(() => undefined));
    for (const action of this.beforeLive.splice(0)) await this.guarded(action);
  }

  /** Whether the device has been brought up (connected or waiting for a pairing) since start. */
  private live = false;
  private readonly beforeLive: Array<() => Promise<void>> = [];

  /** Run `action` now when the device is up, otherwise in arrival order once it is. */
  private whenLive(action: () => Promise<void>): void {
    if (this.live) void this.guarded(action);
    else this.beforeLive.push(action);
  }

  private async guarded(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.patch({ message: errorMessage(error), busy: false });
    }
  }

  private releaseLinks: (() => void) | null = null;
  private releaseNotificationEvents: (() => void) | null = null;

  async stop(): Promise<void> {
    this.releaseNative?.();
    this.releaseNative = null;
    this.releaseLinks?.();
    this.releaseLinks = null;
    this.releaseNotificationEvents?.();
    this.releaseNotificationEvents = null;
    this.live = false;
    this.beforeLive.length = 0;
    await this.teardownDevice("closed");
    this.ports.notifications.stop();
  }

  /** Reconnect with the stored credential, or ask for a pairing. */
  bringUp(launchDefault = true): Promise<void> {
    // One bring-up at a time: a restored task arriving while the host is still
    // connecting joins it instead of opening a second connection.
    this.bringingUp ??= this.doBringUp(launchDefault).finally(() => {
      this.bringingUp = null;
    });
    return this.bringingUp;
  }

  private bringingUp: Promise<void> | null = null;

  private async doBringUp(launchDefault: boolean): Promise<void> {
    this.patch({
      phase: "connecting",
      message: "Connecting securely to your workspace...",
      busy: true,
    });
    try {
      if (!(await this.ports.device.isPaired())) {
        this.patch({
          phase: "needs-pairing",
          message:
            "Open a Vibestudio pairing link or scan a QR code from a trusted desktop or terminal.",
          busy: false,
        });
        return;
      }
      const connection = await this.ports.device.connect();
      await this.adopt(connection);
      if (launchDefault) await this.launch({ default: true }, null);
    } catch (error) {
      await this.failBringUp(error);
    }
  }

  private async failBringUp(error: unknown): Promise<void> {
    const code = (error as { code?: unknown } | null)?.code;
    const unusable =
      code === "SESSION_AUTH_FAILED"
        ? "Your saved pairing was rejected. Scan a fresh Vibestudio QR code to re-pair."
        : code === "STORED_CONNECTION_UNSUPPORTED"
          ? "This device was paired with an older Vibestudio build. Scan a fresh Vibestudio QR code to pair it again."
          : null;
    if (unusable) {
      // A credential the server rejects, or one this build cannot read, is
      // terminal: drop it so the next start asks for a fresh pairing instead of
      // looping on one that can never work, and say why.
      try {
        await this.ports.device.forget();
        this.patch({ phase: "needs-pairing", message: unusable, busy: false });
      } catch (clearError) {
        this.patch({
          phase: "failed",
          message: `${unusable.split(".")[0]}, and it could not be cleared securely: ${errorMessage(clearError)}`,
          busy: false,
        });
      }
      return;
    }
    this.patch({ phase: "failed", message: errorMessage(error), busy: false });
  }

  private async adopt(connection: DeviceConnection): Promise<void> {
    this.connection = connection;
    const pipes = new WorkspacePipes(connection.account);
    pipes.adopt(connection.systemWorkspaceId, connection.launch);
    this.pipes = pipes;
    const events = this.ports.events(connection);
    this.events = events;
    this.stopEvents.push(
      events.on("clients:changed", () => void this.onClientsChanged()),
      events.on(
        "shell-approval:resolved",
        (event) => void this.onApprovalResolved(event.approvalId)
      ),
      events.on("supervision:changed", (change) => this.onSupervisionChange(change)),
      connection.recovery.registerResubscribeHandler("host-notifications", () =>
        this.ports.notifications.drain()
      )
    );
    await Promise.all([
      events.subscribe("clients:changed"),
      events.subscribe("shell-approval:resolved"),
    ]);
    // A decision taken while no connection was available is sent now.
    await this.ports.notifications.drain();
    // What the OS shows of this device's clients is brought up to date at connect.
    this.refreshIntegration();
  }

  // ---------------------------------------------------------------------------
  // Pairing and links
  // ---------------------------------------------------------------------------

  /** A link reached the host (deep link, scanner, paste, share). Returns whether the host handled it. */
  async handleLink(url: string, focus = true): Promise<boolean> {
    const { links } = this.ports;
    if (links.isConnectLink(url)) {
      if (await links.consumeReplay(url)) return true;
      let pairing: FreshShellPairing;
      try {
        pairing = links.parseConnectLink(url);
      } catch (error) {
        this.patch({
          pendingPairing: null,
          message: `${errorMessage(error)}\n\nScan a fresh Vibestudio pairing QR code to re-pair this device.`,
          busy: false,
        });
        return true;
      }
      // Native USB provisioning is the one-time acceptance boundary for a link.
      let approved = false;
      try {
        approved = await links.consumeUsbApproval(url);
      } catch {
        // A failing approval lookup falls back to explicit confirmation.
      }
      if (approved) {
        await links.markConsumed(url);
        this.smoke("embedded-usb-provisioning-approved");
        await this.pair(pairing, url);
      } else {
        this.patch({
          pendingPairing: pairing,
          message: "Pair this device with this Vibestudio server?",
          busy: false,
        });
        this.pendingPairingUrl = url;
      }
      return true;
    }
    if (isClientLink(url)) {
      try {
        const request = parseClientIntentLink(url);
        await this.openClientIntent(
          request.id,
          { name: request.intent, params: request.params },
          focus
        );
      } catch (error) {
        this.patch({ message: errorMessage(error) });
      }
      return true;
    }
    const panel = parsePanelLocationLink(url);
    if (panel.kind === "ok") {
      try {
        await this.openClientIntent(null, { name: "open-panel", params: { panel: url } });
      } catch (error) {
        this.patch({ message: errorMessage(error) });
      }
      return true;
    }
    return false;
  }

  private pendingPairingUrl: string | null = null;

  cancelPairing(): void {
    this.pendingPairingUrl = null;
    this.patch({ pendingPairing: null, message: "Pairing cancelled.", busy: false });
  }

  async confirmPairing(): Promise<boolean> {
    const pairing = this.ui.get().pendingPairing;
    if (!pairing) return false;
    const url = this.pendingPairingUrl;
    this.pendingPairingUrl = null;
    return this.pair(pairing, url);
  }

  /** Pair, then bring the device up. Concurrent requests join the one in flight. */
  private pair(pairing: FreshShellPairing, url: string | null): Promise<boolean> {
    this.pairing ??= (async () => {
      this.patch({
        pendingPairing: null,
        phase: "connecting",
        message: "Connecting securely to your workspace...",
        busy: true,
      });
      try {
        await this.teardownDevice("closed");
        await this.ports.device.pair(pairing);
        if (url) await this.ports.links.markConsumed(url);
        await this.bringUp();
        return true;
      } catch (error) {
        console.error("[mobile-host] pairing failed", describeFailure(error));
        this.patch({ phase: "failed", message: errorMessage(error), busy: false });
        return false;
      } finally {
        this.pairing = null;
      }
    })();
    return this.pairing;
  }

  // ---------------------------------------------------------------------------
  // Launch
  // ---------------------------------------------------------------------------

  private descriptor() {
    return buildHostDescriptor({
      host: this.ports.platform,
      hostVersion: this.ports.hostVersion,
      implemented: MOBILE_HOST_CAPABILITIES,
    });
  }

  private callOf(connection: DeviceConnection): Call {
    return (service, method, args) =>
      connection.launch.rpc.call("main", mainRpcMethod(`${service}.${method}`), args);
  }

  /**
   * Launch a client and run it. `reloadTag` replaces the running instance of
   * that tag (an adopted update or a rollback); otherwise the client starts.
   * Resolves with the state this launch reached, or null when a newer launch
   * of the same selection superseded it.
   */
  async launch(select: ClientSelection, reloadTag: string | null): Promise<LaunchState | null> {
    const connection = this.requireConnection();
    const call = this.callOf(connection);
    this.cache ??= new ClientArtifactCache(
      this.ports.artifactStore,
      this.ports.artifactFetch(connection)
    );
    const launcher = new ClientLauncher({
      call,
      descriptor: this.descriptor(),
      cache: this.cache,
      grants: principalGrantsOverCall(call),
    });
    const key = launchKey(select);
    const entry: ActiveLaunch = {
      launcher,
      select,
      reloadTag,
      status: "preparing",
      detail: null,
      approvals: [],
    };
    this.launches.set(key, entry);
    this.patch({ phase: "launching", busy: true, message: "Preparing your workspace..." });
    const state = await launcher.launch(select);
    if (this.launches.get(key) !== entry) return null;
    await this.applyLaunchState(key, entry, state);
    return state;
  }

  /** The host screen shows every launch's reviews and the most urgent status. */
  private publishLaunches(settled: Partial<HostUiState> = {}): void {
    const entries = [...this.launches.values()];
    const gated = entries.some((entry) => entry.status === "approval-required");
    const preparing = entries.find((entry) => entry.status === "preparing");
    this.patch({
      ...settled,
      approvals: entries.flatMap((entry) => entry.approvals),
      ...(gated
        ? { launchStatus: "approval-required" as const, launchDetail: null }
        : preparing
          ? { launchStatus: "preparing" as const, launchDetail: preparing.detail }
          : {}),
    });
  }

  private async applyLaunchState(
    key: string,
    entry: ActiveLaunch,
    state: LaunchState
  ): Promise<void> {
    switch (state.state) {
      case "approval-required": {
        this.smoke("embedded-host-target-approval-required");
        entry.status = "approval-required";
        entry.approvals = state.approvals;
        this.publishLaunches({
          phase: "launching",
          busy: false,
          message: "Review workspace app access",
        });
        // The host's own screen carries the review.
        await this.ports.native.showHostSurface();
        return;
      }
      case "preparing":
        this.smoke("embedded-host-target-preparing");
        entry.status = "preparing";
        entry.approvals = [];
        entry.detail = state.reason;
        this.publishLaunches({ phase: "launching", busy: true, message: state.reason });
        return;
      case "unavailable":
        this.launches.delete(key);
        this.publishLaunches({
          phase: "failed",
          busy: false,
          launchStatus: null,
          launchDetail: null,
          message: state.reason,
        });
        return;
      case "ready":
        this.launches.delete(key);
        this.publishLaunches({ launchStatus: "ready", launchDetail: null });
        await this.run(state.launched, entry.reloadTag);
        return;
    }
  }

  private failLaunch(key: string, error: unknown): void {
    this.launches.delete(key);
    this.publishLaunches({
      phase: "failed",
      busy: false,
      launchStatus: null,
      launchDetail: null,
      message: errorMessage(error),
    });
  }

  /** The server changed which clients exist or what is built: continue every launch that was preparing. */
  private async onClientsChanged(): Promise<void> {
    this.refreshIntegration();
    await Promise.all(
      [...this.launches].map(async ([key, entry]) => {
        try {
          const state = await entry.launcher.onClientsChanged();
          if (state && this.launches.get(key) === entry) {
            await this.applyLaunchState(key, entry, state);
          }
        } catch (error) {
          this.failLaunch(key, error);
        }
      })
    );
  }

  /** A review was answered (here or on another device): launch again so the server proceeds. */
  private async onApprovalResolved(approvalId: string): Promise<void> {
    const found = [...this.launches].find(([, entry]) =>
      entry.approvals.some((approval) => approval.approvalId === approvalId)
    );
    if (!found) return;
    const [key, entry] = found;
    try {
      entry.approvals = [];
      entry.status = "preparing";
      this.publishLaunches({ busy: true, message: "Preparing your workspace..." });
      await this.launch(entry.select, entry.reloadTag);
    } catch (error) {
      this.failLaunch(key, error);
    }
  }

  /** The person's answer to the launch gate shown on the host screen. */
  async resolveApprovals(decision: "once" | "deny"): Promise<void> {
    const gated = [...this.launches].filter(([, entry]) => entry.approvals.length > 0);
    if (gated.length === 0) return;
    this.patch({ busy: true, message: decision === "once" ? "Approving..." : "Denying..." });
    this.smoke("embedded-host-target-approval-submitted");
    for (const [key, entry] of gated) {
      const approvals = entry.approvals;
      // The answer given here continues this launch (`resolveApprovals`); the launch
      // stops waiting on those reviews so their announcement starts no second launch.
      entry.approvals = [];
      entry.status = "preparing";
      try {
        const state = await entry.launcher.resolveApprovals(approvals, decision);
        this.smoke("embedded-host-target-approval-resolved");
        if (decision === "deny") {
          this.launches.delete(key);
          this.publishLaunches({
            phase: "failed",
            busy: false,
            launchStatus: null,
            message:
              "You chose not to start the workspace app. Nothing from it was run. Retry to review it again.",
          });
        } else if (state && this.launches.get(key) === entry) {
          await this.applyLaunchState(key, entry, state);
        }
      } catch (error) {
        console.error("[mobile-host] answering the launch review failed", describeFailure(error));
        entry.approvals = approvals;
        entry.status = "approval-required";
        this.publishLaunches({ busy: false, message: errorMessage(error) });
      }
    }
  }

  async retry(): Promise<void> {
    if (!this.connection) return this.bringUp();
    try {
      await this.launch({ default: true }, null);
    } catch (error) {
      this.patch({ phase: "failed", busy: false, message: errorMessage(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // Running clients
  // ---------------------------------------------------------------------------

  private requireConnection(): DeviceConnection {
    if (!this.connection) throw new Error("This device is not connected.");
    return this.connection;
  }

  private bundleFor(launched: LaunchedClient, directory: string): NativeClientBundle {
    const primary = launched.artifacts.filter(
      (artifact) => artifact.role === "primary" && artifact.platform === this.ports.platform
    );
    if (primary.length !== 1) {
      throw new Error(`Expected one primary bundle for ${this.ports.platform}`);
    }
    const entry = primary[0]!;
    return {
      bundlePath: `${directory}/${entry.path}`,
      integrity: entry.integrity,
      buildKey: launched.client.buildKey,
      assetsRoot: directory,
    };
  }

  /** Lay the build out for native and return its bundle. Only this platform's artifacts are placed. */
  private async materialize(launched: LaunchedClient): Promise<NativeClientBundle> {
    const entries = launched.artifacts
      .filter((artifact) => artifact.platform === this.ports.platform)
      .map(({ path, integrity }) => ({ path, integrity }));
    const directory = await this.ports.native.artifactMaterializeBuild(
      launched.client.buildKey,
      entries
    );
    return this.bundleFor(launched, directory);
  }

  private instanceFor(launched: LaunchedClient, intent: ClientIntent | null): ClientInstance {
    const connection = this.requireConnection();
    let instance!: ClientInstance;
    const tag = () => instance.principalId;
    instance = new ClientInstance({
      launched,
      platform: this.ports.platform,
      openers: createSessionOpeners({
        launch: connection.launch,
        account: connection.account,
        pipes: this.pipes!,
      }),
      state: this.ports.state,
      device: this.ports.deviceCapabilities,
      notifications: this.ports.notifications.handlers,
      integration: {
        install: (id) => this.installLauncher(id),
        list: () => this.ports.state.launchers(),
        remove: (id) => this.removeLaunchers(id, "This launcher was removed."),
      },
      intent,
      deliver: (event: ClientHostEvent) => {
        void this.ports.native.emit(tag(), encodeRpcJson(event)).catch((error: unknown) => {
          console.warn("[mobile-host] delivering an event to a client failed", error);
        });
      },
      hooks: {
        restart: () => this.reload(tag(), "update"),
        rollback: () => this.rollback(tag()),
        trustRevoked: () =>
          void this.stopClient(
            tag(),
            "trust-revoked",
            `${launched.client.title} was removed from your trusted clients, so it was closed. ` +
              "Its sessions ended and it can no longer act as this device."
          ),
        resetDevice: () => this.resetDevice(),
      },
    });
    return instance;
  }

  private async run(launched: LaunchedClient, reloadTag: string | null): Promise<void> {
    const intent = launched.client.intent
      ? { name: launched.client.intent.name, params: launched.client.intent.params }
      : null;
    const bundle = await this.materialize(launched);
    const instance = this.instanceFor(launched, intent);
    const tag = instance.principalId;
    const previous = this.running.get(tag);
    if (previous) {
      // The old build's sessions end with its JavaScript; the new instance is the
      // one native's next requests for this tag belong to.
      await previous.observer.stop().catch(() => undefined);
      await previous.instance.dispose();
    }
    const observer = this.observerFor(instance, launched);
    const running: Running = {
      instance,
      tag,
      source: launched.client.source,
      title: launched.client.title,
      buildKey: launched.client.buildKey,
      observer,
    };
    this.running.set(tag, running);
    try {
      instance.holdPrincipalSession();
      if (reloadTag && previous) await this.ports.native.reloadClient(tag, bundle);
      else
        await this.ports.native.startClient({
          ...bundle,
          tag,
          clientId: launched.client.id,
          title: launched.client.title,
          grantedCapabilities: [...instance.capabilities],
        });
      await observer.start();
    } catch (error) {
      // Only this attempt's own entry: a newer start of the tag owns the key now.
      if (this.running.get(tag) === running) this.running.delete(tag);
      await instance.dispose().catch(() => undefined);
      throw error;
    }
    await this.retainBuilds();
    this.smoke(
      `${reloadTag && previous ? "client-reloaded" : "client-running"}.${launched.client.id}`
    );
    this.patch({
      phase: "running",
      busy: false,
      message: `${launched.client.title} is running.`,
      running: [...this.running.values()].map((entry) => ({ tag: entry.tag, title: entry.title })),
    });
  }

  private async retainBuilds(): Promise<void> {
    const keys = [...this.running.values()].map((entry) => entry.buildKey);
    await this.ports.native.artifactRetainBuilds(keys);
  }

  private observerFor(instance: ClientInstance, launched: LaunchedClient): ClientUpdateObserver {
    const events = this.events!;
    return new ClientUpdateObserver({
      events,
      source: launched.client.source,
      buildKey: launched.client.buildKey,
      // Mobile asks the person: the client prompts, then asks for the restart.
      policy: (): UpdatePolicy => "prompt",
      developmentMode: () => this.ports.state.isDevelopment(launched.client.id),
      onUpdate: async (update: ClientUpdate, policy) => {
        const offer: UpdateOffer = {
          buildKey: update.buildKey,
          effectiveVersion: update.effectiveVersion,
          previousBuildKey: update.previousBuildKey,
          change: update.change,
        };
        instance.offerUpdate(offer);
        // Development mode adopts at once: only this client's instance reloads.
        if (policy === "immediate") await this.reload(instance.principalId, "update");
      },
      onError: (error) => console.warn("[mobile-host] update observation failed", error),
    });
  }

  /** Reload one client's instance onto the build the server currently serves. */
  private async reload(tag: string, _why: "update" | "rollback"): Promise<void> {
    const running = this.running.get(tag);
    if (!running) throw new Error("That client is not running.");
    const state = await this.launch({ source: running.source }, tag);
    if (state?.state === "approval-required") {
      throw new Error(
        "This update needs your review. Open Vibestudio to review it; the client reloads once you approve."
      );
    }
    if (state?.state === "unavailable") throw new Error(state.reason);
  }

  private async rollback(tag: string): Promise<void> {
    const running = this.running.get(tag);
    if (!running) throw new Error("That client is not running.");
    const runtime = createTypedRpcServiceClient(
      this.requireConnection().launch.rpc,
      { targetId: "main", namespace: "runtime" },
      runtimeMethods
    );
    await runtime.supervision.rollback({ kind: "client", releaseId: running.instance.clientId });
    await this.reload(tag, "rollback");
  }

  /** A narrowed or widened capability set for a running client, announced by the server. */
  private onSupervisionChange(change: SupervisionChange): void {
    if (change.identity.kind !== "client" || !change.client) return;
    for (const running of this.running.values()) {
      if (running.source !== change.source) continue;
      // The announced set is the server's view of the client; this host grants
      // only what it implements, exactly as at launch.
      const next = change.client.grantedCapabilities
        .filter(isClientCapability)
        .filter((capability) => MOBILE_HOST_CAPABILITIES.includes(capability));
      const before = running.instance.capabilities;
      const lost = before.some((capability) => !next.includes(capability));
      const gained = next.some((capability) => !before.includes(capability));
      if ((!lost && !gained) || change.change === "adopted" || change.change === "rolled-back")
        continue;
      if (!lost) {
        running.instance.setCapabilities(next);
      } else {
        // Narrowed: the server decides whether the client can still run (a required
        // capability gone) or only loses an optional one; relaunch to find out.
        void this.reload(running.tag, "update").catch(
          (error: unknown) =>
            void this.stopClient(
              running.tag,
              "capability-revoked",
              `${running.title} lost a capability it needs: ${errorMessage(error)}`
            )
        );
      }
    }
  }

  /** Tear one client down: its sessions, its update observation, its RN instance. */
  async stopClient(tag: string, reason: ClientStopReason, message: string): Promise<void> {
    const running = this.running.get(tag);
    if (!running) return;
    this.running.delete(tag);
    this.smoke(`client-stopped.${running.instance.clientId}`);
    const failures: unknown[] = [];
    for (const step of [
      () => running.observer.stop(),
      () => running.instance.dispose(),
      () => this.ports.native.stopClient(tag, reason),
      () => this.retainBuilds(),
    ]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    this.patch({
      phase: this.running.size > 0 ? "running" : "failed",
      busy: false,
      message,
      running: [...this.running.values()].map((entry) => ({ tag: entry.tag, title: entry.title })),
    });
    // The person is told why on the host's own screen.
    await this.ports.native.showHostSurface().catch((error: unknown) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Stopping the client failed");
  }

  async resetDevice(): Promise<void> {
    await this.teardownDevice("device-reset");
    await this.ports.device.forget();
    this.patch({
      phase: "needs-pairing",
      busy: false,
      message: "This device was reset. Pair it again to continue.",
      running: [],
    });
    await this.ports.native.showHostSurface();
  }

  /** Stop every client and close the device's connections. Keeps every failure. */
  private async teardownDevice(reason: ClientStopReason): Promise<void> {
    this.launches.clear();
    const failures: unknown[] = [];
    for (const tag of [...this.running.keys()]) {
      try {
        await this.stopClient(tag, reason, "Stopped");
      } catch (error) {
        failures.push(error);
      }
    }
    for (const stop of this.stopEvents.splice(0)) stop();
    const steps: Array<() => Promise<unknown>> = [
      async () => this.events?.unsubscribeAll(),
      async () => this.pipes?.close(),
      async () => this.connection?.close(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    this.events = null;
    this.pipes = null;
    this.connection = null;
    this.cache = null;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Closing the device failed");
  }

  /**
   * Resolve an approval in its own workspace on the person's behalf, from a
   * notification action (no client needs to run). Uses the device's shared
   * connection to that workspace and releases it afterwards.
   */
  async decideApproval(
    target: { workspaceId: string; approvalId: string },
    decision: BackgroundApprovalDecision
  ): Promise<void> {
    const pipes = this.pipes;
    if (!pipes) throw new Error("This device is not connected.");
    const connection = await pipes.acquire(target.workspaceId);
    try {
      const approvals = createTypedRpcServiceClient(
        connection.rpc,
        { targetId: "main", namespace: "shellApproval" },
        shellApprovalMethods
      );
      await approvals.resolve(target.approvalId, decision);
    } finally {
      await pipes.release(target.workspaceId);
    }
  }

  // ---------------------------------------------------------------------------
  // Intents
  // ---------------------------------------------------------------------------

  private async listClients() {
    const connection = this.requireConnection();
    const clients = createTypedServiceClient("clients", clientsMethods, this.callOf(connection));
    return clients.list(this.descriptor());
  }

  /**
   * Open a foreground intent of a client: the one `id` names, or, with no id,
   * the client on this device that declares the intent (the default one first).
   * A link can only reach intents the client declares as foreground; nothing a
   * link carries can invoke a background intent.
   */
  private async openClientIntent(
    id: string | null,
    intent: ClientIntent,
    focus = true
  ): Promise<void> {
    const listed = (await this.listClients()).filter(
      (listing) => listing.runtime === "react-native"
    );
    const declaring = listed.filter((listing) => isForegroundIntent(listing, intent.name));
    const chosen = id
      ? declaring.find((listing) => listing.id === id)
      : (declaring.find((listing) => listing.isDefault) ?? declaring[0]);
    if (!chosen) {
      throw new Error(
        id
          ? `Client "${id}" on this device has no intent "${intent.name}" a link can open.`
          : `No client on this device handles "${intent.name}".`
      );
    }
    await this.deliverIntent(chosen.id, intent, focus);
  }

  /** Hand the intent to the running client, or launch the client with it. */
  private async deliverIntent(id: string, intent: ClientIntent, focus = true): Promise<void> {
    const running = [...this.running.values()].find((entry) => entry.instance.clientId === id);
    if (running) {
      running.instance.deliverIntent(intent);
      if (focus) await this.ports.native.focusClient(running.tag);
      return;
    }
    await this.launch({ id, intent: intent.name, params: intent.params }, null);
  }

  /** Something was shared into the device: route it to the client that accepts its type. */
  private async shareIn(mimeType: string, text: string): Promise<void> {
    const target = pickShareTarget(await this.listClients(), mimeType);
    if (!target) throw new Error(`No client on this device accepts shared ${mimeType}.`);
    await this.deliverIntent(target.id, {
      name: target.intent,
      params: { [target.textParam]: text },
    });
  }

  /**
   * Run a client's background intent server-side and show its text where the
   * person is not looking at a client: as a notification. No client code runs;
   * the failure of the intent is shown the same way, because the person asked
   * from a surface (a tile) that has nowhere else to say it.
   */
  private async runBackgroundIntent(name: string, text: string, clientId?: string): Promise<void> {
    let title = name;
    let notificationId = `intent:${clientId ?? ""}:${name}`;
    let picked: ReturnType<typeof pickBackgroundIntent> = null;
    let body: string;
    try {
      picked = pickBackgroundIntent(await this.listClients(), name, clientId);
      if (!picked)
        throw new Error(`No client on this device declares the background intent "${name}".`);
      title = picked.intent.title ?? name;
      notificationId = `intent:${picked.id}:${name}`;
      const textParam = textParamOf(picked.intent);
      const result = await invokeBackgroundIntent(
        this.callOf(this.requireConnection()),
        this.descriptor(),
        { id: picked.id, intent: name, params: textParam ? { [textParam]: text } : {} }
      );
      body = result.text;
    } catch (error) {
      body = `Failed: ${errorMessage(error)}`;
    }
    await this.ports.notifications.handlers["notifications.display"]({
      id: notificationId,
      title,
      body,
    });
    this.smoke(`background-intent-completed.${picked?.id ?? clientId ?? ""}.${name}`);
  }

  /** What the person can pin to the home screen: launchers for the clients this device runs. */
  async pinnableShortcuts(): Promise<LaunchEntry[]> {
    return launchEntries((await this.integrationSnapshot()).clients).flatMap(
      (client) => client.entries
    );
  }

  /**
   * Ask the launcher to pin a shortcut. The OS confirms with the person; the
   * result says whether the launcher accepted the request at all. That the
   * person agreed is the launcher's `shortcut-pinned` event, which records it.
   */
  pinShortcut(entry: LaunchEntry): Promise<boolean> {
    return this.ports.native.requestPinShortcut(entry.link, entry.label, entry.link);
  }

  /** `integration.install`: ask for the `open` launcher of a client this device can run. */
  private async installLauncher(id: string): Promise<{ outcome: "requested" | "unsupported" }> {
    const open = clientIntentLink(id, "open");
    const shortcut = (await this.pinnableShortcuts()).find(
      (candidate) => candidate.clientId === id && candidate.link === open
    );
    if (!shortcut) {
      throw new BrokerError(
        "UNKNOWN_CLIENT",
        `This device has no client "${id}" to add a launcher for.`
      );
    }
    return { outcome: (await this.pinShortcut(shortcut)) ? "requested" : "unsupported" };
  }

  /** The launcher confirmed a pinned shortcut: remember it, and tell the clients that may care. */
  private async onShortcutPinned(launcher: { shortcutId: string; label: string; link: string }) {
    const request = parseClientIntentLink(launcher.link);
    await this.ports.state.recordLauncher({
      launcherId: launcher.shortcutId,
      clientId: request.id,
      label: launcher.label,
      link: launcher.link,
    });
    this.smoke(`launcher-pinned.${request.id}`);
    this.announceLaunchers();
  }

  /** Disable and forget the recorded launchers of one client. */
  private async removeLaunchers(clientId: string, message: string): Promise<void> {
    const mine = this.ports.state.launchers().filter((launcher) => launcher.clientId === clientId);
    if (mine.length === 0) return;
    await this.ports.native.disablePinnedShortcuts(
      mine.map((launcher) => launcher.launcherId),
      message
    );
    for (const launcher of mine) await this.ports.state.forgetLauncher(launcher.launcherId);
    this.smoke(`launcher-disabled.${clientId}`);
    this.announceLaunchers();
  }

  private announceLaunchers(): void {
    const launchers: InstalledLauncher[] = this.ports.state.launchers();
    for (const running of this.running.values()) running.instance.announceLaunchers(launchers);
  }

  /**
   * Bring what the OS shows of this device's clients up to date: publish the
   * launch surfaces (shortcut menus, widgets, App Intents) and disable the
   * launchers of clients the server no longer declares. Runs at connect and on
   * the server's `clients:changed`, one refresh after another so the newest
   * state always lands last; never on a timer.
   */
  private refreshIntegration(): void {
    this.integrationRefresh = this.integrationRefresh
      .then(async () => {
        if (!this.connection) return;
        const [listings, snapshot] = await Promise.all([
          this.listClients(),
          this.integrationSnapshot(),
        ]);
        const present = new Set(listings.map((listing) => listing.id));
        const retired = new Set(
          this.ports.state
            .launchers()
            .map((launcher) => launcher.clientId)
            .filter((id) => !present.has(id))
        );
        for (const id of retired) {
          await this.removeLaunchers(id, "This app was removed from your workspace.");
        }
        await this.ports.native.publishLaunchSurfaces(launchSurfaces(snapshot.clients));
        this.patch({ clients: this.developableClients(listings) });
        this.smoke("launch-surfaces-published");
      })
      .catch((error: unknown) => {
        console.warn("[mobile-host] refreshing launch surfaces failed", error);
      });
  }

  private integrationRefresh: Promise<void> = Promise.resolve();

  private developableClients(
    listings: ReadonlyArray<{
      id: string;
      title: string;
      runtime: string;
      unavailableReason?: string | undefined;
    }>
  ): HostUiState["clients"] {
    return listings
      .filter(
        (listing) => listing.runtime === "react-native" && listing.unavailableReason === undefined
      )
      .map((listing) => ({
        id: listing.id,
        title: listing.title,
        development: this.ports.state.isDevelopment(listing.id),
      }));
  }

  /**
   * Development mode for one client on this device: a running instance of it
   * takes rebuilds as soon as the server announces them, restarting only itself.
   * A host-side setting, never the client's own (a published client cannot opt in).
   */
  async setDevelopmentMode(clientId: string, enabled: boolean): Promise<void> {
    await this.ports.state.setDevelopment(clientId, enabled);
    this.patch({
      clients: this.ui
        .get()
        .clients.map((client) =>
          client.id === clientId ? { ...client, development: enabled } : client
        ),
    });
  }

  private integrationSnapshot() {
    const clients = createTypedServiceClient(
      "clients",
      clientsMethods,
      this.callOf(this.requireConnection())
    );
    return clients.integrationSnapshot(this.descriptor());
  }

  /**
   * Post `text`, as the person, into the conversation a pushed message belongs
   * to (the reply typed into its notification; no client needs to run), then
   * acknowledge the durable inbox entry as the device. Uses the device's shared
   * connection to the push's workspace and releases it afterwards. A reply that
   * arrives while the device is still connecting waits for that bring-up to
   * settle; if it settles without a connection, its reason is the error. Once
   * the text is sent a failure to acknowledge is reported in the outcome, not
   * thrown: the caller must not send the text again.
   */
  async replyToInbox(entry: PushUserInboxDataPayload, text: string): Promise<ReplyOutcome> {
    if (!entry.channelTargetId) throw new Error("This message has no conversation to reply to.");
    if (!this.pipes) await this.bringUp(false);
    const pipes = this.pipes;
    if (!pipes) throw new Error(this.ui.get().message || "This device is not connected.");
    const connection = await pipes.acquire(entry.workspaceId);
    try {
      await createRpcMethodCaller(
        connection.rpc,
        entry.channelTargetId,
        channelClientRpcMethods
      )("sendAsCaller", [text]);
      try {
        // `acknowledged: false` means the entry was no longer pending: already read.
        await createGadServiceClient(connection.rpc).call("acknowledgeUserNotification", {
          id: entry.notificationId,
        });
        return { acknowledged: true };
      } catch (error) {
        return { acknowledged: false, reason: errorMessage(error) };
      }
    } finally {
      await pipes.release(entry.workspaceId);
    }
  }

  /**
   * The client intent that shows a conversation: the foreground intent
   * `open-conversation` that takes a `conversation` parameter (the channel id),
   * of the first client on this device that declares one. Null when none does.
   * Throws when the device cannot be brought up.
   */
  async conversationLaunch(channelId: string): Promise<ConversationLaunch | null> {
    // A push can wake a cold process before the device is up: wait for the
    // bring-up, and say why when it settles without a connection.
    if (!this.connection) await this.bringUp(false);
    const deviceId = this.connection?.launch.deviceId;
    if (!deviceId) throw new Error(this.ui.get().message || "This device is not connected.");
    const listing = (await this.listClients()).find(
      (candidate) =>
        candidate.runtime === "react-native" &&
        candidate.unavailableReason === undefined &&
        candidate.intents.some(
          (intent) =>
            intent.kind === "foreground" &&
            intent.name === CONVERSATION_INTENT &&
            intent.params?.[CONVERSATION_PARAM] !== undefined
        )
    );
    if (!listing) return null;
    return {
      link: clientIntentLink(listing.id, CONVERSATION_INTENT, { [CONVERSATION_PARAM]: channelId }),
      tag: clientPrincipalId(listing.id, "react-native", deviceId),
      clientId: listing.id,
      title: listing.title,
    };
  }

  /** A notification event for the running clients that may see it; true when one took it. */
  private deliverNotificationEvent(event: NotificationsHostEvent): boolean {
    let delivered = false;
    for (const running of this.running.values()) {
      if (running.instance.capabilities.includes("notifications")) {
        running.instance.deliver(event);
        delivered = true;
      }
    }
    return delivered;
  }

  // ---------------------------------------------------------------------------
  // Native events
  // ---------------------------------------------------------------------------

  private onNativeEvent(event: HostRuntimeEvent): void {
    switch (event.type) {
      case "client-request": {
        const running = this.running.get(event.tag);
        const { tag, requestId } = event;
        if (!running) {
          void this.ports.native
            .reject(tag, requestId, "CLIENT_STOPPED", "This client is not running.")
            .catch(() => undefined);
          return;
        }
        void running.instance.broker.handle(event.method, event.argsJson).then(
          (outcome) =>
            outcome.ok
              ? this.ports.native.respond(tag, requestId, outcome.resultJson)
              : this.ports.native.reject(tag, requestId, outcome.code, outcome.message),
          (error: unknown) => console.error("[mobile-host] broker failed", error)
        );
        return;
      }
      case "client-lifecycle": {
        const running = this.running.get(event.tag);
        if (!running) return;
        this.running.delete(event.tag);
        this.smoke(`client-stopped.${running.instance.clientId}`);
        void (async () => {
          await running.observer.stop().catch(() => undefined);
          await running.instance.dispose().catch(() => undefined);
          await this.retainBuilds().catch(() => undefined);
          this.patch({
            phase: this.running.size > 0 ? "running" : "idle",
            message:
              event.state === "crashed"
                ? `${running.title} stopped unexpectedly${event.message ? `: ${event.message}` : "."}`
                : `${running.title} was closed.`,
            running: [...this.running.values()].map((entry) => ({
              tag: entry.tag,
              title: entry.title,
            })),
          });
        })();
        return;
      }
      case "process-foreground": {
        this.ports.processForeground?.set(event.foreground);
        return;
      }
      case "client-restore": {
        void this.restoreClient(event.clientId);
        return;
      }
      case "link": {
        this.whenLive(() =>
          this.handleLink(event.url, event.focus !== false).then(() => undefined)
        );
        return;
      }
      case "shortcut-pinned": {
        void this.guarded(() => this.onShortcutPinned(event));
        return;
      }
      case "notification-event": {
        void this.ports.notifications.handleInboxEvent(event);
        return;
      }
      case "share-in": {
        this.whenLive(() => this.shareIn(event.mimeType, event.text));
        return;
      }
      case "background-intent": {
        this.whenLive(() => this.runBackgroundIntent(event.name, event.text, event.clientId));
        return;
      }
    }
  }

  /** The OS entered the process through a client's task: launch that client again. */
  private async restoreClient(clientId: string): Promise<void> {
    try {
      // The host may still be connecting; the restore waits for the device,
      // never fabricates one.
      if (!this.connection) await this.bringUp(false);
      await this.launch({ id: clientId }, null);
    } catch (error) {
      this.patch({ phase: "failed", busy: false, message: errorMessage(error) });
    }
  }
}
