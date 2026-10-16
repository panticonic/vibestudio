import { createRpcClient, secureRandomUuid, type RpcClient } from "@vibestudio/rpc";
import type { BrokerChannel, EventHub } from "./channel";
import {
  createRemoteSession,
  type ReconnectProgress,
  type RecoveryKind,
  type RemoteSession,
} from "./remoteSession";
import type { SessionOpened } from "./protocol";

/** Options of an auxiliary session (a panel's own session on the workspace connection). */
export interface AuxiliarySessionOptions {
  label: string;
  /** The exact connection identity the server expects (a panel's lease connection id). */
  connectionId?: string;
  /** The token for each (re)authentication of this session. */
  getToken(signal?: AbortSignal): string | Promise<string>;
}

/**
 * A client's session on one reach plus the `RpcClient` built on it. It has the
 * shape the mobile clients already consume (`rpc`, `session`, `callerId`,
 * `serverId`, `deviceId`, `hubControlRpc`, `transport.openSession`,
 * `waitUntilConnected`, `close`), but the credential and the physical
 * connection are the host's.
 */
export interface RemoteConnection {
  readonly rpc: RpcClient;
  readonly session: RemoteSession;
  readonly callerId: string;
  readonly deviceId: string | null;
  readonly serverId: string | null;
  /** Hub control on the same account, when this connection belongs to one. */
  readonly hubControlRpc?: RpcClient;
  readonly transport: {
    openSession(options: AuxiliarySessionOptions): RemoteSession;
    onReconnectProgress(handler: (progress: ReconnectProgress) => void): () => void;
  };
  waitUntilConnected(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface RemoteConnectionDeps {
  channel: BrokerChannel;
  hub: EventHub;
}

export function newSessionId(): string {
  return `s-${secureRandomUuid()}`;
}

/**
 * Open a session through the host and build its `RpcClient`. `onRecovery`
 * receives recovery kinds (the rpc client also registers its own subscription
 * handlers through the session).
 */
export async function openRemoteConnection(
  deps: RemoteConnectionDeps,
  open: (sessionId: string) => Promise<SessionOpened>,
  options: {
    onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
    hubControlRpc?: RpcClient;
  } = {}
): Promise<RemoteConnection> {
  const sessionId = newSessionId();
  const session = createRemoteSession({
    channel: deps.channel,
    hub: deps.hub,
    sessionId,
    open: () => open(sessionId),
  });
  let stopRecovery: (() => void) | undefined;
  if (options.onRecovery) {
    const onRecovery = options.onRecovery;
    stopRecovery = session.onRecovery((kind) => void onRecovery(kind));
  }
  let opened: SessionOpened;
  try {
    opened = await session.authenticated();
  } catch (error) {
    stopRecovery?.();
    await session.close().catch(() => undefined);
    throw error;
  }
  const rpc = createRpcClient({
    selfId: opened.callerId,
    callerKind: opened.callerKind,
    transport: session,
    publishExposures: opened.callerKind === "shell",
    onRecovery: (handler) => session.onRecovery(handler),
  });
  const connection: RemoteConnection = {
    rpc,
    session,
    callerId: opened.callerId,
    deviceId: opened.deviceId,
    serverId: opened.serverId,
    ...(options.hubControlRpc ? { hubControlRpc: options.hubControlRpc } : {}),
    transport: {
      openSession(auxiliary) {
        const auxiliaryId = newSessionId();
        return createRemoteSession({
          channel: deps.channel,
          hub: deps.hub,
          sessionId: auxiliaryId,
          open: () =>
            deps.channel.request("session.openAuxiliary", auxiliaryId, {
              parentSessionId: sessionId,
              label: auxiliary.label,
              ...(auxiliary.connectionId ? { connectionId: auxiliary.connectionId } : {}),
            }),
          getToken: auxiliary.getToken,
        });
      },
      onReconnectProgress: (handler) => session.onReconnectProgress(handler),
    },
    waitUntilConnected: (timeoutMs) =>
      deps.channel.request("session.waitUntilConnected", sessionId, timeoutMs),
    async close() {
      stopRecovery?.();
      await session.close();
    },
  };
  return connection;
}
