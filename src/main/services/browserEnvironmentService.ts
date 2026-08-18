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

export function createBrowserEnvironmentService(deps: {
  getDownloads(): BrowserDownloadManager | null;
  getImportProvider(ctx: ServiceContext): BrowserImportHostProvider | null;
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
      getImportHost: (_ctx) => requireImportProvider(deps, _ctx).summary(),
      listImportSources: (_ctx) => requireImportProvider(deps, _ctx).listSources(_ctx.signal),
      previewImportSource: (_ctx, [sourceId, dataTypes]) =>
        requireImportProvider(deps, _ctx).preview(sourceId, dataTypes, _ctx.signal),
      previewSensitiveImport: (_ctx, [sourceId, dataTypes]) => {
        requireReviewedBrowserDataProvider(_ctx, deps.browserDataBrokerRepoPath);
        return requireImportProvider(deps, _ctx).preview(sourceId, dataTypes, _ctx.signal);
      },
      startImportRead: (_ctx, [sourceId, dataTypes]) =>
        requireImportProvider(deps, _ctx).startImport(sourceId, dataTypes),
      startSensitiveImport: (_ctx, [sourceId, dataTypes, operationId]) => {
        requireReviewedBrowserDataProvider(_ctx, deps.browserDataBrokerRepoPath);
        return requireImportProvider(deps, _ctx).startSensitiveImport(
          sourceId,
          dataTypes,
          operationId
        );
      },
      observeSensitiveImport: (_ctx, [operationId]) => {
        requireReviewedBrowserDataProvider(_ctx, deps.browserDataBrokerRepoPath);
        return requireImportProvider(deps, _ctx).observeSensitiveImport(operationId);
      },
      cancelSensitiveImport: (_ctx, [operationId]) => {
        requireReviewedBrowserDataProvider(_ctx, deps.browserDataBrokerRepoPath);
        return requireImportProvider(deps, _ctx).cancelSensitiveImport(operationId);
      },
      nextImportFrame: (_ctx, [operationId]) =>
        requireImportProvider(deps, _ctx).nextFrame(operationId),
      cancelImportRead: (_ctx, [operationId]) =>
        requireImportProvider(deps, _ctx).cancel(operationId),
      listImportOpenTabs: (_ctx, [sourceId]) =>
        requireImportProvider(deps, _ctx).listOpenTabs(sourceId, _ctx.signal),
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

function requireReviewedBrowserDataProvider(
  ctx: {
    caller: {
      runtime: { id: string; kind: string };
      hostOriginated?: true;
      codeApproved?: true;
      code?: { callerId: string; repoPath?: string };
    };
  },
  repoPath: string | null
): void {
  if (ctx.caller.hostOriginated === true) return;
  if (
    ctx.caller.runtime.kind !== "extension" ||
    ctx.caller.codeApproved !== true ||
    ctx.caller.code?.callerId !== ctx.caller.runtime.id ||
    !repoPath ||
    ctx.caller.code.repoPath !== repoPath
  ) {
    throw Object.assign(
      new Error("Sensitive browser import requires the reviewed browser-data provider"),
      {
        code: "EACCES",
      }
    );
  }
}

function requireImportProvider(
  deps: {
    getImportProvider(ctx: ServiceContext): BrowserImportHostProvider | null;
  },
  ctx: ServiceContext
): BrowserImportHostProvider {
  const provider = deps.getImportProvider(ctx);
  if (!provider) throw new Error("Browser import host is unavailable");
  return provider;
}
