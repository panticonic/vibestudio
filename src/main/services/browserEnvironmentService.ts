import {
  selectedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX,
  browserEnvironmentMethods,
} from "@vibestudio/service-schemas/browserEnvironment";
import { allOf, relationship, requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { BrowserDownloadManager } from "./browserDownloadManager.js";
import type { BrowserImportHostProvider } from "./browserImportHostProvider.js";

export interface BrowserEnvironmentImportRouter {
  listHosts(ctx: ServiceContext): unknown;
  listSources(ctx: ServiceContext, hostId: string): unknown;
  preview(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: Parameters<BrowserImportHostProvider["preview"]>[1]
  ): unknown;
  startImportRead(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: Parameters<BrowserImportHostProvider["startImport"]>[1]
  ): unknown;
  nextImportFrame(ctx: ServiceContext, operationId: string): unknown;
  cancelImportRead(ctx: ServiceContext, operationId: string): unknown;
  listOpenTabs(ctx: ServiceContext, hostId: string, sourceId: string): unknown;
  startSensitiveImport(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: Parameters<BrowserImportHostProvider["startSensitiveImport"]>[1],
    operationId: string
  ): unknown;
  observeSensitiveImport(ctx: ServiceContext, operationId: string): unknown;
  cancelSensitiveImport(ctx: ServiceContext, operationId: string): unknown;
}

export function localBrowserEnvironmentImportRouter(
  getProvider: (ctx: ServiceContext) => BrowserImportHostProvider | null
): BrowserEnvironmentImportRouter {
  const provider = (ctx: ServiceContext, hostId?: string): BrowserImportHostProvider => {
    const resolved = getProvider(ctx);
    if (!resolved) throw new Error("Browser import host is unavailable");
    if (hostId !== undefined && resolved.summary().hostId !== hostId) {
      throw Object.assign(new Error(`Browser import host is unavailable: ${hostId}`), {
        code: "EACCES",
      });
    }
    return resolved;
  };
  return {
    listHosts: (ctx) => [provider(ctx).summary()],
    listSources: (ctx, hostId) => provider(ctx, hostId).listSources(ctx.signal),
    preview: (ctx, hostId, sourceId, dataTypes) =>
      provider(ctx, hostId).preview(sourceId, dataTypes, ctx.signal),
    startImportRead: (ctx, hostId, sourceId, dataTypes) =>
      provider(ctx, hostId).startImport(sourceId, dataTypes),
    nextImportFrame: (ctx, operationId) => provider(ctx).nextFrame(operationId),
    cancelImportRead: (ctx, operationId) => provider(ctx).cancel(operationId),
    listOpenTabs: (ctx, hostId, sourceId) =>
      provider(ctx, hostId).listOpenTabs(sourceId, ctx.signal),
    startSensitiveImport: (ctx, hostId, sourceId, dataTypes, operationId) =>
      provider(ctx, hostId).startSensitiveImport(sourceId, dataTypes, operationId),
    observeSensitiveImport: (ctx, operationId) => provider(ctx).observeSensitiveImport(operationId),
    cancelSensitiveImport: (ctx, operationId) => provider(ctx).cancelSensitiveImport(operationId),
  };
}

export function createBrowserEnvironmentService(deps: {
  getDownloads(): BrowserDownloadManager | null;
  importRouter: BrowserEnvironmentImportRouter;
  browserDataBrokerRepoPath: string | null;
}): ServiceDefinition {
  const nonPromptingProviderMethods = new Set([
    "previewSensitiveImport",
    "startSensitiveImport",
    "observeSensitiveImport",
    "cancelSensitiveImport",
  ]);
  const authorityPreparation = Object.fromEntries(
    Object.keys(browserEnvironmentMethods)
      .filter((method) => !nonPromptingProviderMethods.has(method))
      .map((method) => [
        `${BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX}.${method}`,
        (ctx: Parameters<NonNullable<ServiceDefinition["authorityPreparation"]>[string]>[0]) => {
          if (!ctx.caller.code && !ctx.caller.executionSession)
            return { selections: [], payload: null };
          const capability = `service:browserEnvironment.${method}`;
          return {
            selections: [
              selectedPreparedAuthoritySelection({
                capability,
                resourceKey: capability,
                requirement: allOf(
                  requirementForPrincipals(["code"], capability),
                  relationship(
                    "code-source",
                    deps.browserDataBrokerRepoPath ?? "__no_browser_data_broker_declared__"
                  )
                ),
              }),
            ],
            payload: null,
          };
        },
      ])
  );
  return {
    name: "browserEnvironment",
    description: "Trusted host projection for the active browser environment",
    authority: { principals: ["host", "code"] },
    methods: browserEnvironmentMethods,
    authorityPreparation,
    handler: defineServiceHandler("browserEnvironment", browserEnvironmentMethods, {
      listImportHosts: (_ctx) => deps.importRouter.listHosts(_ctx),
      listImportSources: (_ctx, [hostId]) => deps.importRouter.listSources(_ctx, hostId),
      previewImportSource: (_ctx, [hostId, sourceId, dataTypes]) =>
        deps.importRouter.preview(_ctx, hostId, sourceId, dataTypes),
      previewSensitiveImport: (_ctx, [hostId, sourceId, dataTypes]) => {
        requireBrowserDataProviderSource(_ctx, deps.browserDataBrokerRepoPath);
        return deps.importRouter.preview(_ctx, hostId, sourceId, dataTypes);
      },
      startImportRead: (_ctx, [hostId, sourceId, dataTypes]) =>
        deps.importRouter.startImportRead(_ctx, hostId, sourceId, dataTypes),
      startSensitiveImport: (_ctx, [hostId, sourceId, dataTypes, operationId]) => {
        requireBrowserDataProviderSource(_ctx, deps.browserDataBrokerRepoPath);
        return deps.importRouter.startSensitiveImport(
          _ctx,
          hostId,
          sourceId,
          dataTypes,
          operationId
        );
      },
      observeSensitiveImport: (_ctx, [operationId]) => {
        requireBrowserDataProviderSource(_ctx, deps.browserDataBrokerRepoPath);
        return deps.importRouter.observeSensitiveImport(_ctx, operationId);
      },
      cancelSensitiveImport: (_ctx, [operationId]) => {
        requireBrowserDataProviderSource(_ctx, deps.browserDataBrokerRepoPath);
        return deps.importRouter.cancelSensitiveImport(_ctx, operationId);
      },
      nextImportFrame: (_ctx, [operationId]) =>
        deps.importRouter.nextImportFrame(_ctx, operationId),
      cancelImportRead: (_ctx, [operationId]) =>
        deps.importRouter.cancelImportRead(_ctx, operationId),
      listImportOpenTabs: (_ctx, [hostId, sourceId]) =>
        deps.importRouter.listOpenTabs(_ctx, hostId, sourceId),
      listDownloads: () => deps.getDownloads()?.list() ?? [],
      pauseDownload: (_ctx, [id]) => deps.getDownloads()?.pause(id),
      resumeDownload: (_ctx, [id]) => deps.getDownloads()?.resume(id),
      cancelDownload: (_ctx, [id]) => deps.getDownloads()?.cancel(id),
      openDownload: async (_ctx, [id]) => {
        const downloads = deps.getDownloads();
        if (!downloads) throw new Error("Browser downloads are unavailable");
        await downloads.open(id);
      },
      revealDownload: (_ctx, [id]) => {
        const downloads = deps.getDownloads();
        if (!downloads) throw new Error("Browser downloads are unavailable");
        downloads.reveal(id);
      },
    }),
  };
}

function requireBrowserDataProviderSource(
  ctx: {
    caller: {
      runtime: { id: string; kind: string };
      hostOriginated?: true;
      code?: { callerId: string; repoPath?: string };
    };
  },
  repoPath: string | null
): void {
  if (ctx.caller.hostOriginated === true) return;
  if (
    ctx.caller.runtime.kind !== "extension" ||
    ctx.caller.code?.callerId !== ctx.caller.runtime.id ||
    !repoPath ||
    ctx.caller.code.repoPath !== repoPath
  ) {
    throw Object.assign(
      new Error("Sensitive browser import requires the declared browser-data provider"),
      {
        code: "EACCES",
      }
    );
  }
}
