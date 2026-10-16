import {
  ClientUpdateObserver,
  IntentLinkError,
  buildHostDescriptor,
  isClientLink,
  parseClientIntentLink,
  type Call,
  type ClientUpdate,
  type SupervisionEvents,
} from "@vibestudio/client-host-core";
import type { SupervisionChange } from "@vibestudio/shared/events";
import type { ApprovalResolvedEvent } from "@vibestudio/shared/governance/types";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { buildMethods } from "@vibestudio/service-schemas/build";
import {
  isClientCapability,
  type ClientCapability,
  type ClientSelection,
  type HostDescriptor,
  type ReadyClient,
} from "@vibestudio/workspace-contracts/clients";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  ClientBuildCatalog,
  clientBuildBaseUrl,
  clientEntryUrl,
  type DeliveredBuild,
} from "./clientDelivery.js";
import { ClientHostState } from "./clientHostState.js";
import type { ClientLaunches, RemoteLauncher } from "./clientLaunchLink.js";
import type { LaunchedClientWire, LaunchStateWire } from "../connection/connectionProtocol.js";
import { IntentInbox, type ClientIntent } from "./clientIntents.js";
import type { PendingClientUpdateInfo, PendingClientUpdates } from "./clientUpdates.js";
import type { ClientWindow, ClientWindowSpec, ClientWindows } from "./clientWindow.js";
import type { ScopedServerCaller } from "./serverClient.js";
import type { LaunchGateStatus } from "../bootstrap/launchGateModel.js";

const log = createDevLogger("ClientHost");

/**
 * The capabilities this binary actually implements. A host never claims a
 * capability it does not enforce: `buildHostDescriptor` rejects one the
 * catalog does not list for desktop, and the server grants a client only what
 * its host implements.
 */
export const DESKTOP_IMPLEMENTED_CAPABILITIES: readonly ClientCapability[] = [
  "device-session",
  "panel-hosting",
  "approval-surface",
  "hub-control",
  "native-menus",
  "notifications",
  "clipboard",
  "open-external",
  "theme",
  "devtools",
  "integration.install",
  "global-shortcut",
  "tray",
  "badge",
];

/** What this host tells the server about itself: its ABI and the capabilities it implements. */
export function desktopHostDescriptor(hostVersion: string): HostDescriptor {
  return buildHostDescriptor({
    host: "desktop",
    hostVersion,
    implemented: DESKTOP_IMPLEMENTED_CAPABILITIES,
  });
}

/** The window layer's view of the launch gate: host UI that exists before any client does. */
export interface LaunchGatePort {
  present(title: string | null, status: LaunchGateStatus): void;
  /** A client is running: close the gate. */
  dismiss(): void;
}

export interface DesktopClientHostDeps {
  hostVersion: string;
  /** The device's session to the System workspace. */
  call: Call;
  /** Launch, artifact cache and grants, which run in the connection process. */
  launches: ClientLaunches;
  windows: ClientWindows;
  catalog?: ClientBuildCatalog;
  supervision: SupervisionEvents;
  state: ClientHostState;
  gate: LaunchGatePort;
  /** The System workspace id: the client principal is registered there. */
  workspaceId(): string;
  notify(title: string, message: string): void;
  /** The pending updates changed: one was offered, taken, or retired. */
  updatesChanged?(clientId: string): void;
  /** Called once a client has a window, before the gate closes. */
  clientStarted?(client: ReadyClient, window: ClientWindow): void | Promise<void>;
  /** A client stopped running (its last window closed, or it was retired). */
  clientStopped?(clientId: string): void;
  /** The capabilities enforced for a running client changed. */
  capabilitiesChanged?(clientId: string, capabilities: readonly ClientCapability[]): void;
  /**
   * A launch reached a state the host finished handling (a ready client has its
   * window), or failed. `select` is the object the launch was started with.
   */
  launchObserved?(observation: LaunchObservation): void;
}

export type LaunchObservation =
  | { select: ClientSelection; state: LaunchStateWire }
  | { select: ClientSelection; failure: unknown };

interface RunningClient {
  clientId: string;
  source: string;
  principalId: string;
  title: string;
  client: ReadyClient;
  observer: ClientUpdateObserver;
  /** Builds whose bytes this client's windows may still load. */
  builds: Set<string>;
}

interface LaunchSession {
  select: ClientSelection;
  launcher: RemoteLauncher;
  /** The state the gate is showing, so a decision made elsewhere can continue it. */
  state: LaunchStateWire | null;
  /** The handling of the latest state: delivery, activation, or its presentation. */
  processing: Promise<void>;
}

/**
 * The desktop host's client lifecycle: launch through the shared
 * `ClientLauncher`, deliver verified bytes, open windows, follow the server's
 * announcements of newer builds and withdrawn trust. It knows nothing about
 * any client's UI.
 */
export class DesktopClientHost implements PendingClientUpdates {
  readonly descriptor: HostDescriptor;
  readonly catalog: ClientBuildCatalog;
  private readonly running = new Map<string, RunningClient>();
  private readonly inbox = new IntentInbox();
  private readonly retiring = new Set<string>();
  private gating: LaunchSession | null = null;
  private shuttingDown = false;
  private releaseSupervision: (() => void) | null = null;

  constructor(private readonly deps: DesktopClientHostDeps) {
    this.descriptor = desktopHostDescriptor(deps.hostVersion);
    this.catalog = deps.catalog ?? new ClientBuildCatalog();
  }

  /** Follow capability changes the server announces for running clients. */
  follow(): void {
    this.releaseSupervision = this.deps.supervision.on("supervision:changed", (change) =>
      this.applyGrantedCapabilities(change)
    );
  }

  // ---------------------------------------------------------------------------
  // Launch
  // ---------------------------------------------------------------------------

  /**
   * Launch (or focus, or hand an intent to) a client. The launch's states
   * reach the gate, and a ready client is delivered, verified and opened.
   * Resolves with the first state the server reported; a launch that waits on
   * a review or a build continues on events, never on a timer.
   */
  async launch(select: ClientSelection): Promise<LaunchStateWire> {
    const launcher = this.deps.launches.create(this.descriptor);
    const session: LaunchSession = { select, launcher, state: null, processing: Promise.resolve() };
    this.gating?.launcher.end();
    this.gating = session;
    launcher.subscribe((state) => {
      session.state = state;
      session.processing = this.onLaunchState(session, state);
    });
    try {
      const first = await launcher.launch(select);
      await session.processing;
      return first;
    } catch (error) {
      this.launchFailed(session, error);
      throw error;
    } finally {
      // A launch that reached a state nothing continues is over; one that waits
      // on a review or a build stays until it is replaced or finished.
      if (session.state?.state === "ready" || session.state?.state === "unavailable") {
        session.launcher.end();
        if (this.gating === session && session.state.state === "ready") this.gating = null;
      }
    }
  }

  /**
   * Open a link of the client grammar (`vibestudio://c/<id>/<intent>?k=v`).
   * False when the link is another handler's. A launch that fails shows its
   * reason on the launch gate, so only a malformed link is reported here.
   */
  async openLink(link: string): Promise<boolean> {
    if (!isClientLink(link)) return false;
    let request: ReturnType<typeof parseClientIntentLink>;
    try {
      request = parseClientIntentLink(link);
    } catch (error) {
      if (!(error instanceof IntentLinkError)) throw error;
      this.deps.notify("Couldn't open that link", error.message);
      return true;
    }
    await this.launch({ id: request.id, intent: request.intent, params: request.params }).catch(
      () => undefined
    );
    return true;
  }

  /** The server announced that clients (or their trust) changed: continue a launch that waits on one. */
  clientsChanged(): void {
    const session = this.gating;
    if (!session) return;
    void session.launcher
      .onClientsChanged()
      .catch((error: unknown) => this.launchFailed(session, error));
  }

  /** A review was answered elsewhere: a launch waiting on it continues or stands down. */
  approvalResolved(resolved: ApprovalResolvedEvent): void {
    const session = this.gating;
    if (!session || session.state?.state !== "approval-required") return;
    if (resolved.approvalKind !== "unit-install-review") return;
    if (!resolved.granted) {
      this.deps.gate.present(null, {
        status: "unavailable",
        reason: "You chose not to start this. Nothing from it was run.",
        declined: true,
      });
      return;
    }
    void session.launcher.launch(session.select).catch((error: unknown) => {
      this.launchFailed(session, error);
    });
  }

  /** The person answered the gate's review. */
  async resolveGateApprovals(decision: "once" | "deny"): Promise<void> {
    const session = this.gating;
    const state = session?.state;
    if (!session || state?.state !== "approval-required") {
      throw new Error("There is no review waiting on the launch gate");
    }
    if (decision === "deny") {
      await session.launcher.resolveApprovals("deny");
      // The review is answered: nothing waits on the gate until a new launch.
      session.state = null;
      this.deps.gate.present(null, {
        status: "unavailable",
        reason: "You chose not to start this. Nothing from it was run.",
        declined: true,
      });
      return;
    }
    this.deps.gate.present(null, { status: "starting", reason: "Approval recorded. Starting..." });
    await session.launcher.resolveApprovals("once");
  }

  private async onLaunchState(session: LaunchSession, state: LaunchStateWire): Promise<void> {
    try {
      switch (state.state) {
        case "ready":
          await this.activate(state.launched);
          if (this.gating === session) this.gating = null;
          break;
        case "approval-required":
          this.deps.gate.present(null, { status: "approval-required", approvals: state.approvals });
          break;
        case "preparing":
          this.deps.gate.present(null, {
            status: "preparing",
            phase: state.phase,
            reason: state.reason,
          });
          break;
        case "unavailable":
          this.deps.gate.present(null, { status: "unavailable", reason: state.reason });
          break;
      }
      this.deps.launchObserved?.({ select: session.select, state });
    } catch (error) {
      this.launchFailed(session, error);
    }
  }

  private launchFailed(session: LaunchSession, error: unknown): void {
    this.deps.launchObserved?.({ select: session.select, failure: error });
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`Client launch failed: ${reason}`);
    if (this.gating === session) {
      this.deps.gate.present(null, { status: "failed", reason });
    } else {
      this.deps.notify("A client could not start", reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Activation
  // ---------------------------------------------------------------------------

  /**
   * Make a launched, verified client the one that runs: open its window, or
   * move its running windows to the new build, and deliver a foreground intent.
   */
  private async activate(launched: LaunchedClientWire): Promise<void> {
    const { client } = launched;
    const spec = await this.windowSpec(client, launched.principalId);
    const delivered: DeliveredBuild = {
      clientId: client.id,
      buildKey: client.buildKey,
      artifacts: launched.artifacts,
    };
    if (client.runtime !== "web") {
      throw new Error(
        `The desktop host runs web clients; ${client.id} is a ${client.runtime} client`
      );
    }
    this.catalog.register(delivered);
    const running = this.running.get(client.id);
    if (!running) {
      await this.start(client, delivered, spec);
    } else if (running.client.buildKey !== client.buildKey) {
      await this.swap(running, client, spec);
    } else if (!sameCapabilities(running.client.grantedCapabilities, client.grantedCapabilities)) {
      for (const window of this.deps.windows.windowsOf(client.id))
        window.setCapabilities(spec.capabilities);
      running.client = client;
    }
    const windows = this.deps.windows.windowsOf(client.id);
    if (client.intent) {
      const intent: ClientIntent = client.intent;
      const target = windows.at(-1);
      if (target) this.inbox.deliver(target.windowId, intent);
    }
    this.deps.windows.focus(client.id);
    this.deps.gate.dismiss();
    await this.retainBuilds();
  }

  private async start(
    client: ReadyClient,
    delivered: DeliveredBuild,
    spec: ClientWindowSpec
  ): Promise<void> {
    const observer = new ClientUpdateObserver({
      events: this.deps.supervision,
      source: client.source,
      buildKey: client.buildKey,
      policy: () => "prompt",
      developmentMode: () => this.deps.state.isDevelopment(client.id),
      onUpdate: (update, policy) => this.onUpdate(client.id, update, policy),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Client update failed for ${client.id}: ${message}`);
        this.deps.notify("A client update could not be applied", message);
      },
    });
    const running: RunningClient = {
      clientId: client.id,
      source: client.source,
      principalId: spec.principalId,
      title: client.title,
      client,
      observer,
      builds: new Set([delivered.buildKey]),
    };
    this.running.set(client.id, running);
    // A launch always yields the server's current build: an offer for another is stale.
    this.clearPending(client.id);
    try {
      const window = await this.deps.windows.open(spec);
      await this.deps.clientStarted?.(client, window);
      await observer.start();
    } catch (error) {
      this.running.delete(client.id);
      this.catalog.retire(client.id, client.buildKey);
      this.deps.windows.closeClient(client.id, "start-failed");
      throw error;
    }
  }

  /** Move every window of a running client to a newer build of it. */
  private async swap(
    running: RunningClient,
    client: ReadyClient,
    spec: ClientWindowSpec
  ): Promise<void> {
    const previous = running.client.buildKey;
    for (const window of this.deps.windows.windowsOf(client.id)) {
      this.inbox.reset(window.windowId);
      await window.swap(spec);
    }
    running.client = client;
    running.title = client.title;
    running.builds.add(client.buildKey);
    running.observer.adopted(client.buildKey);
    this.clearPending(client.id);
    // Nothing loads the previous build once its windows have moved.
    running.builds.delete(previous);
    this.catalog.retire(client.id, previous);
  }

  /** `principalId` is the one the server granted for this exact build. */
  private async windowSpec(client: ReadyClient, principalId: string): Promise<ClientWindowSpec> {
    const identity = await this.sealedIdentity(client);
    return {
      clientId: client.id,
      principalId,
      title: client.title,
      source: client.source,
      buildKey: client.buildKey,
      entryUrl: clientEntryUrl({
        clientId: client.id,
        buildKey: client.buildKey,
        artifacts: client.artifacts,
      }),
      capabilities: client.grantedCapabilities,
      codeIdentity: identity,
      workspaceId: this.deps.workspaceId(),
    };
  }

  /**
   * The sealed identity of the exact build the host verified: its execution
   * digest must be the one `clients.launch` announced, and its reviewed
   * authority requests are what the host authorizes the client's calls against.
   */
  private async sealedIdentity(client: ReadyClient): Promise<ClientWindowSpec["codeIdentity"]> {
    const metadata = await createTypedServiceClient(
      "build",
      buildMethods,
      this.deps.call
    ).getBuildMetadata(client.buildKey);
    if (!metadata)
      throw new Error(`The server has no build record for ${client.id} (${client.buildKey})`);
    if (metadata.execution?.executionDigest !== client.executionDigest) {
      throw new Error(
        `The sealed execution identity of ${client.id} does not match the build the server launched`
      );
    }
    const authority = parseUnitAuthorityManifest(
      metadata.authority,
      `${client.id} sealed authority`
    );
    return {
      source: client.source,
      effectiveVersion: client.effectiveVersion,
      executionDigest: client.executionDigest,
      requested: authority.requests,
    };
  }

  /** Keep the verified bytes of the builds windows run; drop every other cached artifact. */
  private async retainBuilds(): Promise<void> {
    const retained = new Map<string, readonly string[]>();
    for (const running of this.running.values()) {
      retained.set(
        running.clientId,
        running.client.artifacts.map((artifact) => artifact.integrity)
      );
    }
    await this.deps.launches.retain(
      [...retained].map(([clientId, integrities]) => ({ clientId, integrities: [...integrities] }))
    );
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  private async onUpdate(
    clientId: string,
    update: ClientUpdate,
    policy: "prompt" | "immediate" | "restart-at-safe-point"
  ): Promise<void> {
    const running = this.running.get(clientId);
    if (!running) return;
    if (policy === "immediate") {
      await this.takeUpdate(running);
      return;
    }
    // The server announced; the person decides.
    this.deps.state.setPending({
      clientId,
      source: update.source,
      buildKey: update.buildKey,
      previousBuildKey: update.previousBuildKey,
      effectiveVersion: update.effectiveVersion,
      previousEffectiveVersion: running.client.effectiveVersion,
    });
    this.deps.updatesChanged?.(clientId);
  }

  private clearPending(clientId: string): void {
    const had = this.deps.state.pending().some((record) => record.clientId === clientId);
    this.deps.state.clearPending(clientId);
    if (had) this.deps.updatesChanged?.(clientId);
  }

  list(): PendingClientUpdateInfo[] {
    const pending: PendingClientUpdateInfo[] = [];
    for (const record of this.deps.state.pending()) {
      const running = this.running.get(record.clientId);
      // An offer for a build the client already runs is stale, not pending.
      if (!running || running.client.buildKey === record.buildKey) continue;
      pending.push({
        appId: record.clientId,
        source: record.source,
        url: clientBuildBaseUrl(record.clientId, record.buildKey),
        buildKey: record.buildKey,
        effectiveVersion: record.effectiveVersion,
        previousBuildKey: record.previousBuildKey,
        previousEffectiveVersion: record.previousEffectiveVersion,
      });
    }
    return pending;
  }

  /** The pending update of one client, for the client itself. */
  pendingFor(clientId: string): PendingClientUpdateInfo | null {
    return this.list().find((update) => update.appId === clientId) ?? null;
  }

  async apply(clientId: string): Promise<boolean> {
    const running = this.running.get(clientId);
    if (!running || !this.list().some((update) => update.appId === clientId)) return false;
    await this.takeUpdate(running);
    return true;
  }

  /**
   * Take the newest build of a running client. The server decides which build
   * is current; the host launches it again, verifies it, and the activation
   * moves the windows. A review the new build needs shows on the launch gate.
   */
  private async takeUpdate(running: RunningClient): Promise<void> {
    await this.launch({ source: running.source });
  }

  /** Development mode (per client, per device): rebuilds are taken as soon as they are announced. */
  setDevelopmentMode(clientId: string, enabled: boolean): void {
    this.deps.state.setDevelopment(clientId, enabled);
  }

  // ---------------------------------------------------------------------------
  // Trust and sessions
  // ---------------------------------------------------------------------------

  private runningByPrincipal(principalId: string): RunningClient | null {
    for (const running of this.running.values()) {
      if (running.principalId === principalId) return running;
    }
    return null;
  }

  /**
   * A client session ended for good. The server's reason is authoritative:
   * `trust-revoked` withdraws device-level powers (§4.4.1), `retired` ends the
   * client. Either way the person is told, and the client is launched again
   * only if the server still offers it without what was withdrawn.
   */
  sessionEnded(caller: ScopedServerCaller, reason: string): void {
    if (this.shuttingDown) return;
    const running = this.runningByPrincipal(caller.callerId);
    if (!running) return;
    if (reason !== "trust-revoked" && reason !== "retired") {
      log.warn(`Client ${running.clientId} session ended: ${reason}`);
      return;
    }
    if (this.retiring.has(running.clientId)) return;
    this.retiring.add(running.clientId);
    void this.retire(running, reason).finally(() => this.retiring.delete(running.clientId));
  }

  private async retire(running: RunningClient, reason: "trust-revoked" | "retired"): Promise<void> {
    const { clientId, title, source } = running;
    // One window must exist while another launch is prepared, or the app would quit.
    this.deps.gate.present(title, { status: "starting", reason: `${title} is restarting.` });
    const why =
      reason === "trust-revoked"
        ? `${title} no longer holds the device powers it was trusted with, so it was closed.`
        : `${title} was retired by this workspace, so it was closed.`;
    this.forget(running);
    this.deps.windows.closeClient(clientId, reason);
    this.deps.notify(`${title} was closed`, why);
    if (reason === "retired") return;
    // Optional capabilities may simply be gone: launch it again and let the
    // server say whether it still runs without what was withdrawn.
    try {
      await this.launch({ source });
    } catch (error) {
      log.warn(`${clientId} could not relaunch after its trust changed: ${String(error)}`);
    }
  }

  /** The capability set the server vets for a running client changed; the host enforces it at once. */
  private applyGrantedCapabilities(change: SupervisionChange): void {
    const announced = change.client;
    if (!announced || announced.runtime !== "web") return;
    const running = this.running.get(announced.id);
    if (!running || running.source !== change.source) return;
    const next = announced.grantedCapabilities.filter(isClientCapability);
    if (sameCapabilities(running.client.grantedCapabilities, next)) return;
    // Panel hosting is what the window is, not a setting: only a launch changes it.
    if (
      next.includes("panel-hosting") !==
      running.client.grantedCapabilities.includes("panel-hosting")
    ) {
      return;
    }
    running.client = { ...running.client, grantedCapabilities: next };
    for (const window of this.deps.windows.windowsOf(running.clientId))
      window.setCapabilities(next);
    this.deps.capabilitiesChanged?.(running.clientId, next);
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  /** A window ended. Its client stops when its last window does. */
  windowClosed(window: ClientWindow): void {
    this.inbox.retire(window.windowId);
    const running = this.running.get(window.spec.clientId);
    if (!running || this.deps.windows.windowsOf(running.clientId).length > 0) return;
    this.forget(running);
  }

  private forget(running: RunningClient): void {
    this.running.delete(running.clientId);
    this.deps.clientStopped?.(running.clientId);
    for (const buildKey of running.builds) this.catalog.retire(running.clientId, buildKey);
    void running.observer.stop().catch((error: unknown) => {
      log.warn(`Could not stop observing ${running.clientId}: ${String(error)}`);
    });
    void this.retainBuilds().catch((error: unknown) => {
      log.warn(`Could not collect the client cache: ${String(error)}`);
    });
  }

  /** A client's renderer takes the intents that arrived before it mounted, then receives them live. */
  subscribeIntents(windowId: string, send: (intent: ClientIntent) => void): void {
    this.inbox.subscribe(windowId, send);
  }

  /**
   * Run a foreground intent in a compact window of a running client, for a
   * global shortcut: one more window of the client, small, beside its own. A
   * client that is not running is launched with the intent; a client that hosts
   * panels has one window only, which receives the intent.
   */
  async openIntentWindow(clientId: string, intent: ClientIntent): Promise<void> {
    const running = this.running.get(clientId);
    const base = this.deps.windows.windowsOf(clientId).at(-1);
    if (!running || !base) {
      await this.launch({ id: clientId, intent: intent.name, params: intent.params });
      return;
    }
    if (base.hostsPanels) {
      this.inbox.deliver(base.windowId, intent);
      base.show();
      return;
    }
    const window = await this.deps.windows.open({ ...base.spec, compact: true });
    this.inbox.deliver(window.windowId, intent);
  }

  /** A client opened another window of itself, at a page of its own verified build. */
  async openSibling(clientId: string, url: string): Promise<void> {
    const running = this.running.get(clientId);
    if (!running) throw new Error(`${clientId} is not running`);
    if (!this.catalog.lookup(url)) {
      throw new Error(`${url} is not a verified page of ${clientId}`);
    }
    const base = this.deps.windows.windowsOf(clientId).at(-1)?.spec;
    if (!base) throw new Error(`${clientId} has no window to open another from`);
    await this.deps.windows.open({ ...base, entryUrl: url });
  }

  runningClient(clientId: string): ReadyClient | null {
    return this.running.get(clientId)?.client ?? null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.releaseSupervision?.();
    this.releaseSupervision = null;
    await Promise.allSettled([...this.running.values()].map((running) => running.observer.stop()));
    this.running.clear();
  }
}

function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability));
}
