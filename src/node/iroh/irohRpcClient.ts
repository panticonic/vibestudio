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
import { createRpcClient, type RpcClient, type RpcStreamOptions } from "@vibestudio/rpc";
import {
  createIrohClientPipe,
  type IrohClientPipe,
  type IrohClientSession,
} from "@vibestudio/rpc/transports/irohClient";
import { createReconnectingIrohClientPipe } from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { DeviceCredential, PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";

export interface IrohRpcClientOptions {
  reach: IrohReach;
  endpointSecret: Uint8Array;
  callerId: string;
  callerKind?: CallerKind;
  getToken(): string | Promise<string>;
  connectionId?: string;
  clientLabel?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  onPaired?(credential: DeviceCredential, context?: PairingContext): void | Promise<void>;
  onRecovery?(kind: RecoveryKind): void | Promise<void>;
  onTerminalClose?(error: Error): void;
  overallDialDeadlineMs?: number;
  perRelayDeadlineMs?: number;
}

interface Connected {
  pipe: IrohClientPipe;
  session: IrohClientSession;
  rpc: RpcClient;
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

  constructor(private readonly options: IrohRpcClientOptions) {
    assertIrohReach(options.reach);
    if (options.endpointSecret.byteLength !== 32) {
      throw new Error("Iroh endpoint secret must contain exactly 32 bytes");
    }
    const secretKey = loadIrohNodeBinding().SecretKey.fromBytes([...options.endpointSecret]);
    this.endpointOwner = new EndpointGenerationOwner(
      createNodeEndpointBinding({ secretKey, relayUrls: options.reach.relays })
    );
  }

  ready(): Promise<void> {
    return this.ensureConnected().then(() => undefined);
  }

  async callerId(): Promise<string> {
    return (await this.ensureConnected()).callerId;
  }

  async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    return (await this.ensureConnected()).rpc.call<T>("main", method, args);
  }

  async callTarget<T = unknown>(target: string, method: string, args: unknown[] = []): Promise<T> {
    return (await this.ensureConnected()).rpc.call<T>(target, method, args);
  }

  async stream(
    target: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    return (await this.ensureConnected()).rpc.stream(target, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    const { rpc } = await this.ensureConnected();
    return rpc.on(event, (context) => listener(context.payload, context.caller.callerId));
  }

  async onRecovery(handler: (kind: RecoveryKind) => void | Promise<void>): Promise<() => void> {
    this.recoveryListeners.add(handler);
    return () => this.recoveryListeners.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connected = this.connected;
    this.connected = null;
    if (connected) await (await connected).pipe.close().catch(() => undefined);
    await this.endpointOwner.close();
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
      closeEndpoint: () => this.endpointOwner.close(),
    });
    const connectionId = this.options.connectionId ?? randomUUID();
    const session = pipe.openSession({
      sid: connectionId,
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
    const rpc = createRpcClient({
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
