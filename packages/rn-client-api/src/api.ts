import { CURRENT_HOST_ABI, type ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { EventHub, type BrokerChannel } from "./channel";
import type {
  BrowserImportArchiveHandle,
  ClientDescription,
  ClientIntent,
  UpdateOffer,
} from "./protocol";
import type {
  DisplayedNotification,
  LocalNotification,
  NotificationOpen,
  NotificationsStatus,
} from "./notificationsProtocol";
import { openRemoteConnection, type RemoteConnection } from "./remoteConnection";
import type { RecoveryKind } from "./remoteSession";

export const RN_CLIENT_API_ABI = CURRENT_HOST_ABI["react-native"];

/** The hub-control session and the device's routed workspaces (`device-session`). */
export interface RemoteAccount {
  readonly control: RemoteConnection;
  openWorkspace(
    workspaceId: string,
    onRecovery?: (kind: RecoveryKind) => void | Promise<void>
  ): Promise<RemoteConnection>;
  /** Close the control session and every workspace session opened through this account. */
  close(): Promise<void>;
}

export interface ClientSessionApi {
  /**
   * This client's own session: the server knows it as the client principal
   * `client:<id>:react-native:<deviceId>`, on the workspace the client was
   * launched from (System).
   */
  openPrincipal(options?: {
    onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
  }): Promise<RemoteConnection>;
  /** `hub-control` + `device-session`. */
  openAccount(): Promise<RemoteAccount>;
}

export interface ClientCapabilitiesApi {
  granted(): readonly ClientCapability[];
  has(capability: ClientCapability): boolean;
  /** The host widened or narrowed this instance's grants. */
  onChange(listener: (granted: readonly ClientCapability[]) => void): () => void;
}

export interface ClientIntentApi {
  /** The intent this instance was launched with, if any. */
  readonly initial: ClientIntent | null;
  /** An intent delivered to the running instance (a deep link, a shortcut, a share). */
  onIntent(listener: (intent: ClientIntent) => void): () => void;
}

export interface ClientStateApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Update observation (§4.6). The server announces a ready build; the host
 * decides what to do. On mobile the host's policy is to ask the client to
 * prompt, then reload only this client's instance: `restartAtSafePoint` is
 * the client saying "now". In development mode the host reloads without asking.
 */
export interface ClientUpdatesApi {
  pending(): UpdateOffer | null;
  onUpdate(listener: (update: UpdateOffer) => void): () => void;
  restartAtSafePoint(): Promise<void>;
  /** Return to the previous trusted build and reload onto it. */
  rollback(): Promise<void>;
}

export interface ClientNotificationsApi {
  status(): Promise<NotificationsStatus>;
  requestPermission(): Promise<boolean>;
  display(notification: LocalNotification): Promise<void>;
  cancel(id: string): Promise<void>;
  displayed(): Promise<DisplayedNotification[]>;
  /** The notification that launched this instance, if one did. */
  takeInitialOpen(): Promise<NotificationOpen | null>;
  onOpen(listener: (open: NotificationOpen) => void): () => void;
  onTokenChange(listener: (token: string) => void): () => void;
}

export interface ClientBrowserImportApi {
  openSafariExport(): Promise<{ opened: boolean; unavailableReason?: string }>;
  pickArchive(): Promise<BrowserImportArchiveHandle | null>;
  readEntry(
    handle: string,
    name: string,
    offset: number,
    maxBytes: number
  ): Promise<{ dataBase64: string; eof: boolean }>;
  releaseArchive(handle: string): Promise<void>;
}

/**
 * The complete host API of ABI rn-host-6. Every method that needs a capability
 * fails with the host's `CAPABILITY_NOT_GRANTED` unless the instance holds it;
 * `capabilities` says which it does.
 */
export interface RnClientApi {
  readonly hostAbi: typeof RN_CLIENT_API_ABI;
  readonly client: ClientDescription;
  readonly capabilities: ClientCapabilitiesApi;
  readonly session: ClientSessionApi;
  readonly intent: ClientIntentApi;
  readonly state: ClientStateApi;
  readonly updates: ClientUpdatesApi;
  readonly notifications: ClientNotificationsApi;
  readonly clipboard: { setString(text: string): Promise<void> };
  readonly openExternal: (url: string) => Promise<void>;
  readonly browserImport: ClientBrowserImportApi;
  readonly device: {
    /** Forget this device's pairing; every client is torn down and the host returns to pairing. */
    reset(): Promise<void>;
    setDevelopmentMode(enabled: boolean): Promise<void>;
  };
}

export async function createRnClientApi(channel: BrokerChannel): Promise<RnClientApi> {
  const hub = new EventHub(channel);
  const client = await channel.request("client.describe");

  let granted: readonly ClientCapability[] = client.grantedCapabilities;
  const capabilityListeners = new Set<(granted: readonly ClientCapability[]) => void>();
  hub.ofType("capabilities", (event) => {
    granted = event.granted;
    for (const listener of [...capabilityListeners]) listener(granted);
  });

  let pending: UpdateOffer | null = await channel.request("updates.pending");
  const updateListeners = new Set<(update: UpdateOffer) => void>();
  hub.ofType("update", (event) => {
    pending = event.update;
    for (const listener of [...updateListeners]) listener(event.update);
  });

  const intentListeners = new Set<(intent: ClientIntent) => void>();
  hub.ofType("intent", (event) => {
    for (const listener of [...intentListeners]) listener(event.intent);
  });

  const openListeners = new Set<(open: NotificationOpen) => void>();
  hub.ofType("notification-open", (event) => {
    for (const listener of [...openListeners]) listener(event.open);
  });
  const tokenListeners = new Set<(token: string) => void>();
  hub.ofType("notification-token", (event) => {
    for (const listener of [...tokenListeners]) listener(event.token);
  });

  const deps = { channel, hub };

  const openAccount = async (): Promise<RemoteAccount> => {
    const control = await openRemoteConnection(deps, (sessionId) =>
      channel.request("session.openAccountControl", sessionId)
    );
    const workspaces = new Set<RemoteConnection>();
    let closing: Promise<void> | null = null;
    const account: RemoteAccount = {
      control,
      async openWorkspace(workspaceId, onRecovery) {
        if (closing) throw new Error("The mobile account is closed");
        const connection = await openRemoteConnection(
          deps,
          (sessionId) => channel.request("session.openWorkspace", sessionId, workspaceId),
          {
            hubControlRpc: control.rpc,
            ...(onRecovery ? { onRecovery } : {}),
          }
        );
        workspaces.add(connection);
        connection.session.onClosed(() => workspaces.delete(connection));
        return connection;
      },
      close() {
        closing ??= (async () => {
          const results = await Promise.allSettled([
            ...[...workspaces].map((workspace) => workspace.close()),
            control.close(),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "Mobile account connections failed to close");
          }
        })();
        return closing;
      },
    };
    return account;
  };

  return {
    hostAbi: RN_CLIENT_API_ABI,
    client,
    capabilities: {
      granted: () => granted,
      has: (capability) => granted.includes(capability),
      onChange(listener) {
        capabilityListeners.add(listener);
        return () => capabilityListeners.delete(listener);
      },
    },
    session: {
      openPrincipal: (options) =>
        openRemoteConnection(
          deps,
          (sessionId) => channel.request("session.openPrincipal", sessionId),
          options?.onRecovery ? { onRecovery: options.onRecovery } : {}
        ),
      openAccount,
    },
    intent: {
      initial: client.intent,
      onIntent(listener) {
        intentListeners.add(listener);
        return () => intentListeners.delete(listener);
      },
    },
    state: {
      get: (key) => channel.request("state.get", key),
      set: (key, value) => channel.request("state.set", key, value),
      remove: (key) => channel.request("state.remove", key),
      keys: () => channel.request("state.keys"),
    },
    updates: {
      pending: () => pending,
      onUpdate(listener) {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
      restartAtSafePoint: () => channel.request("updates.restartAtSafePoint"),
      rollback: () => channel.request("updates.rollback"),
    },
    notifications: {
      status: () => channel.request("notifications.status"),
      requestPermission: () => channel.request("notifications.requestPermission"),
      display: (notification) => channel.request("notifications.display", notification),
      cancel: (id) => channel.request("notifications.cancel", id),
      displayed: () => channel.request("notifications.displayed"),
      takeInitialOpen: () => channel.request("notifications.takeInitialOpen"),
      onOpen(listener) {
        openListeners.add(listener);
        return () => openListeners.delete(listener);
      },
      onTokenChange(listener) {
        tokenListeners.add(listener);
        return () => tokenListeners.delete(listener);
      },
    },
    clipboard: { setString: (text) => channel.request("clipboard.setString", text) },
    openExternal: (url) => channel.request("openExternal.open", url),
    browserImport: {
      openSafariExport: () => channel.request("browserImport.openSafariExport"),
      pickArchive: () => channel.request("browserImport.pickArchive"),
      readEntry: (handle, name, offset, maxBytes) =>
        channel.request("browserImport.readEntry", handle, name, offset, maxBytes),
      releaseArchive: (handle) => channel.request("browserImport.releaseArchive", handle),
    },
    device: {
      reset: () => channel.request("device.reset"),
      setDevelopmentMode: (enabled) => channel.request("device.setDevelopmentMode", enabled),
    },
  };
}
