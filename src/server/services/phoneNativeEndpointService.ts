import { phoneNativeEndpointMethods } from "@vibestudio/service-schemas/phoneNativeEndpoint";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";

const PROVIDER_SOURCE = "workers/phone-provisioning";
const PROVIDER_RUNTIME_PREFIX = `do:${PROVIDER_SOURCE}:PhoneProvisioningDO:`;

interface ConnectedClient {
  caller: { runtime: { id: string; kind: string } };
  userId: string;
  clientLabel?: string;
  clientPlatform?: string;
}

interface ClientBridge {
  call(callerId: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface PhoneNativeEndpointDeps {
  getUserConnections(userId: string): readonly ConnectedClient[];
  getClientBridge(callerId: string): ClientBridge | undefined;
}

function requireProvider(ctx: ServiceContext): string {
  if (
    ctx.caller.runtime.kind !== "do" ||
    !ctx.caller.runtime.id.startsWith(PROVIDER_RUNTIME_PREFIX) ||
    ctx.caller.codeApproved !== true ||
    ctx.caller.code?.callerId !== ctx.caller.runtime.id ||
    ctx.caller.code?.repoPath !== PROVIDER_SOURCE
  ) {
    throw new Error("Phone native endpoint requires the exact approved Base phone provider");
  }
  const userId = verifiedInitiatingUserId(ctx);
  if (!userId || userId === "system") {
    throw new Error("Phone native endpoint requires an authenticated user account");
  }
  return userId;
}

export function createPhoneNativeEndpointService(deps: PhoneNativeEndpointDeps): ServiceDefinition {
  const endpoints = (userId: string): ConnectedClient[] => {
    const unique = new Map<string, ConnectedClient>();
    for (const connection of deps.getUserConnections(userId)) {
      const clientId = connection.caller.runtime.id;
      if (
        connection.caller.runtime.kind !== "shell" ||
        connection.clientPlatform !== "desktop" ||
        !deps.getClientBridge(clientId)
      ) {
        continue;
      }
      unique.set(clientId, connection);
    }
    return [...unique.values()];
  };

  const bridgeFor = (userId: string, clientId: string): ClientBridge => {
    const endpoint = endpoints(userId).find(
      (connection) => connection.caller.runtime.id === clientId
    );
    const bridge = endpoint ? deps.getClientBridge(clientId) : undefined;
    if (!bridge) throw new Error("The selected desktop is no longer connected");
    return bridge;
  };

  return {
    name: "phoneNativeEndpoint",
    description: "Typed native phone effects for the exact reviewed Base phone provider",
    authority: { principals: ["code"] },
    methods: phoneNativeEndpointMethods,
    handler: async (ctx, method, args) => {
      const userId = requireProvider(ctx);
      if (method === "desktops") {
        return endpoints(userId).map((connection) => ({
          clientId: connection.caller.runtime.id,
          label: connection.clientLabel?.trim() || null,
          platform: connection.clientPlatform?.trim() || null,
        }));
      }
      const input = args[0] as {
        clientId: string;
        query?: unknown;
        input?: unknown;
      };
      const bridge = bridgeFor(userId, input.clientId);
      if (method === "providers") {
        return bridge.call(input.clientId, "desktopPhoneProvider.providers", []);
      }
      if (method === "devices") {
        return bridge.call(input.clientId, "desktopPhoneProvider.devices", [input.query]);
      }
      if (method === "provision") {
        return bridge.call(input.clientId, "desktopPhoneProvider.provision", [input.input]);
      }
      throw new Error(`Unknown phoneNativeEndpoint method: ${method}`);
    },
  };
}
