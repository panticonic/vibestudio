import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  PhoneDeviceDiscoverySchema,
  PhoneProviderSchema,
  PhoneProvisioningResultSchema,
  phoneProvisioningMethods,
  type PhoneInstallArgs,
  type PhoneOpenPairingArgs,
  type PhoneProvider,
} from "@vibestudio/service-schemas/phoneProvisioning";

interface DesktopConnection {
  caller: { runtime: { id: string; kind: string } };
  userId: string;
  clientLabel?: string;
  clientPlatform?: string;
}

interface ClientBridge {
  call(callerId: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface PhoneProvisioningProxyDeps {
  getUserConnections(userId: string): readonly DesktopConnection[];
  getClientBridge(callerId: string): ClientBridge | undefined;
}

function requireUserId(ctx: ServiceContext): string {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw new Error("Phone provisioning requires an authenticated user account");
  }
  return userId;
}

export function createPhoneProvisioningProxyService(
  deps: PhoneProvisioningProxyDeps
): ServiceDefinition {
  function connections(userId: string): DesktopConnection[] {
    const unique = new Map<string, DesktopConnection>();
    for (const connection of deps.getUserConnections(userId)) {
      if (connection.caller.runtime.kind !== "shell" || connection.clientPlatform !== "desktop") {
        continue;
      }
      if (!deps.getClientBridge(connection.caller.runtime.id)) continue;
      unique.set(connection.caller.runtime.id, connection);
    }
    return [...unique.values()];
  }

  async function callDesktop(
    connection: DesktopConnection,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const callerId = connection.caller.runtime.id;
    const bridge = deps.getClientBridge(callerId);
    if (!bridge) throw new Error("The selected desktop disconnected");
    return await bridge.call(callerId, `desktopPhoneProvider.${method}`, args);
  }

  async function providers(userId: string): Promise<PhoneProvider[]> {
    const available: PhoneProvider[] = [];
    for (const connection of connections(userId)) {
      try {
        const local = PhoneProviderSchema.array().parse(
          await callDesktop(connection, "providers", [])
        );
        for (const provider of local) {
          available.push({
            ...provider,
            providerId: connection.caller.runtime.id,
            label: connection.clientLabel?.trim() || provider.label,
          });
        }
      } catch {
        // A stale desktop must not prevent another live provider from serving the user.
      }
    }
    return available;
  }

  async function select(userId: string, providerId?: string): Promise<DesktopConnection> {
    const available = connections(userId);
    if (providerId) {
      const selected = available.find((connection) => connection.caller.runtime.id === providerId);
      if (!selected) throw new Error("The selected desktop provider is no longer connected");
      return selected;
    }
    if (available.length === 0) {
      throw new Error("No desktop for this account is connected to the current server");
    }
    if (available.length > 1) {
      throw new Error("More than one desktop is connected; choose a phone provider first");
    }
    const connection = available[0];
    if (!connection) {
      throw new Error("No desktop for this account is connected to the current server");
    }
    return connection;
  }

  return {
    name: "phoneProvisioning",
    description: "Account-scoped proxy to phone capabilities on connected desktop clients",
    authority: { principals: ["code", "user"] },
    methods: phoneProvisioningMethods,
    handler: async (ctx, method, args) => {
      const userId = requireUserId(ctx);
      if (method === "providers") return await providers(userId);
      if (method === "devices") {
        const query = args[0] as { providerId?: string } | undefined;
        const targets = query?.providerId
          ? [await select(userId, query.providerId)]
          : connections(userId);
        const devices = [];
        const issues = [];
        for (const target of targets) {
          try {
            const local = PhoneDeviceDiscoverySchema.parse(
              await callDesktop(target, "devices", [
                query ? { ...query, providerId: undefined } : undefined,
              ])
            );
            devices.push(
              ...local.devices.map((device) => ({
                ...device,
                providerId: target.caller.runtime.id,
              }))
            );
            issues.push(
              ...local.issues.map((issue) => ({
                ...issue,
                providerId: target.caller.runtime.id,
              }))
            );
          } catch (error) {
            issues.push({
              providerId: target.caller.runtime.id,
              code: "desktop-unavailable",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return { devices, issues };
      }
      if (method === "install") {
        const input = args[0] as PhoneInstallArgs;
        const target = await select(userId, input.providerId);
        const result = await callDesktop(target, method, [{ ...input, providerId: undefined }]);
        return PhoneProvisioningResultSchema.parse({
          ...(result as object),
          providerId: target.caller.runtime.id,
        });
      }
      if (method === "openPairing") {
        const input = args[0] as PhoneOpenPairingArgs;
        const target = await select(userId, input.providerId);
        const result = await callDesktop(target, method, [{ ...input, providerId: undefined }]);
        return PhoneProvisioningResultSchema.parse({
          ...(result as object),
          providerId: target.caller.runtime.id,
        });
      }
      throw new Error(`Unknown phoneProvisioning method: ${method}`);
    },
  };
}
