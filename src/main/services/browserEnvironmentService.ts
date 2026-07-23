import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX,
  browserEnvironmentMethods,
} from "@vibestudio/service-schemas/browserEnvironment";
import { allOf, relationship } from "@vibestudio/shared/authorization";
import type { BrowserCookieProjectionApi } from "./browserCookieProjection.js";
import type { BrowserDownloadManager } from "./browserDownloadManager.js";
import type { BrowserImportHostProvider } from "./browserImportHostProvider.js";

export function createBrowserEnvironmentService(deps: {
  getProjection(): BrowserCookieProjectionApi | null;
  getDownloads(): BrowserDownloadManager | null;
  getImportProvider(): BrowserImportHostProvider | null;
  browserDataBrokerRepoPath: string | null;
}): ServiceDefinition {
  const authorityPreparation = Object.fromEntries(
    Object.keys(browserEnvironmentMethods).map((method) => [
      `${BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX}.${method}`,
      (ctx: Parameters<NonNullable<ServiceDefinition["authorityPreparation"]>[string]>[0]) => {
        if (!ctx.caller.code && ctx.caller.sessionOrigin !== true) return [];
        const capability = `service:browserEnvironment.${method}`;
        return [
          {
            capability,
            resourceKey: capability,
            requirement: allOf(
              relationship("workspace-member"),
              relationship(
                "code-source",
                deps.browserDataBrokerRepoPath ?? "__no_browser_data_broker_declared__"
              )
            ),
          },
        ];
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
      getImportHost: () => requireImportProvider(deps).summary(),
      listImportSources: (_ctx) => requireImportProvider(deps).listSources(_ctx.signal),
      previewImportSource: (_ctx, [sourceId, dataTypes]) =>
        requireImportProvider(deps).preview(sourceId, dataTypes, _ctx.signal),
      startImportRead: (_ctx, [sourceId, dataTypes]) =>
        requireImportProvider(deps).startImport(sourceId, dataTypes),
      nextImportFrame: (_ctx, [operationId]) => requireImportProvider(deps).nextFrame(operationId),
      cancelImportRead: (_ctx, [operationId]) => requireImportProvider(deps).cancel(operationId),
      listImportOpenTabs: (_ctx, [sourceId]) =>
        requireImportProvider(deps).listOpenTabs(sourceId, _ctx.signal),
      flushCookieProjection: async (_ctx, [origins]) => {
        const projection = deps.getProjection();
        if (!projection) throw new Error("Browser cookie projection is unavailable");
        return projection.flush(origins);
      },
      getCookieProjectionDiagnostics: () => {
        const projection = deps.getProjection();
        if (!projection) throw new Error("Browser cookie projection is unavailable");
        return projection.diagnostics();
      },
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

function requireImportProvider(deps: {
  getImportProvider(): BrowserImportHostProvider | null;
}): BrowserImportHostProvider {
  const provider = deps.getImportProvider();
  if (!provider) throw new Error("Desktop browser import provider is unavailable");
  return provider;
}
