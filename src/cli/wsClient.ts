/**
 * WebSocket RPC client for the CLI.
 *
 * The loopback/LAN counterpart to {@link WebRtcRpcClient}: it opens the same
 * persistent `/rpc` WebSocket the desktop shell and mobile app use (via the
 * shared `wsClientTransport`), so the CLI gains server push (`onEvent`) and
 * streaming without a WebRTC pairing blob. Used for one-shot commands that need
 * push (`channel tail`, `logs --follow`) and by the linked-agent bridge.
 *
 * Auth: the first frame is `ws:auth` carrying a redeemable token —
 * `refresh:<deviceId>:<token>` for a paired device, or `agent:<agentId>:<token>`
 * for an entity-scoped agent credential. The server's WS-auth redeemer resolves
 * either into the connection's principal + kind (see authService
 * createPairingRedeemer); the client never asserts its own identity.
 */

import {
  createRpcClient,
  type RpcClient as CoreRpcClient,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { NodeWsLike } from "@vibestudio/shell-core/transport/nodeWsLike";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";

export interface WsClientConfig {
  /** Base server URL (http/https origin or /_workspace/<name> selection). */
  url: string;
  /** Stable envelope self-id (server re-derives the authenticated caller). */
  callerId: string;
  /** Caller kind carried on outbound envelopes. */
  callerKind: CallerKind;
  /** Produce the redeemable ws:auth token (`refresh:…` or `agent:…`). */
  getToken: () => Promise<string> | string;
  connectionId?: string;
  clientLabel?: string;
  logPrefix?: string;
}

/**
 * Thin wrapper over `wsClientTransport` + `createRpcClient`, matching the CLI's
 * `call`/`callTarget`/`stream`/`onEvent` surface (same shape as
 * {@link WebRtcRpcClient}).
 */
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
      getAuthMessageFields: () => ({ clientLabel, clientPlatform: "headless" }),
      adapter: {
        now: () => Date.now(),
        getAuthToken: async () => await this.config.getToken(),
        createSocket: (url) => new NodeWsLike(new WebSocket(url)),
      },
    });
    await transport.connectAndWait();
    const core = createRpcClient({
      selfId: this.config.callerId,
      callerKind: this.config.callerKind,
      transport,
    });
    return { transport, core };
  }
}
