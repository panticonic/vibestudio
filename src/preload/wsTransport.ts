/**
 * WebSocket transport bridge for preload scripts.
 */

import type { RpcEnvelope, RpcMessage } from "@vibestudio/rpc";
import { TERMINAL_CLOSE_CODES } from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import type { WsLike } from "@vibestudio/rpc/protocol/wsAdapter";
import type { RecoveryKind } from "@vibestudio/shell-core/recoveryCoordinator";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

type PanelInitPayload = {
  gatewayConfig?: {
    token?: unknown;
  };
  connectionId?: unknown;
  clientLabel?: unknown;
};

type PanelInitProvider = {
  getPanelInit: () => Promise<PanelInitPayload>;
};

type vibestudioTransportGlobals = typeof globalThis & {
  __vibestudioShell?: PanelInitProvider;
  __vibestudioGatewayToken?: string;
};

export type TransportBridge = {
  send: (envelope: RpcEnvelope) => Promise<void>;
  onMessage: (handler: EnvelopeHandler) => () => void;
  onRecovery: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
};

export interface WsTransportConfig {
  viewId: string;
  eventPanelId?: string;
  wsPort: number;
  authToken: string;
  callerKind: string;
  connectionId?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  reconnect?: boolean;
  /** Override WebSocket URL. Default: ws://127.0.0.1:{wsPort} */
  wsUrl?: string;
}

export function translateWsServerEvent(
  event: string,
  payload: unknown,
  config: Pick<WsTransportConfig, "eventPanelId" | "viewId">,
  deliver: (message: RpcMessage) => void
): boolean {
  if (event !== "panel:event") {
    // General server pushes (VCS head/working advances, workspace watches,
    // notifications, approvals, etc.) are already named RPC events. Feed them
    // into the normal RpcClient event path instead of dropping them through an
    // unset transport-only callback.
    deliver({ type: "event", fromId: "main", event, payload });
    return true;
  }
  const record = payload as Record<string, unknown>;
  if (record["panelId"] !== (config.eventPanelId ?? config.viewId)) return true;
  if (record["type"] === "focus") {
    deliver({ type: "event", fromId: "main", event: "runtime:focus", payload: null });
  } else if (record["type"] === "theme") {
    deliver({
      type: "event",
      fromId: "main",
      event: "runtime:theme",
      payload: record["theme"],
    });
  } else if (record["type"] === "child-created") {
    deliver({
      type: "event",
      fromId: "main",
      event: "runtime:child-created",
      payload: { childId: record["childId"], url: record["url"] },
    });
  } else if (record["type"] === "child-creation-error") {
    deliver({
      type: "event",
      fromId: "main",
      event: "runtime:child-creation-error",
      payload: { url: record["url"], error: record["error"] },
    });
  }
  return true;
}

class BrowserWsLike implements WsLike {
  constructor(private readonly ws: WebSocket) {}
  get readyState(): number {
    return this.ws.readyState;
  }
  get onopen(): (() => void) | null {
    return this.ws.onopen as (() => void) | null;
  }
  set onopen(handler: (() => void) | null) {
    this.ws.onopen = handler;
  }
  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.ws.onmessage as ((event: { data: unknown }) => void) | null;
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.ws.onmessage = handler as ((event: MessageEvent) => void) | null;
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = handler as ((event: CloseEvent) => void) | null;
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = handler as ((event: Event) => void) | null;
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

const normalizeEndpointId = (targetId: string): string => {
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  return targetId;
};

export function createWsTransport(config: WsTransportConfig): TransportBridge {
  const listeners = new Set<EnvelopeHandler>();
  const bufferedMessages: RpcEnvelope[] = [];
  let transportReady = false;
  let authToken = config.authToken;
  let connectionId = config.connectionId;
  let clientLabel = config.clientLabel;

  const deliver = (envelope: RpcEnvelope) => {
    if (!transportReady) {
      bufferedMessages.push(envelope);
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("Error in WS transport message handler:", error);
      }
    }
  };

  const translateEvent = (
    event: string,
    payload: unknown,
    baseDeliver: (message: RpcMessage) => void
  ): boolean => translateWsServerEvent(event, payload, config, baseDeliver);

  const refreshAuthToken = async (): Promise<string> => {
    const globals = globalThis as vibestudioTransportGlobals;
    const shell = globals.__vibestudioShell;
    if (!shell || typeof shell.getPanelInit !== "function") return authToken;
    const panelInit = await shell.getPanelInit();
    const nextToken = panelInit?.gatewayConfig?.token;
    if (typeof nextToken === "string" && nextToken.length > 0) {
      authToken = nextToken;
      globals.__vibestudioGatewayToken = nextToken;
      if (typeof panelInit.connectionId === "string") {
        connectionId = panelInit.connectionId;
      }
      if (typeof panelInit.clientLabel === "string") {
        clientLabel = panelInit.clientLabel;
      }
      try {
        sessionStorage.setItem("__vibestudioPanelInit", JSON.stringify(panelInit));
      } catch {
        // ignore
      }
    }
    return authToken;
  };

  const base = wsClientTransport({
    selfId: config.viewId,
    getWsUrl: () => config.wsUrl ?? `ws://127.0.0.1:${config.wsPort}`,
    connectionId: config.connectionId,
    reconnect: config.reconnect,
    routeTarget: normalizeEndpointId,
    terminalCloseCodes: [...TERMINAL_CLOSE_CODES],
    translateEvent,
    logPrefix: "WsTransport",
    getAuthMessageFields: () => ({
      connectionId,
      clientLabel,
      clientSessionId: config.clientSessionId,
      clientPlatform: config.clientPlatform,
    }),
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => authToken,
      refreshAuthToken,
      createSocket: (url) => new BrowserWsLike(new WebSocket(url)),
    },
  });
  base.onMessage((envelope) => deliver(envelope));
  base.connect();

  return {
    async send(envelope) {
      const rpcMessage = envelope.message;
      if (
        !rpcMessage ||
        typeof rpcMessage !== "object" ||
        typeof (rpcMessage as { type?: unknown }).type !== "string"
      ) {
        return Promise.reject(new Error("Invalid RPC message"));
      }
      if (base.status?.() !== "connected") {
        await base.connectAndWait();
      }
      return base.send(envelope);
    },
    onMessage(handler) {
      listeners.add(handler);
      queueMicrotask(() => {
        transportReady = true;
        for (const buffered of bufferedMessages.splice(0)) {
          deliver(buffered);
        }
      });
      return () => listeners.delete(handler);
    },
    onRecovery(kind, handler) {
      return base.onRecovery(kind, handler);
    },
  };
}
