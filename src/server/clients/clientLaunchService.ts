import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import type { ClientIntentDecl, HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import type { ClientHost } from "./clientRegistry.js";

export interface ClientLaunchServiceDeps {
  getClientHost(): ClientHost | null;
  /**
   * Call a client's declared workspace service method (`<protocol>#<method>`:
   * a background intent's handler or an intent's dynamic-entries method) as
   * that client's principal on the asking device. The method's own authority
   * applies, so the same review and grants govern it as any other call.
   */
  callClientHandler(input: {
    /** The device host that asked; its device id names the principal. */
    caller: VerifiedCaller;
    signal?: AbortSignal;
    source: string;
    handler: string;
    params: Record<string, string>;
  }): Promise<unknown>;
}

const MAX_DYNAMIC_ENTRIES = 32;

type DynamicEntry = { title: string; params: Record<string, string> };

function intentResult(intent: ClientIntentDecl, result: unknown): { text: string } {
  if (typeof result !== "string") {
    throw new Error(`Intent handler ${intent.handler} must return text`);
  }
  return { text: result };
}

function dynamicEntries(intent: ClientIntentDecl, result: unknown): DynamicEntry[] {
  const fail = (defect: string): never => {
    throw new Error(`Dynamic entries method ${intent.dynamic} ${defect}`);
  };
  if (!Array.isArray(result)) return fail("must return a list of {title, params}");
  if (result.length > MAX_DYNAMIC_ENTRIES) {
    return fail(`returned ${result.length} entries; at most ${MAX_DYNAMIC_ENTRIES} are projected`);
  }
  return result.map((entry: unknown) => {
    const { title, params } = (entry ?? {}) as { title?: unknown; params?: unknown };
    if (typeof title !== "string" || title.length === 0) return fail("returned an untitled entry");
    const values = params === undefined ? {} : params;
    if (
      !values ||
      typeof values !== "object" ||
      Object.entries(values).some(
        ([name, value]) => typeof value !== "string" || !intent.params || !(name in intent.params)
      )
    ) {
      return fail(`returned entry "${title}" with parameters ${intent.name} does not declare`);
    }
    return { title, params: values as Record<string, string> };
  });
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
          clients: await Promise.all(
            snapshot.clients.map(async ({ source, activeBuildKey, ...client }) => ({
              ...client,
              entries: Object.fromEntries(
                await Promise.all(
                  client.intents
                    .filter((intent) => intent.dynamic && activeBuildKey !== null)
                    .map(async (intent) => [
                      intent.name,
                      dynamicEntries(
                        intent,
                        await deps.callClientHandler({
                          caller: ctx.caller,
                          ...(ctx.signal ? { signal: ctx.signal } : {}),
                          source,
                          handler: intent.dynamic!,
                          params: {},
                        })
                      ),
                    ])
                )
              ),
            }))
          ),
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
        return intentResult(
          resolved.intent,
          await deps.callClientHandler({
            caller: ctx.caller,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            source: resolved.source,
            handler: resolved.intent.handler!,
            params,
          })
        );
      },
    }),
  };
}
