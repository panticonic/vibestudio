/**
 * WebSocket RPC client for the CLI.
 *
 * Auth: a bounded HTTP admission request redeems the device/agent credential
 * before WebSocket allocation and returns a short-lived one-use grant. The first
 * auth frame binds that grant to contract negotiation; the client never asserts
 * its own identity.
 */

import {
  createRpcClient,
  type RpcClient as CoreRpcClient,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { NodeWsLike } from "@vibestudio/rpc/transports/nodeWsLike";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";

export interface WsClientConfig {
  url: string;
  callerId: string;
  callerKind: CallerKind;
  getToken: () => Promise<string> | string;
  connectionId?: string;
  clientLabel?: string;
  logPrefix?: string;
}

export class WsRpcClient {
  private connected: Promise<{
    transport: ReturnType<typeof wsClientTransport>;
    core: CoreRpcClient;
  }> | null = null;

  constructor(private readonly config: WsClientConfig) {}

  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const { core } = await this.ensureConnected();
    return await core.call<T>("main", method, args);
  }

  async callTarget<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    const { core } = await this.ensureConnected();
    return await core.call<T>(targetId, method, args);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    const { core } = await this.ensureConnected();
    return await core.stream(targetId, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    const { core } = await this.ensureConnected();
    return core.on(event, (ctx) => listener(ctx.payload, ctx.caller.callerId));
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

  async close(): Promise<void> {
    const connected = this.connected;
    this.connected = null;
    if (!connected) return;
    await (await connected).transport.close();
  }

  private ensureConnected(): Promise<{
    transport: ReturnType<typeof wsClientTransport>;
    core: CoreRpcClient;
  }> {
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
        getAuthToken: async () => await this.config.getToken(),
        createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
      },
    });
    try {
      await transport.connectAndWait();
    } catch (error) {
      await transport.close();
      throw error;
    }
    const core = createRpcClient({
      selfId: this.config.callerId,
      callerKind: this.config.callerKind,
      transport,
      authorityAcquisition: "wait",
    });
    return { transport, core };
  }
}
