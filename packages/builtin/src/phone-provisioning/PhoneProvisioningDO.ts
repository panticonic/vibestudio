import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import {
  PhoneDeviceDiscoverySchema,
  PhoneProviderSchema,
  PhoneProvisioningResultSchema,
  phoneProvisioningMethods,
  type PhoneDeviceDiscovery,
  type PhoneProvider,
  type PhoneProvisionArgs,
  type PhoneProvisioningResult,
} from "@vibestudio/service-schemas/phoneProvisioning";
import type { ConnectedClientDescriptor } from "@vibestudio/service-schemas/connectedClientTransport";

export class PhoneProvisioningDO extends DurableObjectBase {
  protected override schemaProductionBaseline() {
    return { version: 1, name: "phone-provisioning-v1" } as const;
  }
  static override rpcMethods = phoneProvisioningMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {}

  @schemaRpc()
  async providers(): Promise<PhoneProvider[]> {
    const desktops = await this.desktops();
    const available: PhoneProvider[] = [];
    const failures: string[] = [];
    for (const desktop of desktops) {
      try {
        const local = PhoneProviderSchema.array().parse(
          await this.invoke(desktop.clientId, "desktopPhoneProvider.providers", [])
        );
        for (const provider of local) {
          available.push({
            ...provider,
            providerId: desktop.clientId,
            label: desktop.label ?? provider.label,
          });
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (desktops.length > 0 && available.length === 0 && failures.length === desktops.length) {
      throw new Error(`Connected desktop provider failed: ${failures.join("; ")}`);
    }
    return available;
  }

  @schemaRpc()
  async devices(query?: {
    providerId?: string;
    platform?: "android" | "ios";
  }): Promise<PhoneDeviceDiscovery> {
    const targets = query?.providerId
      ? [await this.select(query.providerId)]
      : await this.desktops();
    const devices: PhoneDeviceDiscovery["devices"] = [];
    const issues: PhoneDeviceDiscovery["issues"] = [];
    for (const target of targets) {
      try {
        const local = PhoneDeviceDiscoverySchema.parse(
          await this.invoke(target.clientId, "desktopPhoneProvider.devices", [
            query ? { ...query, providerId: undefined } : undefined,
          ])
        );
        devices.push(
          ...local.devices.map((device) => ({ ...device, providerId: target.clientId }))
        );
        issues.push(...local.issues.map((issue) => ({ ...issue, providerId: target.clientId })));
      } catch (error) {
        issues.push({
          providerId: target.clientId,
          code: "desktop-unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { devices, issues };
  }

  @schemaRpc()
  async provision(input: PhoneProvisionArgs): Promise<PhoneProvisioningResult> {
    const target = await this.select(input.providerId);
    const result = await this.invoke(target.clientId, "desktopPhoneProvider.provision", [
      { ...input, providerId: undefined },
    ]);
    return PhoneProvisioningResultSchema.parse({
      ...(result as object),
      providerId: target.clientId,
    });
  }

  private async desktops(): Promise<ConnectedClientDescriptor[]> {
    this.requireUser();
    const endpoints = await this.rpc.call<ConnectedClientDescriptor[]>(
      "main",
      "connectedClientTransport.list",
      []
    );
    return endpoints.filter(
      (endpoint) => endpoint.runtimeKind === "shell" && endpoint.platform === "desktop"
    );
  }

  private async select(providerId?: string): Promise<ConnectedClientDescriptor> {
    const available = await this.desktops();
    if (providerId) {
      const selected = available.find((endpoint) => endpoint.clientId === providerId);
      if (!selected) throw new Error("The selected desktop provider is no longer connected");
      return selected;
    }
    if (available.length === 0) {
      throw new Error("No desktop for this account is connected to the current server");
    }
    if (available.length > 1) {
      throw new Error("More than one desktop is connected; choose a phone provider first");
    }
    return available[0]!;
  }

  private invoke(clientId: string, method: string, args: unknown[]): Promise<unknown> {
    return this.rpc.call("main", "connectedClientTransport.invoke", [{ clientId, method, args }]);
  }

  private requireUser(): string {
    const userId = this.caller?.userId;
    if (!userId || userId === "system") {
      throw new Error("Phone provisioning requires an authenticated user account");
    }
    return userId;
  }
}
