import {
  createInternalRpcClient,
  type RpcWireClient as CoreRpcClient,
} from "@vibestudio/rpc/internal";
/**
 * WebSocket RPC client for the CLI.
 *
 * Auth: a bounded HTTP admission request redeems the device/agent credential
 * before WebSocket allocation and returns a short-lived one-use grant. The first
 * auth frame binds that grant to contract negotiation; the client never asserts
 * its own identity.
 */

import { type RpcStreamOptions, type RpcCallOptions } from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { NodeWsLike } from "@vibestudio/rpc/transports/nodeWsLike";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";
import {
  requireQualifiedServiceMethod,
  type QualifiedServiceMethod,
} from "@vibestudio/shared/typedServiceClient";

export interface WsClientConfig {
  url: string;
  callerId: string;
  callerKind: CallerKind;
  getToken: (signal?: AbortSignal) => Promise<string> | string;
  connectionId?: string;
  clientLabel?: string;
  logPrefix?: string;
  signal?: AbortSignal;
}

export class WsRpcClient {
  private transport: ReturnType<typeof wsClientTransport> | null = null;
  private transportRetirement: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private connected: Promise<{
    transport: ReturnType<typeof wsClientTransport>;
    core: CoreRpcClient;
  }> | null = null;

  constructor(private readonly config: WsClientConfig) {
    config.signal?.addEventListener("abort", this.cancel, { once: true });
  }
  private readonly cancel = () => {
    void this.close().catch(() => undefined);
  };

  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  async call(
    method: QualifiedServiceMethod,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    return this.callTarget("main", method, args, options);
  }

  async callTarget(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    if (targetId === "main") requireQualifiedServiceMethod(method);
    const { core } = await this.ensureConnected();
    return await core.call(targetId, method, args, options);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    if (targetId === "main") requireQualifiedServiceMethod(method);
    const { core } = await this.ensureConnected();
    return await core.stream(targetId, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    const { core } = await this.ensureConnected();
    return core.on(event, (ctx) => listener(ctx.payload, ctx.caller.callerId), {
      kind: "closed",
      reason: "This listener consumes host or implementation lifecycle events.",
    });
  }

  async onRecovery(handler: (kind: RecoveryKind) => void | Promise<void>): Promise<() => void> {
    const { transport } = await this.ensureConnected();
    const off1 = transport.onRecovery("resubscribe", () => handler("resubscribe"));
    const off2 = transport.onRecovery("cold-recover", () => handler("cold-recover"));
    return () => {
      off1();
      off2();
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.config.signal?.removeEventListener("abort", this.cancel);
    const connected = this.connected;
    // Start closing the acquired transport before joining readiness: its close
    // is the authoritative event that releases a pending authentication wait.
    const retirement = this.retireTransport();
    return (this.closePromise = (async () => {
      const results = await Promise.allSettled([retirement, connected?.catch(() => undefined)]);
      this.connected = null;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "WebSocket client retirement failed");
    })());
  }

  private retireTransport(): Promise<void> {
    const transport = this.transport;
    return (this.transportRetirement ??= Promise.resolve().then(() => transport?.close()));
  }

  private ensureConnected(): Promise<{
    transport: ReturnType<typeof wsClientTransport>;
    core: CoreRpcClient;
  }> {
    this.config.signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("WebSocket RPC client is closed"));
    if (!this.connected) {
      this.connected = this.connect().catch((error) => {
        this.connected = null;
        throw error;
      });
    }
    return this.connected;
  }

  private async connect(): Promise<{
    transport: ReturnType<typeof wsClientTransport>;
    core: CoreRpcClient;
  }> {
    const { WebSocket } = await import("ws");
    this.config.signal?.throwIfAborted();
    if (this.closed) throw new Error("WebSocket RPC client is closed");
    const clientLabel = this.config.clientLabel ?? "Vibestudio CLI";
    const transport = wsClientTransport({
      selfId: this.config.callerId,
      getWsUrl: () => serverRpcWsUrl(this.config.url),
      reconnect: true,
      logPrefix: this.config.logPrefix ?? "[cli-ws]",
      ...(this.config.connectionId ? { connectionId: this.config.connectionId } : {}),
      getAuthMessageFields: () => ({
        clientLabel,
        clientPlatform: "headless",
        oauthCallbackMode: "client-loopback",
      }),
      adapter: {
        now: () => Date.now(),
        getAuthToken: async (signal) => await this.config.getToken(signal),
        createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
      },
    });
    this.transport = transport;
    this.transportRetirement = null;
    try {
      await transport.connectAndWait();
    } catch (error) {
      const failure = this.config.signal?.aborted ? this.config.signal.reason : error;
      try {
        await this.retireTransport();
      } catch (cleanup) {
        throw new AggregateError(
          [failure, cleanup],
          "WebSocket authentication and retirement failed",
          { cause: failure }
        );
      }
      throw failure;
    }
    this.config.signal?.throwIfAborted();
    if (this.closed) throw new Error("WebSocket RPC client is closed");
    const core = createInternalRpcClient({
      selfId: this.config.callerId,
      callerKind: this.config.callerKind,
      transport,
      authorityAcquisition: "wait",
    });
    return { transport, core };
  }
}
