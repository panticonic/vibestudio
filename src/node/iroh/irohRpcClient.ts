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
import {
  type RpcStreamOptions,
  type RpcCallOptions,
  type DecodedFramedStream,
} from "@vibestudio/rpc";
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
  getToken(signal?: AbortSignal): string | Promise<string>;
  connectionId?: string;
  clientLabel?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  onPaired?(credential: DeviceCredential): void | Promise<void>;
  onRecovery?(kind: RecoveryKind): void | Promise<void>;
  onTerminalClose?(error: Error): void;
  overallDialDeadlineMs?: number;
  perRelayDeadlineMs?: number;
  signal?: AbortSignal;
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
  private pipe: IrohClientPipe | null = null;
  private pipeRetirement: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
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
      options.signal?.addEventListener("abort", this.cancel, { once: true });
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
    options.signal?.addEventListener("abort", this.cancel, { once: true });
  }
  private readonly cancel = () => {
    void this.close().catch(() => undefined);
  };

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
      {
        ...options,
        signal: options.signal ?? this.options.signal,
        endpointSecret: this.options.endpointSecret,
      },
      this.endpointOwner
    );
  }

  ready(): Promise<void> {
    return this.ensureConnected().then(() => undefined);
  }

  async callerId(): Promise<string> {
    return (await this.ensureConnected()).callerId;
  }

  async call(
    method: QualifiedServiceMethod,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    return this.callTarget("main", method, args, options);
  }

  async callTarget(
    target: string,
    method: string,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    if (target === "main") requireQualifiedServiceMethod(method);
    return (await this.ensureConnected()).rpc.call(target, method, args, options);
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
  async streamReadable(
    target: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<DecodedFramedStream> {
    if (target === "main") requireQualifiedServiceMethod(method);
    return (await this.ensureConnected()).rpc.streamReadable(target, method, args, options);
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
      signal?: AbortSignal;
    }
  ): Promise<IrohClientSession> {
    options.signal?.throwIfAborted();
    const { pipe } = await this.ensureConnected();
    const session = pipe.openSession({
      ...options,
      connectionId: options.connectionId ?? randomUUID(),
    });
    const closeSession = session.close.bind(session);
    let retirement: Promise<void> | undefined;
    const close = () => (retirement ??= closeSession());
    const cancel = () => {
      void close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      await session.ready?.();
      options.signal?.throwIfAborted();
    } catch (error) {
      const failure = options.signal?.aborted ? options.signal.reason : error;
      options.signal?.removeEventListener("abort", cancel);
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError(
          [failure, cleanup],
          "Iroh session admission and retirement failed",
          {
            cause: failure,
          }
        );
      }
      throw failure;
    }
    return Object.assign(session, {
      close: async () => {
        options.signal?.removeEventListener("abort", cancel);
        await close();
      },
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.cancel);
    const connected = this.connected;
    // The pipe owns acquisition already, even while authentication is pending.
    // Closing it retires session I/O and the owned endpoint before joining ready.
    const retirement = this.retirePipe();
    return (this.closePromise = (async () => {
      const results = await Promise.allSettled([retirement, connected?.catch(() => undefined)]);
      this.connected = null;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Iroh RPC client retirement failed");
    })());
  }

  private retirePipe(): Promise<void> {
    const pipe = this.pipe;
    return (this.pipeRetirement ??= Promise.resolve().then(() =>
      pipe ? pipe.close() : this.ownsEndpoint ? this.endpointOwner.close() : undefined
    ));
  }

  private ensureConnected(): Promise<Connected> {
    this.options.signal?.throwIfAborted();
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
    this.pipe = pipe;
    this.pipeRetirement = null;
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
    try {
      await session.ready?.();
    } catch (error) {
      const failure = this.options.signal?.aborted ? this.options.signal.reason : error;
      try {
        await this.retirePipe();
      } catch (cleanup) {
        throw new AggregateError([failure, cleanup], "Iroh authentication and retirement failed", {
          cause: failure,
        });
      }
      throw failure;
    }
    this.options.signal?.throwIfAborted();
    if (this.closed) throw new Error("Iroh RPC client is closed");
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
