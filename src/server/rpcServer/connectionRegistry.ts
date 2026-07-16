import type { RpcClient } from "@vibestudio/rpc";
import type { CallerKind, WsClientInfo } from "@vibestudio/shared/serviceDispatcher";
import type { ClientPlatform } from "@vibestudio/shared/panel/panelLease";
import { WebSocket } from "ws";
import type { WsServerTransportInternal } from "../wsServerTransport.js";

/** Server-side state for a connected WebSocket client. */
export interface WsClientState extends WsClientInfo {
  ws: WebSocket;
  authenticatedAt: number;
  /**
   * Owning user — a denormalized, non-null mirror of
   * `caller.subject.userId`, stamped once at connection admission so the hot
   * presence and routing paths do not re-walk `subject` on every read.
   */
  userId: string;
  authorizedBy?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: ClientPlatform;
}

export interface ConnectionRegistryOptions {
  onConnectionsChangedListenerError: (error: unknown) => void;
}

/**
 * Owns the live connection indexes and their per-connection RPC bridges.
 *
 * Connection admission and message routing remain RpcServer responsibilities;
 * this registry only keeps those independently indexed views coherent.
 */
export class ConnectionRegistry {
  private clients = new Map<WebSocket, WsClientState>();
  private callerConnections = new Map<string, Map<string, WsClientState>>();
  private bridges = new Map<string, Map<string, RpcClient>>();
  private transports = new Map<string, Map<string, WsServerTransportInternal>>();
  /**
   * Reverse index userId -> concrete live connections. The same shared runtime
   * principal can have independently authorized connections for different
   * users, so indexing only callerIds would cross-attribute presence.
   */
  private usersByUserId = new Map<string, Set<WsClientState>>();
  private connectionsChangedListeners = new Set<() => void>();

  constructor(private readonly options: ConnectionRegistryOptions) {}

  getBySocket(ws: WebSocket): WsClientState | undefined {
    return this.clients.get(ws);
  }

  getConnection(callerId: string, connectionId: string): WsClientState | undefined {
    const client = this.callerConnections.get(callerId)?.get(connectionId);
    return client?.ws.readyState === WebSocket.OPEN ? client : undefined;
  }

  isActiveClient(client: WsClientState): boolean {
    return (
      this.callerConnections.get(client.caller.runtime.id)?.get(client.connectionId) === client
    );
  }

  getCallerConnections(callerId: string): WsClientState[] {
    return [...(this.callerConnections.get(callerId)?.values() ?? [])].filter(
      (client) => client.ws.readyState === WebSocket.OPEN
    );
  }

  pickPrimary(callerId: string): WsClientState | undefined {
    return this.getCallerConnections(callerId).sort(
      (a, b) =>
        a.authenticatedAt - b.authenticatedAt || a.connectionId.localeCompare(b.connectionId)
    )[0];
  }

  addClient(client: WsClientState): void {
    let callerClients = this.callerConnections.get(client.caller.runtime.id);
    if (!callerClients) {
      callerClients = new Map();
      this.callerConnections.set(client.caller.runtime.id, callerClients);
    }
    const replaced = callerClients.get(client.connectionId);
    if (replaced && replaced !== client) {
      this.removeClient(replaced);
      callerClients = this.callerConnections.get(client.caller.runtime.id) ?? new Map();
      this.callerConnections.set(client.caller.runtime.id, callerClients);
    }
    this.clients.set(client.ws, client);
    callerClients.set(client.connectionId, client);
    let userClients = this.usersByUserId.get(client.userId);
    if (!userClients) {
      userClients = new Set();
      this.usersByUserId.set(client.userId, userClients);
    }
    userClients.add(client);
    this.emitConnectionsChanged();
  }

  removeClient(client: WsClientState): boolean {
    const current = this.callerConnections.get(client.caller.runtime.id)?.get(client.connectionId);
    const removedActive = current === client;
    if (removedActive) {
      const callerClients = this.callerConnections.get(client.caller.runtime.id);
      callerClients?.delete(client.connectionId);
      if (callerClients?.size === 0) {
        this.callerConnections.delete(client.caller.runtime.id);
      }
      const userClients = this.usersByUserId.get(client.userId);
      userClients?.delete(client);
      if (userClients?.size === 0) this.usersByUserId.delete(client.userId);
      this.removeBridge(client.caller.runtime.id, client.connectionId);
    }
    this.clients.delete(client.ws);
    if (removedActive) this.emitConnectionsChanged();
    return removedActive;
  }

  /** userIds with at least one OPEN connection to this workspace child. */
  listUsersWithLiveConnections(): string[] {
    return [...this.usersByUserId.keys()].filter((userId) => this.isUserOnline(userId));
  }

  isUserOnline(userId: string): boolean {
    return this.getUserConnections(userId).length > 0;
  }

  /** All active OPEN connections authorized for `userId`. */
  getUserConnections(userId: string): WsClientState[] {
    return [...(this.usersByUserId.get(userId) ?? [])].filter(
      (client) => client.ws.readyState === WebSocket.OPEN && this.isActiveClient(client)
    );
  }

  onConnectionsChanged(listener: () => void): () => void {
    this.connectionsChangedListeners.add(listener);
    return () => this.connectionsChangedListeners.delete(listener);
  }

  /** Fire the change signal from outside the registry, such as session expiry. */
  notifyConnectionsChanged(): void {
    this.emitConnectionsChanged();
  }

  private emitConnectionsChanged(): void {
    for (const listener of this.connectionsChangedListeners) {
      try {
        listener();
      } catch (error) {
        this.options.onConnectionsChangedListenerError(error);
      }
    }
  }

  setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcClient,
    transport: WsServerTransportInternal
  ): void {
    let bridges = this.bridges.get(callerId);
    if (!bridges) {
      bridges = new Map();
      this.bridges.set(callerId, bridges);
    }
    bridges.set(connectionId, bridge);

    let transports = this.transports.get(callerId);
    if (!transports) {
      transports = new Map();
      this.transports.set(callerId, transports);
    }
    transports.set(connectionId, transport);
  }

  getBridge(callerId: string, connectionId: string): RpcClient | undefined {
    return this.bridges.get(callerId)?.get(connectionId);
  }

  getPrimaryBridge(callerId: string): RpcClient | undefined {
    const primary = this.pickPrimary(callerId);
    return primary ? this.getBridge(callerId, primary.connectionId) : undefined;
  }

  getTransport(callerId: string, connectionId: string): WsServerTransportInternal | undefined {
    return this.transports.get(callerId)?.get(connectionId);
  }

  removeBridge(callerId: string, connectionId: string): void {
    const transports = this.transports.get(callerId);
    const transport = transports?.get(connectionId);
    if (transport) {
      transport.close();
      transports?.delete(connectionId);
      if (transports?.size === 0) this.transports.delete(callerId);
    }

    const bridges = this.bridges.get(callerId);
    bridges?.delete(connectionId);
    if (bridges?.size === 0) this.bridges.delete(callerId);
  }

  closeConnection(callerId: string, connectionId: string, code: number, reason: string): void {
    this.callerConnections.get(callerId)?.get(connectionId)?.ws.close(code, reason);
  }

  countByKinds(kinds: ReadonlySet<CallerKind>): number {
    let count = 0;
    for (const callerClients of this.callerConnections.values()) {
      for (const client of callerClients.values()) {
        if (kinds.has(client.caller.runtime.kind) && client.ws.readyState === WebSocket.OPEN) {
          count++;
        }
      }
    }
    return count;
  }

  closeAll(code: number, reason: string): void {
    for (const transports of this.transports.values()) {
      for (const transport of transports.values()) {
        transport.close();
      }
    }
    for (const ws of this.clients.keys()) {
      ws.close(code, reason);
    }
    this.clients.clear();
    this.callerConnections.clear();
    this.usersByUserId.clear();
    this.bridges.clear();
    this.transports.clear();
    this.emitConnectionsChanged();
  }
}
