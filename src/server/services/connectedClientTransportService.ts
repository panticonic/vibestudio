import { connectedClientTransportMethods } from "@vibestudio/service-schemas/connectedClientTransport";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

interface ConnectedClient {
  caller: { runtime: { id: string; kind: string } };
  userId: string;
  clientLabel?: string;
  clientPlatform?: string;
}

interface ClientBridge {
  call(callerId: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface ConnectedClientTransportDeps {
  getUserConnections(userId: string): readonly ConnectedClient[];
  getClientBridge(callerId: string): ClientBridge | undefined;
}

function requireUserId(ctx: ServiceContext): string {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw new Error("Connected-client transport requires an authenticated user account");
  }
  return userId;
}

export function createConnectedClientTransportService(
  deps: ConnectedClientTransportDeps
): ServiceDefinition {
  const endpoints = (userId: string): ConnectedClient[] => {
    const unique = new Map<string, ConnectedClient>();
    for (const connection of deps.getUserConnections(userId)) {
      const clientId = connection.caller.runtime.id;
      if (!deps.getClientBridge(clientId)) continue;
      unique.set(clientId, connection);
    }
    return [...unique.values()];
  };

  return {
    name: "connectedClientTransport",
    description: "Authenticated transport to exact live clients on the caller's account",
    authority: { principals: ["code", "host"] },
    methods: connectedClientTransportMethods,
    handler: async (ctx, method, args) => {
      const userId = requireUserId(ctx);
      if (method === "list") {
        return endpoints(userId).map((connection) => ({
          clientId: connection.caller.runtime.id,
          label: connection.clientLabel?.trim() || null,
          platform: connection.clientPlatform?.trim() || null,
          runtimeKind: connection.caller.runtime.kind,
        }));
      }
      if (method === "invoke") {
        const input = args[0] as { clientId: string; method: string; args: unknown[] };
        const endpoint = endpoints(userId).find(
          (connection) => connection.caller.runtime.id === input.clientId
        );
        if (!endpoint) throw new Error("The selected client is no longer connected");
        const bridge = deps.getClientBridge(input.clientId);
        if (!bridge) throw new Error("The selected client is no longer connected");
        return bridge.call(input.clientId, input.method, input.args);
      }
      throw new Error(`Unknown connectedClientTransport method: ${method}`);
    },
  };
}
