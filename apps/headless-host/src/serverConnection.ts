/**
 * Server RPC connection for the headless host: WS /rpc transport with
 * ws:auth fields declaring a headless client. Public raw/device auth is
 * intentionally absent: server-spawned hosts
 * receive a capability over IPC; the CLI injects its paired WebRTC connection.
 */
import { WebSocket } from "ws";
import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import { NodeWsLike } from "@vibestudio/shell-core/transport/nodeWsLike";
import { createDevLogger } from "@vibestudio/dev-log";
import type { HeadlessHostConfig, HeadlessHostServerConnection } from "./config.js";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";

const log = createDevLogger("HeadlessHost:rpc");

export interface ServerConnection extends HeadlessHostServerConnection {
  rpc: RpcClient;
  /** Current server-issued IPC capability. */
  getToken(): string;
  onResubscribe(handler: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export async function connectToServer(config: HeadlessHostConfig): Promise<ServerConnection> {
  if (config.auth.kind === "injected") {
    throw new Error("headless-host: injected auth requires connectionFactory");
  }
  const currentToken = config.auth.token;
  const wsUrl = serverRpcWsUrl(config.serverUrl);

  const transport = wsClientTransport({
    selfId: config.clientSessionId,
    getWsUrl: () => wsUrl,
    reconnect: true,
    logPrefix: "HeadlessHost",
    getAuthMessageFields: () => ({
      clientLabel: config.label,
      clientSessionId: config.clientSessionId,
      clientPlatform: "headless",
    }),
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => currentToken,
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });

  await transport.connectAndWait();
  log.info(`connected to ${wsUrl} as ${config.clientSessionId}`);

  const rpc = createRpcClient({
    selfId: config.clientSessionId,
    callerKind: "shell",
    transport,
  });

  return {
    rpc,
    getToken: () => currentToken,
    onResubscribe: (handler) => {
      transport.onRecovery("resubscribe", handler);
      transport.onRecovery("cold-recover", handler);
    },
    close: () => transport.close(),
  };
}
