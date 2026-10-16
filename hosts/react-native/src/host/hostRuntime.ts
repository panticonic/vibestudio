import {
  ClientArtifactCache,
  ClientLauncher,
  ClientUpdateObserver,
  buildHostDescriptor,
  parseClientIntentLink,
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
  isClientCapability,
  type ClientCapability,
  type ClientSelection,
} from "@vibestudio/workspace-contracts/clients";
import type { EventPayloads, SupervisionChange } from "@vibestudio/shared/events";
import { ClientInstance, type DeviceCapabilityPorts } from "./clientInstance";
import type { DeviceConnection, DevicePorts } from "./deviceConnection";
import { WorkspacePipes, createSessionOpeners } from "./hostConnections";
import type { HostState } from "./hostState";
import type { HostNotifications } from "./notifications/hostNotifications";
import type { BackgroundApprovalDecision } from "./notifications/actionQueue";
import type {
  ClientStopReason,
  HostRuntimeEvent,
  HostRuntimeNativeModule,
  NativeClientBundle,
} from "./nativeHostRuntime";
import { createStore, type Store } from "./store";

/** The capabilities this host binary implements (a subset of the catalog for android and ios). */
export const MOBILE_HOST_CAPABILITIES: readonly ClientCapability[] = [
  "device-session",
  "panel-hosting",
  "approval-surface",
  "hub-control",
  "notifications",
  "clipboard",
  "open-external",
  "browser-import",
];

/** What the host's own screen shows (pairing, review, messages); a running client has its own screen. */
export interface HostUiState {
  phase: "starting" | "needs-pairing" | "connecting" | "launching" | "running" | "failed";
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
};

/** The server events the host runtime acts on. `EventsClient` implements it. */
export interface HostEvents {
  on<E extends "clients:changed" | "shell-approval:resolved" | "supervision:changed">(
    event: E,
    listener: (payload: EventPayloads[E]) => void
  ): () => void;
  subscribe(event: "clients:changed" | "shell-approval:resolved" | "supervision:changed"): Promise<void>;
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
export class HostRuntime {
  readonly ui: Store<HostUiState> = createStore(INITIAL_UI);
  private connection: DeviceConnection | null = null;
  private pipes: WorkspacePipes | null = null;
  private events: HostEvents | null = null;
  private readonly running = new Map<string, Running>();
  private stopEvents: Array<() => void> = [];
  private releaseNative: (() => void) | null = null;
  private launchGeneration = 0;
  private activeLaunch: {
    launcher: ClientLauncher;
    select: ClientSelection;
    reloadTag: string | null;
    approvalIds: Set<string>;
  } | null = null;
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
    await this.ports.notifications.start();
    this.releaseNative = this.ports.onNativeEvent((event) => this.onNativeEvent(event));
    // Links reach the host whichever screen is showing, so they are observed
    // here, before native is released. Those that arrive while the device is
    // still coming up are handled once it is.
    const early: string[] = [];
    let live = false;
    const link = (url: string): void => {
      if (!live) early.push(url);
      else void this.handleLinkSafely(url);
    };
    this.releaseLinks = this.ports.linkSource.onUrl(link);
    await this.ports.native.markReady();
    await this.bringUp();
    live = true;
    const initial = await this.ports.linkSource.initialUrl();
    for (const url of [...(initial ? [initial] : []), ...early]) await this.handleLinkSafely(url);
  }

  private releaseLinks: (() => void) | null = null;

  private async handleLinkSafely(url: string): Promise<void> {
    try {
      await this.handleLink(url);
    } catch (error) {
      this.patch({ message: errorMessage(error), busy: false });
    }
  }

  async stop(): Promise<void> {
    this.releaseNative?.();
    this.releaseNative = null;
    this.releaseLinks?.();
    this.releaseLinks = null;
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
    this.patch({ phase: "connecting", message: "Connecting securely to your workspace...", busy: true });
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
    if (code === "SESSION_AUTH_FAILED") {
      // A rejected credential is terminal: drop it so the next start asks for a
      // fresh pairing instead of looping on one the server will not honor.
      try {
        await this.ports.device.forget();
        this.patch({
          phase: "needs-pairing",
          message: "Your saved pairing was rejected. Scan a fresh Vibestudio QR code to re-pair.",
          busy: false,
        });
      } catch (clearError) {
        this.patch({
          phase: "failed",
          message: `Your saved pairing was rejected and could not be cleared securely: ${errorMessage(clearError)}`,
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
      events.on("shell-approval:resolved", (event) => void this.onApprovalResolved(event.approvalId)),
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
  }

  // ---------------------------------------------------------------------------
  // Pairing and links
  // ---------------------------------------------------------------------------

  /** A link reached the host (deep link, scanner, paste, share). Returns whether the host handled it. */
  async handleLink(url: string): Promise<boolean> {
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
        await this.routeIntent({ id: request.id }, { name: request.intent, params: request.params });
      } catch (error) {
        this.patch({ message: errorMessage(error) });
      }
      return true;
    }
    const panel = parsePanelLocationLink(url);
    if (panel.kind === "ok") {
      try {
        await this.routeIntent(null, { name: "open-panel", params: { panel: url } });
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
        console.error("[mobile-host] pairing failed", error);
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
   */
  async launch(select: ClientSelection, reloadTag: string | null): Promise<void> {
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
    const generation = ++this.launchGeneration;
    this.activeLaunch = { launcher, select, reloadTag, approvalIds: new Set() };
    this.patch({ phase: "launching", busy: true, message: "Preparing your workspace..." });
    const state = await launcher.launch(select);
    if (generation !== this.launchGeneration) return;
    await this.applyLaunchState(state);
  }

  private async applyLaunchState(state: LaunchState): Promise<void> {
    const active = this.activeLaunch;
    switch (state.state) {
      case "approval-required": {
        this.smoke("embedded-host-target-approval-required");
        if (active) active.approvalIds = new Set(state.approvals.map((a) => a.approvalId));
        this.patch({
          phase: "launching",
          busy: false,
          approvals: state.approvals,
          launchStatus: "approval-required",
          launchDetail: null,
          message: "Review workspace app access",
        });
        // The host's own screen carries the review.
        await this.ports.native.showHostSurface();
        return;
      }
      case "preparing":
        this.smoke("embedded-host-target-preparing");
        this.patch({
          phase: "launching",
          busy: true,
          approvals: [],
          launchStatus: "preparing",
          launchDetail: state.reason,
          message: state.reason,
        });
        return;
      case "unavailable":
        this.activeLaunch = null;
        this.patch({
          phase: "failed",
          busy: false,
          approvals: [],
          launchStatus: null,
          message: state.reason,
        });
        return;
      case "ready":
        this.activeLaunch = null;
        this.patch({ approvals: [], launchStatus: "ready", launchDetail: null });
        await this.run(state.launched, active?.reloadTag ?? null);
        return;
    }
  }

  /** The server changed which clients exist or what is built: continue a launch that was preparing. */
  private async onClientsChanged(): Promise<void> {
    const active = this.activeLaunch;
    if (!active) return;
    try {
      const state = await active.launcher.onClientsChanged();
      if (state) await this.applyLaunchState(state);
    } catch (error) {
      this.activeLaunch = null;
      this.patch({ phase: "failed", busy: false, message: errorMessage(error) });
    }
  }

  /** A review was answered (here or on another device): launch again so the server proceeds. */
  private async onApprovalResolved(approvalId: string): Promise<void> {
    const active = this.activeLaunch;
    if (!active?.approvalIds.has(approvalId)) return;
    try {
      this.patch({ busy: true, approvals: [], message: "Preparing your workspace..." });
      await this.launch(active.select, active.reloadTag);
    } catch (error) {
      this.activeLaunch = null;
      this.patch({ phase: "failed", busy: false, message: errorMessage(error) });
    }
  }

  /** The person's answer to the launch gate shown on the host screen. */
  async resolveApprovals(decision: "once" | "deny"): Promise<void> {
    const active = this.activeLaunch;
    const approvals = this.ui.get().approvals;
    if (!active || approvals.length === 0) return;
    this.patch({ busy: true, message: decision === "once" ? "Approving..." : "Denying..." });
    try {
      const state = await active.launcher.resolveApprovals(approvals, decision);
      if (decision === "deny") {
        this.activeLaunch = null;
        this.patch({
          phase: "failed",
          busy: false,
          approvals: [],
          launchStatus: null,
          message:
            "You chose not to start the workspace app. Nothing from it was run. Retry to review it again.",
        });
      } else if (state) {
        await this.applyLaunchState(state);
      }
    } catch (error) {
      this.patch({ busy: false, message: errorMessage(error) });
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
    const call = this.callOf(connection);
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
      grants: principalGrantsOverCall(call),
      state: this.ports.state,
      device: this.ports.deviceCapabilities,
      notifications: this.ports.notifications.handlers,
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
      this.running.delete(tag);
      await instance.dispose().catch(() => undefined);
      throw error;
    }
    await this.retainBuilds();
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
    await this.launch({ source: running.source }, tag);
    if (this.ui.get().launchStatus === "approval-required") {
      throw new Error(
        "This update needs your review. Open Vibestudio to review it; the client reloads once you approve."
      );
    }
    if (this.ui.get().phase === "failed") throw new Error(this.ui.get().message);
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
      const next = change.client.grantedCapabilities.filter(isClientCapability);
      const before = running.instance.capabilities;
      const widened = next.every((capability) => before.includes(capability));
      const same = widened && before.length === next.length;
      if (same || change.change === "adopted" || change.change === "rolled-back") continue;
      if (widened) {
        running.instance.setCapabilities(next);
      } else {
        // Narrowed: the server decides whether the client can still run (a required
        // capability gone) or only loses an optional one; relaunch to find out.
        void this.reload(running.tag, "update").catch((error: unknown) =>
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
    this.launchGeneration += 1;
    this.activeLaunch = null;
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

  /**
   * Deliver an intent: to the running client it names, or to the client that
   * declares it (`target` null), launching one when none runs.
   */
  private async routeIntent(
    target: { id: string } | null,
    intent: ClientIntent
  ): Promise<void> {
    const connection = this.requireConnection();
    let id = target?.id ?? null;
    if (!id) {
      const clients = createTypedServiceClient(
        "clients",
        clientsMethods,
        this.callOf(connection)
      );
      const listed = await clients.list(this.descriptor());
      const candidates = listed.filter(
        (listing) =>
          listing.runtime === "react-native" &&
          listing.intents.some((declared) => declared.name === intent.name)
      );
      const chosen = candidates.find((listing) => listing.isDefault) ?? candidates[0];
      if (!chosen) throw new Error(`No client on this device handles "${intent.name}".`);
      id = chosen.id;
    }
    const running = [...this.running.values()].find((entry) => entry.instance.clientId === id);
    if (running) {
      running.instance.deliverIntent(intent);
      await this.ports.native.focusClient(running.tag);
      return;
    }
    await this.launch({ id, intent: intent.name, params: intent.params }, null);
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
        void (async () => {
          await running.observer.stop().catch(() => undefined);
          await running.instance.dispose().catch(() => undefined);
          await this.retainBuilds().catch(() => undefined);
          this.patch({
            phase: this.running.size > 0 ? "running" : "needs-pairing",
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
      case "client-restore": {
        void this.restoreClient(event.clientId);
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
