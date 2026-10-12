import { createInternalRpcClient, type RpcWireClient } from "@vibestudio/rpc/internal";
import { randomUUID } from "node:crypto";
import {
  EndpointGenerationOwner,
  assertIrohReach,
  type IrohReach,
} from "@vibestudio/iroh-transport";
import {
  createNodeEndpointBinding,
  loadIrohNodeBinding,
  type NodePhysicalConnection,
  type NodePhysicalEndpoint,
} from "@vibestudio/iroh-transport/node";
import { type RpcStreamOptions } from "@vibestudio/rpc";
import {
  createIrohClientPipe,
  type IrohClientPipe,
  type IrohClientSession,
  type IrohClientSessionOptions,
} from "@vibestudio/rpc/transports/irohClient";
import { createReconnectingIrohClientPipe } from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { DeviceCredential } from "@vibestudio/rpc/protocol/wsProtocol";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import {
  requireQualifiedServiceMethod,
  type QualifiedServiceMethod,
} from "@vibestudio/shared/typedServiceClient";

export interface IrohRpcClientOptions {
  reach: IrohReach;
  endpointSecret: Uint8Array;
  callerId: string;
  callerKind?: CallerKind;
  getToken(): string | Promise<string>;
  connectionId?: string;
  clientLabel?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  onPaired?(credential: DeviceCredential): void | Promise<void>;
  onRecovery?(kind: RecoveryKind): void | Promise<void>;
  onTerminalClose?(error: Error): void;
  overallDialDeadlineMs?: number;
  perRelayDeadlineMs?: number;
}

interface Connected {
  pipe: IrohClientPipe;
  session: IrohClientSession;
  rpc: RpcWireClient;
  callerId: string;
}

/** Node host client shared by Electron, CLI, and the headless host. */
export class IrohRpcClient {
  private readonly endpointOwner: EndpointGenerationOwner<
    NodePhysicalConnection,
    NodePhysicalEndpoint
  >;
  private connected: Promise<Connected> | null = null;
  private closed = false;
  private readonly recoveryListeners = new Set<(kind: RecoveryKind) => void | Promise<void>>();
  /** A peer client borrows its parent's endpoint; only the owner closes it. */
  private readonly ownsEndpoint: boolean;

  constructor(
    private readonly options: IrohRpcClientOptions,
    sharedEndpoint?: EndpointGenerationOwner<NodePhysicalConnection, NodePhysicalEndpoint>
  ) {
    assertIrohReach(options.reach);
    if (sharedEndpoint) {
      this.endpointOwner = sharedEndpoint;
      this.ownsEndpoint = false;
      return;
    }
    if (options.endpointSecret.byteLength !== 32) {
      throw new Error("Iroh endpoint secret must contain exactly 32 bytes");
    }
    const secretKey = loadIrohNodeBinding().SecretKey.fromBytes([...options.endpointSecret]);
    this.endpointOwner = new EndpointGenerationOwner(
      createNodeEndpointBinding({ secretKey, relayUrls: options.reach.relays })
    );
    this.ownsEndpoint = true;
  }

  /**
   * A client for another peer (for example the hub control endpoint next to a
   * workspace endpoint) dialed from this client's endpoint identity. A device
   * holds one endpoint per credential; peers share it instead of binding the
   * same Endpoint ID twice. The peer closes its own connection; the endpoint
   * stays owned by this client.
   */
  peer(options: Omit<IrohRpcClientOptions, "endpointSecret">): IrohRpcClient {
    if (this.closed) throw new Error("Iroh RPC client is closed");
    return new IrohRpcClient(
      { ...options, endpointSecret: this.options.endpointSecret },
      this.endpointOwner
    );
  }

  ready(): Promise<void> {
    return this.ensureConnected().then(() => undefined);
  }

  async callerId(): Promise<string> {
    return (await this.ensureConnected()).callerId;
  }

  async call(method: QualifiedServiceMethod, args: unknown[] = []): Promise<unknown> {
    return this.callTarget("main", method, args);
  }

  async callTarget(target: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (target === "main") requireQualifiedServiceMethod(method);
    return (await this.ensureConnected()).rpc.call(target, method, args);
  }

  async stream(
    target: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    if (target === "main") requireQualifiedServiceMethod(method);
    return (await this.ensureConnected()).rpc.stream(target, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    const { rpc } = await this.ensureConnected();
    return rpc.on(event, (context) => listener(context.payload, context.caller.callerId), {
      kind: "closed",
      reason: "This listener consumes host or implementation lifecycle events.",
    });
  }

  async onRecovery(handler: (kind: RecoveryKind) => void | Promise<void>): Promise<() => void> {
    this.recoveryListeners.add(handler);
    return () => this.recoveryListeners.delete(handler);
  }

  /**
   * Open another authenticated logical session on this client's connection,
   * for a second principal of the same device (for example the app principal
   * a terminal client runs). The session shares the physical QUIC connection
   * and the endpoint identity, so grants bound to this endpoint redeem on it.
   * The caller owns the returned session and closes it.
   */
  async openSession(
    options: Omit<IrohClientSessionOptions, "onPaired" | "connectionId"> & {
      connectionId?: string;
    }
  ): Promise<IrohClientSession> {
    const { pipe } = await this.ensureConnected();
    const session = pipe.openSession({
      ...options,
      connectionId: options.connectionId ?? randomUUID(),
    });
    try {
      await session.ready?.();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return session;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connected = this.connected;
    this.connected = null;
    if (connected) await (await connected).pipe.close().catch(() => undefined);
    if (this.ownsEndpoint) await this.endpointOwner.close();
  }

  private ensureConnected(): Promise<Connected> {
    if (this.closed) return Promise.reject(new Error("Iroh RPC client is closed"));
    return (this.connected ??= this.connect().catch((error) => {
      this.connected = null;
      throw error;
    }));
  }

  private async connect(): Promise<Connected> {
    const pipe = createReconnectingIrohClientPipe({
      peerEndpointId: this.options.reach.endpointId,
      dial: async () => {
        const dialed = await this.endpointOwner.dial({
          reach: this.options.reach,
          overallDeadlineMs: this.options.overallDialDeadlineMs ?? 30_000,
          perAttemptDeadlineMs: this.options.perRelayDeadlineMs ?? 12_000,
        });
        return createIrohClientPipe(dialed.connection, dialed);
      },
      closeEndpoint: () => (this.ownsEndpoint ? this.endpointOwner.close() : Promise.resolve()),
    });
    const connectionId = this.options.connectionId ?? randomUUID();
    const session = pipe.openSession({
      connectionId,
      clientLabel: this.options.clientLabel,
      clientPlatform: this.options.clientPlatform,
      getToken: this.options.getToken,
      onPaired: this.options.onPaired,
      onRecovery: async (kind) => {
        await this.options.onRecovery?.(kind);
        for (const listener of [...this.recoveryListeners]) await listener(kind);
      },
      onTerminalClose: this.options.onTerminalClose,
    });
    await session.ready?.();
    const callerId = session.callerId() ?? this.options.callerId;
    const rpc = createInternalRpcClient({
      selfId: callerId,
      callerKind: this.options.callerKind ?? "shell",
      transport: session,
      onRecovery: (handler) => {
        this.recoveryListeners.add(handler);
        return () => this.recoveryListeners.delete(handler);
      },
      authorityAcquisition: "wait",
    });
    return { pipe, session, rpc, callerId };
  }
}
