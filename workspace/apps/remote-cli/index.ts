import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import { NodeWsLike } from "@vibestudio/shared/shell/transport/nodeWsLike";
import { createServerWsTransport } from "@vibestudio/shared/shell/transport/serverWsTransport";
import {
  hubControlMethods,
  type HubPairingInvite,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import { workspaceMethods } from "@vibestudio/shared/serviceSchemas/workspace";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import WebSocket from "ws";

export function formatPairingInvite(invite: HubPairingInvite): string {
  return [
    `Pairing code: ${invite.code}`,
    `Pair URL: ${invite.pairUrl}`,
    `Expires: ${new Date(invite.expiresAt).toISOString()}`,
  ].join("\n");
}

function printBootstrapSummary(): void {
  console.log(`App id: ${requiredEnv("VIBESTUDIO_TERMINAL_APP_ID")}`);
  console.log(`Source: ${process.env["VIBESTUDIO_TERMINAL_APP_SOURCE"] ?? "unknown"}`);
  console.log(`Build: ${process.env["VIBESTUDIO_TERMINAL_APP_BUILD_KEY"] ?? "unknown"}`);
  console.log(
    `Effective version: ${process.env["VIBESTUDIO_TERMINAL_APP_EFFECTIVE_VERSION"] || "unknown"}`
  );
  console.log(`Gateway: ${requiredEnv("VIBESTUDIO_TERMINAL_APP_GATEWAY_URL")}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function connect() {
  const appId = requiredEnv("VIBESTUDIO_TERMINAL_APP_ID");
  const token = requiredEnv("VIBESTUDIO_TERMINAL_APP_RPC_TOKEN");
  const connectionId = requiredEnv("VIBESTUDIO_TERMINAL_APP_CONNECTION_ID");
  const transport = createServerWsTransport({
    selfId: appId,
    serverUrl: requiredEnv("VIBESTUDIO_TERMINAL_APP_GATEWAY_URL"),
    connectionId,
    logPrefix: "RemoteCli",
    getAuthMessageFields: () => ({
      connectionId,
      clientLabel: "Vibestudio Remote CLI",
      clientPlatform: "desktop",
    }),
    translateEvent: (event, payload, deliver) => {
      deliver({
        type: "event",
        fromId: "main",
        event,
        payload,
      });
      if (event === "event:apps:lifecycle" || event === "apps:lifecycle") {
        console.log(`[apps:lifecycle] ${JSON.stringify(payload)}`);
      }
      return true;
    },
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => token,
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });
  const rpc: RpcClient = createRpcClient({
    selfId: appId,
    callerKind: "app",
    transport,
  });

  transport.onStatusChange?.((status) => {
    if (status === "disconnected") process.exit(0);
  });
  await transport.connectAndWait();
  return { rpc, close: () => transport.close() };
}

export async function main(): Promise<void> {
  const { rpc, close } = await connect();
  const workspaceClient = createTypedServiceClient(
    "workspace",
    workspaceMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  const hubControlClient = createTypedServiceClient(
    "hubControl",
    hubControlMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  printBootstrapSummary();
  const workspace = await workspaceClient.getInfo();
  console.log(`Connected as ${requiredEnv("VIBESTUDIO_TERMINAL_APP_ID")}`);
  console.log(`Workspace: ${workspace.config.id ?? "unknown"}`);

  const units = await workspaceClient.units.list();
  console.log(`Workspace units: ${units.length}`);
  for (const unit of units) {
    console.log(
      `- ${unit.kind} ${unit.name} ${unit.source} status=${unit.status} target=${unit.target ?? ""}`
    );
  }

  const command = process.env["VIBESTUDIO_TERMINAL_APP_COMMAND"] ?? "invite";
  if (command === "status") return;
  if (command === "invite") {
    const result = await hubControlClient.pairDevice({ ttlMs: 10 * 60 * 1000 });
    console.log(formatPairingInvite(result.pairing));
  }

  process.on("message", (message) => {
    if ((message as { type?: string })?.type === "shutdown") {
      close();
    }
  });
}

if (process.env["VIBESTUDIO_TERMINAL_APP_GATEWAY_URL"]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
