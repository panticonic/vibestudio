import {
  createRpcClient,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@natstack/rpc";
import { createConnectDeepLink } from "@natstack/shared/connect";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import WebSocket from "ws";

export interface PairingInviteLike {
  connectUrl: string;
  code: string;
  deepLink?: string | null;
  expiresAt?: number;
}

export function formatPairingInvite(invite: PairingInviteLike): string {
  const deepLink = invite.deepLink ?? createConnectDeepLink(invite.connectUrl, invite.code);
  const expires = invite.expiresAt ? `\nExpires: ${new Date(invite.expiresAt).toISOString()}` : "";
  return [`Pairing code: ${invite.code}`, `Pair URL: ${deepLink}${expires}`].join("\n");
}

function printBootstrapSummary(): void {
  console.log(`App id: ${requiredEnv("NATSTACK_TERMINAL_APP_ID")}`);
  console.log(`Source: ${process.env["NATSTACK_TERMINAL_APP_SOURCE"] ?? "unknown"}`);
  console.log(`Build: ${process.env["NATSTACK_TERMINAL_APP_BUILD_KEY"] ?? "unknown"}`);
  console.log(
    `Effective version: ${process.env["NATSTACK_TERMINAL_APP_EFFECTIVE_VERSION"] || "unknown"}`
  );
  console.log(`Gateway: ${requiredEnv("NATSTACK_TERMINAL_APP_GATEWAY_URL")}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function gatewayWebSocketUrl(): string {
  const url = new URL(requiredEnv("NATSTACK_TERMINAL_APP_GATEWAY_URL"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.endsWith("/rpc") ? url.pathname : "/rpc";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function connect() {
  const appId = requiredEnv("NATSTACK_TERMINAL_APP_ID");
  const token = requiredEnv("NATSTACK_TERMINAL_APP_RPC_TOKEN");
  const connectionId = requiredEnv("NATSTACK_TERMINAL_APP_CONNECTION_ID");
  const ws = new WebSocket(gatewayWebSocketUrl());
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const transport: EnvelopeRpcTransport = {
    async send(envelope: RpcEnvelope): Promise<void> {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("Terminal app WebSocket RPC is not connected");
      }
      ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope,
          message: envelope.message,
        } satisfies WsClientMessage)
      );
    },
    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    status: () => (ws.readyState === WebSocket.OPEN ? "connected" : "disconnected"),
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
  const rpc: RpcClient = createRpcClient({
    selfId: appId,
    callerKind: "app",
    transport,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Terminal app auth timeout")), 10_000);
    const fail = (error: unknown) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "ws:auth",
          token,
          connectionId,
          clientLabel: "NatStack Remote CLI",
          clientPlatform: "desktop",
        } satisfies WsClientMessage)
      );
    });
    ws.on("message", function onAuth(data) {
      const message = JSON.parse(String(data)) as WsServerMessage;
      if (message.type !== "ws:auth-result") return;
      ws.off("message", onAuth);
      ws.off("error", fail);
      clearTimeout(timeout);
      if (!message.success) {
        reject(new Error(`Terminal app auth failed: ${message.error ?? "unknown error"}`));
        return;
      }
      resolve();
    });
  });

  ws.on("message", (data) => {
    let message: WsServerMessage;
    try {
      message = JSON.parse(String(data)) as WsServerMessage;
    } catch {
      return;
    }
    if (message.type === "ws:rpc") {
      const envelope =
        message.envelope ??
        (message.message
          ? envelopeFromMessage({
              selfId: appId,
              from: "main",
              target: appId,
              callerKind: "server",
              message: message.message,
            })
          : null);
      if (envelope) {
        for (const listener of listeners) listener(envelope);
      }
    }
    if (message.type === "ws:routed") {
      const envelope =
        message.envelope ??
        (message.message
          ? envelopeFromMessage({
              selfId: appId,
              from: message.fromId ?? "unknown",
              target: appId,
              callerKind: message.fromKind ?? "unknown",
              message: message.message,
            })
          : null);
      if (envelope) {
        for (const listener of listeners) listener(envelope);
      }
    }
    if (message.type === "ws:event" && message.event === "apps:lifecycle") {
      console.log(`[apps:lifecycle] ${JSON.stringify(message.payload)}`);
    }
  });
  ws.on("close", () => process.exit(0));
  return { rpc, close: () => ws.close(1000, "terminal app closing") };
}

export async function main(): Promise<void> {
  const { rpc, close } = await connect();
  const workspaceClient = createTypedServiceClient(
    "workspace",
    workspaceMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );
  printBootstrapSummary();
  const workspace = await workspaceClient.getInfo();
  console.log(`Connected as ${requiredEnv("NATSTACK_TERMINAL_APP_ID")}`);
  console.log(`Workspace: ${workspace.config.id ?? "unknown"}`);

  const units = await workspaceClient.units.list();
  console.log(`Workspace units: ${units.length}`);
  for (const unit of units) {
    console.log(
      `- ${unit.kind} ${unit.name} ${unit.source} status=${unit.status} target=${unit.target ?? ""}`
    );
  }

  const command = process.env["NATSTACK_TERMINAL_APP_COMMAND"] ?? "invite";
  if (command === "status") return;
  if (command === "invite") {
    const invite = await authClient.createPairingInvite({ ttlMs: 10 * 60 * 1000 });
    console.log(formatPairingInvite(invite));
  }

  process.on("message", (message) => {
    if ((message as { type?: string })?.type === "shutdown") {
      close();
    }
  });
}

if (process.env["NATSTACK_TERMINAL_APP_GATEWAY_URL"]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
