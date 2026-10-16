import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import type { ClientIntentDecl, HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import type { ClientHost } from "./clientRegistry.js";

export interface ClientLaunchServiceDeps {
  getClientHost(): ClientHost | null;
  /**
   * Run a background intent's handler (`<protocol>#<method>`) as the device
   * that asked, with the intent's parameters. The handler's own authority
   * applies, so the same review and grants govern it as any other call.
   */
  invokeIntentHandler(input: {
    /** The device host that asked; its device id names the principal. */
    caller: VerifiedCaller;
    signal?: AbortSignal;
    source: string;
    intent: ClientIntentDecl;
    params: Record<string, string>;
  }): Promise<{ text?: string; stream?: { channelId: string } }>;
}

/**
 * The `clients` service (docs/client-hosts-and-clients-plan.md §4.5, §4.7.2):
 * one launch and delivery pipeline every host calls on its device shell
 * session. Resolution happens here; hosts never read the workspace manifest.
 */
export function createClientLaunchService(deps: ClientLaunchServiceDeps): ServiceDefinition {
  const clientHost = (method: string): ClientHost => {
    const host = deps.getClientHost();
    if (!host) {
      throw new ServiceError(
        "clients",
        method,
        "Clients run only from the System workspace",
        "CLIENTS_UNAVAILABLE"
      );
    }
    return host;
  };
  const requireHost = (caller: VerifiedCaller, method: string): void => {
    const { id, kind } = caller.runtime;
    if (kind === "shell" && (id === "electron-main" || id.startsWith("shell:"))) return;
    throw new ServiceError(
      "clients",
      method,
      "Clients are launched by the device host that owns this connection",
      "EACCES",
      undefined,
      "access"
    );
  };

  return {
    name: "clients",
    description: "Resolve, launch and list the clients hosts run",
    authority: { principals: ["host", "user"] },
    methods: clientsMethods,
    handler: defineServiceHandler("clients", clientsMethods, {
      launch: async (ctx, [request]) => {
        requireHost(ctx.caller, "launch");
        return clientHost("launch").launch({
          host: request.host as HostDescriptor,
          select: request.select,
          ...(request.rollbackTo ? { rollbackTo: request.rollbackTo } : {}),
        });
      },
      list: async (ctx, [host]) => {
        requireHost(ctx.caller, "list");
        return clientHost("list").listClients(host as HostDescriptor);
      },
      integrationSnapshot: async (ctx, [host]) => {
        requireHost(ctx.caller, "integrationSnapshot");
        const snapshot = await clientHost("integrationSnapshot").integrationSnapshot(
          host as HostDescriptor
        );
        return {
          clients: snapshot.clients.map((client) => ({ ...client, entries: {} })),
        };
      },
      invokeIntent: async (ctx, [host, request]) => {
        requireHost(ctx.caller, "invokeIntent");
        const resolved = clientHost("invokeIntent").resolveBackgroundIntent(
          host as HostDescriptor,
          request
        );
        const params = request.params ?? {};
        for (const name of Object.keys(params)) {
          if (!resolved.intent.params || !(name in resolved.intent.params)) {
            throw new ServiceError(
              "clients",
              "invokeIntent",
              `Intent ${request.id}/${request.intent} has no parameter ${name}`,
              "EINVAL"
            );
          }
        }
        return deps.invokeIntentHandler({
          caller: ctx.caller,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          source: resolved.source,
          intent: resolved.intent,
          params,
        });
      },
    }),
  };
}
