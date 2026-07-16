import { createRpcClient, type RpcEnvelope } from "@vibestudio/rpc";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";
import { createWsTransport } from "../preload/wsTransport.js";

export type PanelInitPayload = {
  entityId?: unknown;
  slotId?: unknown;
  gatewayConfig?: {
    serverUrl?: unknown;
    token?: unknown;
  };
  connectionId?: unknown;
  clientLabel?: unknown;
};

export type ShellEnvelopeBridge = {
  postEnvelope?: (envelope: RpcEnvelope) => void | Promise<void>;
  onEnvelope?: (handler: (envelope: RpcEnvelope) => void) => () => void;
  onRecovery?: (
    kind: "resubscribe" | "cold-recover",
    handler: () => void | Promise<void>
  ) => () => void;
  addEventListener?: (handler: (event: string, payload: unknown) => void) => number;
  removeEventListener?: (id: number) => void;
  getPanelInit?: () => Promise<PanelInitPayload>;
  getBootstrapConfig?: () => Promise<PanelInitPayload>;
  getInfo?: () => Promise<unknown>;
  focusPanel?: (panelId: string) => Promise<unknown>;
  openDevtools?: () => Promise<never>;
  openFolderDialog?: () => Promise<null>;
};

export type BrowserShellBridgeGlobals = typeof globalThis & {
  __vibestudioShell?: ShellEnvelopeBridge;
  __vibestudioPanelInit?: PanelInitPayload;
  __vibestudioEntityId?: string;
  __vibestudioSlotId?: string;
  __vibestudioGatewayConfig?: PanelInitPayload["gatewayConfig"];
  __vibestudioGatewayToken?: string;
  __vibestudioConnectionId?: string;
  __vibestudioClientLabel?: string;
};

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function installFallbackShellBridge(
  globals = globalThis as BrowserShellBridgeGlobals
): ShellEnvelopeBridge | undefined {
  const existing = globals.__vibestudioShell;
  if (
    existing &&
    typeof existing.postEnvelope === "function" &&
    typeof existing.onEnvelope === "function"
  ) {
    return existing;
  }

  const init = globals.__vibestudioPanelInit ?? {};
  const gatewayConfig = globals.__vibestudioGatewayConfig ?? init.gatewayConfig;
  const entityId = stringOrUndefined(globals.__vibestudioEntityId ?? init.entityId);
  const slotId = stringOrUndefined(globals.__vibestudioSlotId ?? init.slotId) ?? entityId;
  const serverUrl = stringOrUndefined(gatewayConfig?.serverUrl);
  const token = stringOrUndefined(globals.__vibestudioGatewayToken ?? gatewayConfig?.token);
  const connectionId = stringOrUndefined(globals.__vibestudioConnectionId ?? init.connectionId);

  if (!entityId || !slotId || !serverUrl || !token || !connectionId) {
    return existing;
  }

  const url = new URL(serverUrl);
  const transport = createWsTransport({
    viewId: entityId,
    wsPort: Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
    wsUrl: serverRpcWsUrl(serverUrl),
    authToken: token,
    callerKind: "panel",
    connectionId,
    clientLabel: stringOrUndefined(globals.__vibestudioClientLabel ?? init.clientLabel),
    reconnect: false,
  });
  const rpc = createRpcClient({ selfId: entityId, callerKind: "panel", transport });
  const eventListeners = new Map<number, (event: string, payload: unknown) => void>();
  let nextListenerId = 1;
  transport.onMessage((envelope) => {
    const message = envelope.message;
    if (
      !message ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== "event" ||
      typeof (message as { event?: unknown }).event !== "string"
    ) {
      return;
    }
    for (const listener of eventListeners.values()) {
      try {
        listener((message as { event: string }).event, (message as { payload?: unknown }).payload);
      } catch {
        // Keep host-event delivery best effort, matching preload bridge behavior.
      }
    }
  });
  const panelInit: PanelInitPayload = { ...init, gatewayConfig, entityId, slotId, connectionId };
  const shell: ShellEnvelopeBridge = {
    postEnvelope: (envelope) => transport.send(envelope),
    onEnvelope: (handler) => transport.onMessage(handler),
    onRecovery: (kind, handler) => transport.onRecovery(kind, handler),
    addEventListener: (handler) => {
      const id = nextListenerId++;
      eventListeners.set(id, handler);
      return id;
    },
    removeEventListener: (id) => {
      eventListeners.delete(id);
    },
    getPanelInit: async () => panelInit,
    getBootstrapConfig: async () => panelInit,
    getInfo: () => rpc.call("main", "panelTree.metadata", [slotId]),
    focusPanel: (panelId) => rpc.call("main", "panelTree.focus", [panelId]),
    openDevtools: () => Promise.reject(new Error("openDevtools is not supported on headless host")),
    openFolderDialog: async () => null,
  };
  globals.__vibestudioShell = shell;
  return shell;
}
