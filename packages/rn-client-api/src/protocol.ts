/**
 * The wire between a client's React Native instance and its host runtime
 * (docs/client-hosts-and-clients-plan.md §4.1, §4.2, §5.3).
 *
 * A mobile client runs in its own RN instance. It holds no credential, no
 * Iroh handle and no push token: every device-owned capability lives in the
 * host runtime, which is another JavaScript runtime in the same process. The two
 * talk through one native broker that does nothing but carry JSON:
 *
 *   client -> host   `VibestudioClientBroker.request(method, argsJson)`
 *   host -> client   one `VibestudioClientEvent` per {@link ClientHostEvent}
 *
 * The broker module is constructed per client instance with that instance's
 * tag, so a client cannot claim another client's identity. Everything a client
 * may do is decided in the host runtime's capability broker, by the client's
 * granted capabilities, at the moment of the call. This file is the complete
 * list of what is askable; ABI `rn-host-6` is exactly this.
 */
import type { RpcEnvelope, RpcConnectionStatus } from "@vibestudio/rpc";
import type { BridgeBodyChunk, BridgeStreamMessage, BridgeStreamOpen } from "@vibestudio/rpc";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import type { SupervisionChange } from "@vibestudio/shared/events";
import {
  NOTIFICATIONS_METHOD_CAPABILITY,
  type NotificationsHostEvent,
  type NotificationsHostMethods,
} from "./notificationsProtocol";

/** Name of the native module a client instance reaches its host through. */
export const CLIENT_BROKER_MODULE = "VibestudioClientBroker";
/**
 * The component a client bundle registers with `AppRegistry` as its root. Native
 * starts exactly this name in the client's instance; there is no per-client
 * component name in the manifest.
 */
export const CLIENT_ROOT_COMPONENT = "VibestudioClient";
/** Name of the device event carrying {@link ClientHostEvent}s to a client instance. */
export const CLIENT_EVENT_NAME = "VibestudioClientEvent";

// ---------------------------------------------------------------------------
// What a client is told about itself
// ---------------------------------------------------------------------------

export interface ClientDescription {
  /** `client:<id>:react-native:<deviceId>` */
  principalId: string;
  clientId: string;
  /** The client's source in the System workspace. */
  source: string;
  title: string;
  buildKey: string;
  effectiveVersion: string;
  deviceId: string;
  platform: "android" | "ios";
  /** Capabilities the host grants this instance right now. */
  grantedCapabilities: ClientCapability[];
  /** Development mode, per client per device: a rebuilt client is adopted at once. */
  developmentMode: boolean;
  /** The intent this instance was launched with, if any. */
  intent: ClientIntent | null;
}

export interface ClientIntent {
  name: string;
  params: Record<string, string>;
}

/** What kind of logical session a `SessionOpened` describes. */
export type SessionKind = "principal" | "shell" | "auxiliary";

export interface SessionOpened {
  /** Opaque, host-issued; every later call about this session names it. */
  sessionId: string;
  kind: SessionKind;
  /** The authenticated caller id the server knows this session as; empty until `session.ready`. */
  callerId: string;
  callerKind: "client" | "shell" | "panel";
  deviceId: string | null;
  serverId: string | null;
  status: RpcConnectionStatus;
}

export type SessionCloseReason =
  /** The System owner withdrew the client's device-level trust (§4.4.1). */
  | "trust-revoked"
  /** The server ended the session (credential revoked, principal retired). */
  | "server-closed"
  /** The client or the host closed it. */
  | "closed";

// ---------------------------------------------------------------------------
// Client -> host
// ---------------------------------------------------------------------------

export interface UpdateOffer {
  buildKey: string;
  effectiveVersion: string | null;
  previousBuildKey: string | null;
  /** The server's announcement, for the client's own update model. */
  change: SupervisionChange;
}

export interface ClientHostMethods extends NotificationsHostMethods {
  "client.describe": { args: []; result: ClientDescription };

  /**
   * Session ids are chosen by the client (a fresh UUID) and passed to the call
   * that opens the session, so the client is already listening for that
   * session's events when the host starts producing them. The host rejects a
   * malformed or reused id.
   *
   * This client's own principal session on the workspace it was launched from.
   */
  "session.openPrincipal": { args: [sessionId: string]; result: SessionOpened };
  /** `hub-control`: a session on the hub control reach. */
  "session.openAccountControl": { args: [sessionId: string]; result: SessionOpened };
  /** `device-session`: a device shell session on a routed workspace. */
  "session.openWorkspace": {
    args: [sessionId: string, workspaceId: string];
    result: SessionOpened;
  };
  /**
   * `panel-hosting`: another logical session on the connection `parentSessionId`
   * belongs to (a panel's own session). The host asks the client for the token
   * of each (re)authentication with `session-token-request`.
   */
  "session.openAuxiliary": {
    args: [
      sessionId: string,
      spec: { parentSessionId: string; label: string; connectionId?: string },
    ];
    result: SessionOpened;
  };
  /** Answer the host's `session-token-request` for this session (one outstanding at a time). */
  "session.provideToken": {
    args: [sessionId: string, outcome: { token: string } | { error: string }];
    result: void;
  };
  /** Wait for authentication; the description now carries the server-authenticated `callerId`. */
  "session.ready": { args: [sessionId: string]; result: SessionOpened };
  "session.waitUntilConnected": { args: [sessionId: string, timeoutMs: number]; result: void };
  "session.close": { args: [sessionId: string]; result: void };
  "session.postEnvelope": { args: [sessionId: string, envelope: RpcEnvelope]; result: void };
  "session.streamOpen": { args: [sessionId: string, msg: BridgeStreamOpen]; result: void };
  "session.streamBodyChunk": { args: [sessionId: string, msg: BridgeBodyChunk]; result: void };
  "session.streamAbort": { args: [sessionId: string, opId: string]; result: void };
  "session.streamAck": { args: [sessionId: string, opId: string, seq: number]; result: void };

  /** Client-scoped persisted state; keys never leave this client's namespace. */
  "state.get": { args: [key: string]; result: string | null };
  "state.set": { args: [key: string, value: string]; result: void };
  "state.remove": { args: [key: string]; result: void };
  "state.keys": { args: []; result: string[] };

  /** The newest ready build the host has announced and the client has not taken. */
  "updates.pending": { args: []; result: UpdateOffer | null };
  /** Reload this client's instance onto the announced build, at the client's chosen safe point. */
  "updates.restartAtSafePoint": { args: []; result: void };
  /** Return to the previous trusted build, then reload onto it. */
  "updates.rollback": { args: []; result: void };

  "intent.take": { args: []; result: ClientIntent | null };

  /** `clipboard` */
  "clipboard.setString": { args: [text: string]; result: void };
  /** `open-external` */
  "openExternal.open": { args: [url: string]; result: void };

  /** `browser-import` */
  "browserImport.openSafariExport": {
    args: [];
    result: { opened: boolean; unavailableReason?: string };
  };
  "browserImport.pickArchive": { args: []; result: BrowserImportArchiveHandle | null };
  "browserImport.readEntry": {
    args: [handle: string, name: string, offset: number, maxBytes: number];
    result: { dataBase64: string; eof: boolean };
  };
  "browserImport.releaseArchive": { args: [handle: string]; result: void };

  /** `device-session`: forget this device's pairing. Every client is torn down; the host returns to pairing. */
  "device.reset": { args: []; result: void };
  /** `device-session`: development mode for this client on this device. */
  "device.setDevelopmentMode": { args: [enabled: boolean]; result: void };
}

export interface BrowserImportArchiveEntry {
  name: string;
  size: number;
}

export interface BrowserImportArchiveHandle {
  handle: string;
  displayName: string;
  mimeType?: string;
  size: number;
  entries: BrowserImportArchiveEntry[];
}

export type ClientHostMethod = keyof ClientHostMethods;

/**
 * The capability each method needs, or `null` for the methods every client has
 * (a client's own principal session, its own state, its own updates and intents).
 * The host broker enforces this table; the client API does not duplicate it.
 */
export const METHOD_CAPABILITY: Readonly<Record<ClientHostMethod, ClientCapability | null>> = {
  "client.describe": null,
  "session.openPrincipal": null,
  "session.openAccountControl": "hub-control",
  "session.openWorkspace": "device-session",
  "session.openAuxiliary": "panel-hosting",
  "session.provideToken": null,
  "session.ready": null,
  "session.waitUntilConnected": null,
  "session.close": null,
  "session.postEnvelope": null,
  "session.streamOpen": null,
  "session.streamBodyChunk": null,
  "session.streamAbort": null,
  "session.streamAck": null,
  "state.get": null,
  "state.set": null,
  "state.remove": null,
  "state.keys": null,
  "updates.pending": null,
  "updates.restartAtSafePoint": null,
  "updates.rollback": null,
  "intent.take": null,
  "clipboard.setString": "clipboard",
  "openExternal.open": "open-external",
  "browserImport.openSafariExport": "browser-import",
  "browserImport.pickArchive": "browser-import",
  "browserImport.readEntry": "browser-import",
  "browserImport.releaseArchive": "browser-import",
  "device.reset": "device-session",
  "device.setDevelopmentMode": "device-session",
  ...NOTIFICATIONS_METHOD_CAPABILITY,
};

// ---------------------------------------------------------------------------
// Host -> client
// ---------------------------------------------------------------------------

export type ClientHostEvent =
  | { type: "session-envelope"; sessionId: string; envelope: RpcEnvelope }
  | { type: "session-stream"; sessionId: string; msg: BridgeStreamMessage }
  | { type: "session-status"; sessionId: string; status: RpcConnectionStatus }
  | { type: "session-recovery"; sessionId: string; kind: "resubscribe" | "cold-recover" }
  | {
      type: "session-reconnect-progress";
      sessionId: string;
      progress: {
        attempt: number;
        phase: "scheduled" | "failed";
        reason: string;
        nextRetryInMs?: number;
      };
    }
  | { type: "session-token-request"; sessionId: string }
  | { type: "session-closed"; sessionId: string; reason: SessionCloseReason; message: string }
  | { type: "update"; update: UpdateOffer }
  | { type: "intent"; intent: ClientIntent }
  | { type: "capabilities"; granted: ClientCapability[] }
  | NotificationsHostEvent;

/** A failure the broker carries back to a client call, with the host's code. */
export interface BrokerFailure {
  code: string;
  message: string;
}
