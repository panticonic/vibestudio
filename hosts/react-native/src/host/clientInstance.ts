import type { LaunchedClient } from "@vibestudio/client-host-core";
import type {
  InstalledLauncher,
  InstallLauncherOutcome,
} from "@vibestudio/rn-client-api/integrationProtocol";
import type {
  BrowserImportArchiveHandle,
  ClientDescription,
  ClientHostEvent,
  ClientIntent,
  UpdateOffer,
} from "@vibestudio/rn-client-api/protocol";
import { clientPrincipalId, type ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { createClientBroker, type ClientBroker, type ClientBrokerOptions } from "./clientBroker";
import type { HostState } from "./hostState";
import { ClientSessionRelay, type SessionOpeners } from "./sessionRelay";
import { BrokerError } from "./ports";
import type { HostNotifications } from "./notifications/hostNotifications";

/** The session id of the principal session the host itself holds for a running client. */
const HELD_PRINCIPAL_SESSION_ID = "s-host-held-principal";

/** What a client's `clipboard`, `open-external` and `browser-import` calls reach on the device. */
export interface DeviceCapabilityPorts {
  setClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  browserImport: {
    openSafariExport(): Promise<{ opened: boolean; unavailableReason?: string }>;
    pickArchive(): Promise<BrowserImportArchiveHandle | null>;
    readEntry(
      handle: string,
      name: string,
      offset: number,
      maxBytes: number
    ): Promise<{ dataBase64: string; eof: boolean }>;
    releaseArchive(handle: string): Promise<void>;
  };
}

/** What a client's `integration.*` calls reach: the host runtime's launchers. */
export interface IntegrationPorts {
  install(id: string): Promise<{ outcome: InstallLauncherOutcome }>;
  list(): InstalledLauncher[];
  remove(id: string): Promise<void>;
}

/** What the host runtime does on a running client's behalf; each is the host's decision, made when asked. */
export interface ClientInstanceHooks {
  /** Reload this client's instance onto the build announced (or the newest ready one). */
  restart(): Promise<void>;
  /** Return to the previous trusted build, then reload onto it. */
  rollback(): Promise<void>;
  /** The server withdrew this client's trust: tear the instance down with a message. */
  trustRevoked(): void;
  /** Forget this device's pairing. */
  resetDevice(): Promise<void>;
}

export interface ClientInstanceOptions {
  launched: LaunchedClient;
  platform: "android" | "ios";
  openers: SessionOpeners;
  state: HostState;
  device: DeviceCapabilityPorts;
  integration: IntegrationPorts;
  hooks: ClientInstanceHooks;
  /** The `notifications.*` handlers (the notification port owns them). */
  notifications: HostNotifications["handlers"];
  /** Deliver one event to the client's React Native instance. */
  deliver(event: ClientHostEvent): void;
  intent: ClientIntent | null;
}

/**
 * The host's half of one running client: the client's identity, the
 * capabilities it holds, its sessions and its broker. One of these exists per
 * client RN instance and per build; an update reload replaces it.
 */
export class ClientInstance {
  readonly principalId: string;
  readonly clientId: string;
  readonly broker: ClientBroker;
  readonly relay: ClientSessionRelay;
  private granted: ClientCapability[];
  private pendingUpdate: UpdateOffer | null = null;
  private pendingIntent: ClientIntent | null;
  private stopped = false;

  constructor(private readonly options: ClientInstanceOptions) {
    const { client, grant } = options.launched;
    this.clientId = client.id;
    this.principalId = clientPrincipalId(client.id, "react-native", grant.deviceId);
    this.granted = [...client.grantedCapabilities];
    this.pendingIntent = options.intent;
    this.relay = new ClientSessionRelay({
      tag: this.principalId,
      openers: options.openers,
      emit: (event) => this.deliver(event),
      onTrustRevoked: () => options.hooks.trustRevoked(),
    });
    this.broker = createClientBroker({
      granted: () => this.granted,
      handlers: this.handlers(),
    });
  }

  get capabilities(): readonly ClientCapability[] {
    return this.granted;
  }

  describe(): ClientDescription {
    const { client, grant } = this.options.launched;
    return {
      principalId: this.principalId,
      clientId: client.id,
      source: client.source,
      title: client.title,
      buildKey: client.buildKey,
      effectiveVersion: client.effectiveVersion,
      deviceId: grant.deviceId,
      platform: this.options.platform,
      grantedCapabilities: [...this.granted],
      developmentMode: this.options.state.isDevelopment(client.id),
      intent: this.pendingIntent,
    };
  }

  /** The host widened or narrowed this instance's grants (the server announced it). */
  setCapabilities(granted: readonly ClientCapability[]): void {
    this.granted = [...granted];
    this.deliver({ type: "capabilities", granted: [...granted] });
  }

  /** The set of confirmed launchers changed; only a client that may install launchers hears of it. */
  announceLaunchers(launchers: InstalledLauncher[]): void {
    if (this.granted.includes("integration.install")) {
      this.deliver({ type: "integration-launchers", launchers });
    }
  }

  offerUpdate(offer: UpdateOffer): void {
    this.pendingUpdate = offer;
    this.deliver({ type: "update", update: offer });
  }

  deliverIntent(intent: ClientIntent): void {
    this.deliver({ type: "intent", intent });
  }

  deliver(event: ClientHostEvent): void {
    if (!this.stopped) this.options.deliver(event);
  }

  /**
   * A running client always holds its principal session, whether or not its
   * JavaScript ever opens one: the server's authoritative close
   * (`trust-revoked`) is observed on it and tears the instance down.
   */
  holdPrincipalSession(): void {
    this.relay.openPrincipal(HELD_PRINCIPAL_SESSION_ID, this.principalToken);
  }

  /** The instance is going away: no event reaches it and every session is retired. */
  async dispose(): Promise<void> {
    this.stopped = true;
    await this.relay.dispose();
  }

  // -------------------------------------------------------------------------

  /**
   * The credential is reusable and bound to the verified build: every
   * (re)authentication presents the one the launch acquired. A server that no
   * longer honours it closes the session for good.
   */
  private principalToken = async (): Promise<string> => this.options.launched.grant.credential;

  private handlers(): ClientBrokerOptions["handlers"] {
    const { device, hooks, notifications, integration } = this.options;
    const state = this.options.state.clientState(this.clientId);
    const relay = this.relay;
    return {
      "client.describe": () => this.describe(),
      "session.openPrincipal": (sessionId) => relay.openPrincipal(sessionId, this.principalToken),
      "session.openAccountControl": (sessionId) => relay.openAccountControl(sessionId),
      "session.openWorkspace": (sessionId, workspaceId) =>
        relay.openWorkspace(sessionId, workspaceId),
      "session.openAuxiliary": (sessionId, spec) => relay.openAuxiliary(sessionId, spec),
      "session.provideToken": (sessionId, outcome) => relay.provideToken(sessionId, outcome),
      "session.ready": (sessionId) => relay.ready(sessionId),
      "session.waitUntilConnected": (sessionId, timeoutMs) =>
        relay.waitUntilConnected(sessionId, timeoutMs),
      "session.close": (sessionId) => relay.close(sessionId),
      "session.postEnvelope": (sessionId, envelope) => relay.postEnvelope(sessionId, envelope),
      "session.streamOpen": (sessionId, msg) => relay.streamOpen(sessionId, msg),
      "session.streamBodyChunk": (sessionId, msg) => relay.streamBodyChunk(sessionId, msg),
      "session.streamAbort": (sessionId, opId) => relay.streamAbort(sessionId, opId),
      "session.streamAck": (sessionId, opId, seq) => relay.streamAck(sessionId, opId, seq),
      "state.get": (key) => state.get(key),
      "state.set": (key, value) => state.set(key, value),
      "state.remove": (key) => state.remove(key),
      "state.keys": () => state.keys(),
      "updates.pending": () => this.pendingUpdate,
      "updates.restartAtSafePoint": () => {
        if (!this.pendingUpdate) {
          throw new BrokerError("NO_UPDATE", "There is no update to restart into.");
        }
        return hooks.restart();
      },
      "updates.rollback": () => hooks.rollback(),
      "intent.take": () => {
        const intent = this.pendingIntent;
        this.pendingIntent = null;
        return intent;
      },
      "clipboard.setString": (text) => device.setClipboard(text),
      "openExternal.open": (url) => device.openExternal(url),
      "browserImport.openSafariExport": () => device.browserImport.openSafariExport(),
      "browserImport.pickArchive": () => device.browserImport.pickArchive(),
      "browserImport.readEntry": (handle, name, offset, maxBytes) =>
        device.browserImport.readEntry(handle, name, offset, maxBytes),
      "browserImport.releaseArchive": (handle) => device.browserImport.releaseArchive(handle),
      "integration.install": ({ id }) => integration.install(id),
      "integration.list": () => integration.list(),
      "integration.remove": ({ id }) => integration.remove(id),
      "device.reset": () => hooks.resetDevice(),
      "device.setDevelopmentMode": (enabled) =>
        this.options.state.setDevelopment(this.clientId, enabled),
      ...notifications,
    };
  }
}
