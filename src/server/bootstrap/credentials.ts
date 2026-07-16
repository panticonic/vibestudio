import type { EventService } from "@vibestudio/shared/eventsService";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { createHostCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { RouteRegistry, ServiceRouteDecl } from "../routeRegistry.js";
import { serviceWithHttpRoutes } from "../serviceWithHttpRoutes.js";
import { createCredentialCaptureBridge } from "../services/credentialCaptureBridge.js";
import {
  createCredentialService,
  type CredentialRuntimePanelInfo,
  type CredentialServiceDeps,
} from "../services/credentialService.js";

export interface CredentialBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  routeRegistry: RouteRegistry;
  eventService: EventService;
  entityCache: Pick<EntityCache, "listActive">;
  dispatcher: Pick<ServiceDispatcher, "dispatch">;
  credentialStore: NonNullable<CredentialServiceDeps["credentialStore"]>;
  clientConfigStore: NonNullable<CredentialServiceDeps["clientConfigStore"]>;
  auditLog: NonNullable<CredentialServiceDeps["auditLog"]>;
  relayOAuthRegistrar?: CredentialServiceDeps["relayOAuthRegistrar"];
  egressProxy: NonNullable<CredentialServiceDeps["egressProxy"]>;
  disposableGitHttp: NonNullable<CredentialServiceDeps["disposableGitHttp"]>;
  approvalQueue: NonNullable<CredentialServiceDeps["approvalQueue"]>;
  sessionGrantStore: NonNullable<CredentialServiceDeps["sessionGrantStore"]>;
  credentialUseGrantStore: NonNullable<CredentialServiceDeps["credentialUseGrantStore"]>;
  credentialLifecycle: NonNullable<CredentialServiceDeps["credentialLifecycle"]>;
  hasConnectedShell(): boolean;
  getAuthorizingShell: NonNullable<
    CredentialServiceDeps["connectionLookup"]
  >["getAuthorizingShell"];
}

export type BootstrappedCredentialService = ReturnType<typeof createCredentialService> & {
  routes?: ServiceRouteDecl[];
};

/**
 * Build and register the credential boundary.
 *
 * The server bootstrap supplies host capabilities; this module owns the
 * server-to-shell capture adapter and the read-only runtime inspection adapter
 * consumed by the credential service.
 */
export function wireCredentialService(
  deps: CredentialBootstrapDeps
): BootstrappedCredentialService {
  const captureBridge = createCredentialCaptureBridge({
    eventService: deps.eventService,
    hasConnectedShell: deps.hasConnectedShell,
  });
  const captureSessionCredential = <T extends Record<string, unknown>>(
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> => captureBridge.captureSessionCredential<T>(payload, signal);

  const credentialService = createCredentialService({
    completeCapture: (captureId, response) => captureBridge.completeCapture(captureId, response),
    credentialStore: deps.credentialStore,
    clientConfigStore: deps.clientConfigStore,
    auditLog: deps.auditLog,
    eventService: deps.eventService,
    relayOAuthRegistrar: deps.relayOAuthRegistrar,
    connectionLookup: { getAuthorizingShell: deps.getAuthorizingShell },
    egressProxy: deps.egressProxy,
    disposableGitHttp: deps.disposableGitHttp,
    approvalQueue: deps.approvalQueue,
    sessionGrantStore: deps.sessionGrantStore,
    credentialUseGrantStore: deps.credentialUseGrantStore,
    credentialLifecycle: deps.credentialLifecycle,
    runtimeInspector: {
      listActiveEntities: () => deps.entityCache.listActive(),
      resolvePanelSlotByEntity: async (entityId: string) =>
        (await deps.dispatcher.dispatch(
          { caller: createHostCaller("server") },
          "workspace-state",
          "slot.resolveByEntity",
          [entityId]
        )) as string | null,
      listPanels: async () =>
        (await deps.dispatcher.dispatch(
          { caller: createHostCaller("server") },
          "panelTree",
          "list",
          [null]
        )) as CredentialRuntimePanelInfo[],
    },
    openInternalBrowser: async ({ ctx, url, parentPanelId }) => {
      await deps.dispatcher.dispatch(ctx, "panelTree", "create", [
        url,
        { parentId: parentPanelId, focus: true },
      ]);
    },
    sessionCredentialCapture: {
      captureCookies: async (params) => {
        const response = await captureSessionCredential<{
          cookieHeader?: string;
          cookieSession?: { origins?: unknown; cookies?: unknown };
          expiresAt?: number;
          accountIdentity?: Record<string, string>;
        }>(
          {
            kind: "cookies",
            signInUrl: params.signInUrl,
            origins: params.origins,
            cookieNames: params.cookieNames,
            completionUrlPattern: params.completionUrlPattern,
            maxTtlSeconds: params.maxTtlSeconds,
            browser: params.browser,
          },
          params.signal
        );
        if (!response.cookieHeader) {
          throw new Error("Session credential capture returned no cookies");
        }
        return {
          cookieHeader: response.cookieHeader,
          cookieSession: response.cookieSession as never,
          expiresAt: response.expiresAt,
          accountIdentity: response.accountIdentity,
        };
      },
      captureSamlSession: async (params) => {
        const response = await captureSessionCredential<{
          cookieHeader?: string;
          cookieSession?: { origins?: unknown; cookies?: unknown };
          assertion?: string;
          expiresAt?: number;
          accountIdentity?: Record<string, string>;
        }>(
          {
            kind: "saml",
            signInUrl: params.signInUrl,
            spAudience: params.spAudience,
            cookieNames: params.cookieNames,
            assertion: params.assertion,
            completionUrlPattern: params.completionUrlPattern,
            maxTtlSeconds: params.maxTtlSeconds,
            browser: params.browser,
          },
          params.signal
        );
        return {
          cookieHeader: response.cookieHeader,
          cookieSession: response.cookieSession as never,
          assertion: response.assertion,
          expiresAt: response.expiresAt,
          accountIdentity: response.accountIdentity,
        };
      },
    },
  }) as BootstrappedCredentialService;

  deps.container.registerManaged(
    serviceWithHttpRoutes(
      { definition: credentialService, routes: credentialService.routes },
      deps.routeRegistry
    )
  );
  return credentialService;
}
