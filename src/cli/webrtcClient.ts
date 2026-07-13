/**
 * WebRTC RPC client for the CLI.
 *
 * This is the Node/CLI binding for the shared paired-connection bootstrap used
 * by desktop and mobile. It dials the signaling room from a `vibestudio://connect`
 * link, pins the server DTLS fingerprint, opens the main shell session, and
 * exposes the same `call("service.method", args)` / `callTarget(...)` surface as
 * the HTTP CLI client.
 */

import { randomUUID } from "node:crypto";
import {
  createRpcClient,
  type RpcClient as CoreRpcClient,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import {
  createPairedConnection,
  type PairedConnection,
} from "@vibestudio/rpc/transports/pairedConnection";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { acquireWebRtcConnectionLock } from "./webrtcConnectionLock.js";

export type CliWebRtcPairing = Omit<ConnectPairing, "code"> & { code?: string };

export interface WebRtcClientConfig {
  pairing: CliWebRtcPairing;
  callerId: string;
  /** Client-asserted caller kind (server re-derives the real kind from the
   *  redeemed token). Defaults to "shell"; agent credentials pass "agent". */
  callerKind?: CallerKind;
  getToken: () => Promise<string> | string;
  connectionId?: string;
  clientLabel?: string;
  onPaired?: (credential: { deviceId: string; refreshToken: string }) => void | Promise<void>;
  onPersistError?: (error: Error) => void;
  logPrefix?: string;
}

interface ConnectedClient {
  paired: PairedConnection;
  core: CoreRpcClient;
  callerId: string;
}

export class WebRtcRpcClient {
  private connected: Promise<ConnectedClient> | null = null;
  private releaseConnectionLock: (() => void) | null = null;

  constructor(private readonly config: WebRtcClientConfig) {}

  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  async callerId(): Promise<string> {
    return (await this.ensureConnected()).callerId;
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
    const { paired } = await this.ensureConnected();
    return paired.onRecovery((kind) => {
      void handler(kind);
    });
  }

  async close(): Promise<void> {
    const connected = this.connected;
    this.connected = null;
    if (!connected) {
      this.releaseLock();
      return;
    }
    try {
      await (await connected).paired.close();
    } finally {
      this.releaseLock();
    }
  }

  private ensureConnected(): Promise<ConnectedClient> {
    if (!this.connected) {
      this.connected = this.connect().catch((error) => {
        this.connected = null;
        throw error;
      });
    }
    return this.connected;
  }

  private async connect(): Promise<ConnectedClient> {
    const releaseLock = await acquireWebRtcConnectionLock(this.config.pairing.room, {
      onWait: (owner) => {
        const detail = owner ? ` (process ${owner.pid})` : "";
        console.warn(`[cli-webrtc] waiting for another CLI connection${detail} to finish`);
      },
    });
    this.releaseConnectionLock = releaseLock;
    try {
      const { createNodeDatachannelProvider } =
        await import("../main/webrtc/nodeDatachannelPeer.js");
      const { default: WS } = (await import("ws")) as unknown as {
        default: new (url: string) => unknown;
      };
      const paired = await createPairedConnection({
        provider: createNodeDatachannelProvider({ peerName: "cli" }),
        webSocketImpl: WS,
        fetchImpl: fetch,
        pairing: {
          room: this.config.pairing.room,
          fingerprint: this.config.pairing.fp,
          iceTransportPolicy: this.config.pairing.ice,
        },
        sig: this.config.pairing.sig,
        getShellToken: this.config.getToken,
        connectionId: this.config.connectionId ?? randomUUID(),
        clientLabel: this.config.clientLabel ?? "Vibestudio CLI",
        clientPlatform: "headless",
        platform: "headless",
        logPrefix: this.config.logPrefix ?? "[cli-webrtc]",
        ...(this.config.onPaired ? { onPaired: this.config.onPaired } : {}),
        ...(this.config.onPersistError ? { onPersistError: this.config.onPersistError } : {}),
      });
      const callerId = paired.mainSession.callerId() ?? this.config.callerId;
      const core = createRpcClient({
        selfId: callerId,
        callerKind: this.config.callerKind ?? "shell",
        transport: paired.mainSession,
        onRecovery: (handler) => paired.onRecovery(handler),
      });
      return { paired, core, callerId };
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  private releaseLock(): void {
    const release = this.releaseConnectionLock;
    this.releaseConnectionLock = null;
    release?.();
  }
}
