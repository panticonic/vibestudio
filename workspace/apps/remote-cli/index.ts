import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import { NodeWsLike } from "@vibestudio/shell-core/transport/nodeWsLike";
import { createServerWsTransport } from "@vibestudio/shell-core/transport/serverWsTransport";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import WebSocket from "ws";

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
  const events = new EventsClient(rpc);
  events.on("apps:lifecycle", (payload) => {
    console.log(`[apps:lifecycle] ${JSON.stringify(payload)}`);
  });
  await events.subscribe("apps:lifecycle");
  return { rpc, close: () => transport.close() };
}

export async function main(): Promise<void> {
  const { rpc, close } = await connect();
  const workspaceClient = createTypedServiceClient(
    "workspace",
    workspaceMethods,
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

  const command = process.env["VIBESTUDIO_TERMINAL_APP_COMMAND"] ?? "status";
  if (command !== "status") throw new Error(`Unknown remote-cli command: ${command}`);

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
