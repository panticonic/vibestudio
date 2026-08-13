import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { browserVaultNativeMethods } from "@vibestudio/service-schemas/browserVaultNative";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

const SERVICE = "browserVaultNative";

/**
 * Native-host entry to protected browser material.
 *
 * Workspace code never resolves BrowserVaultDO and never receives this service.
 * Electron binds calls to the active WebContents/origin before using this
 * surface; the server derives the vault object key from the authenticated host
 * session rather than accepting one from the caller.
 */
export function createBrowserVaultNativeService(deps: {
  doDispatch: DoDispatcher;
  workspaceId: string;
}): ServiceDefinition {
  const call = <T>(ctx: ServiceContext, method: string, args: unknown[]): Promise<T> => {
    // `shell` is already the native-host caller kind: the literal id "shell" is
    // refused over WebSocket, and every admitted shell principal — the desktop
    // console (`electron-main`, `headless-host`) as much as a paired
    // `shell:<device>` credential — carries a hub-resolved human subject.
    // Matching on the id prefix instead would lock the desktop app itself out
    // of its own password, cookie, and autofill storage.
    const trustedShell =
      ctx.caller.runtime.kind === "shell" &&
      !!ctx.caller.subject?.userId &&
      ctx.caller.subject.userId !== "system";
    if (ctx.caller.hostOriginated !== true && !trustedShell) {
      throw new Error("Protected browser storage requires the product host or authenticated shell");
    }
    const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
    return deps.doDispatch.dispatch(
      {
        source: INTERNAL_DO_SOURCE,
        className: "BrowserVaultDO",
        objectKey: identity.environmentKey,
      },
      method,
      ...args
    ) as Promise<T>;
  };

  return {
    name: SERVICE,
    description: "Native-host access to protected browser material",
    authority: { principals: ["host", "user"] },
    methods: browserVaultNativeMethods,
    handler: defineServiceHandler(SERVICE, browserVaultNativeMethods, {
      listPasswordSummaries: (ctx, args) => call(ctx, "listPasswordSummaries", args),
      listPasswordSummariesPage: (ctx, args) => call(ctx, "listPasswordSummariesPage", args),
      getPasswordForSite: (ctx, args) => call(ctx, "getPasswordForSite", args),
      listPasswordsPage: (ctx, args) => call(ctx, "listPasswordsPage", args),
      addPassword: (ctx, args) => call(ctx, "addPassword", args),
      updatePassword: (ctx, args) => call(ctx, "updatePassword", args),
      deletePassword: (ctx, args) => call(ctx, "deletePassword", args),
      addNeverSave: (ctx, args) => call(ctx, "addNeverSave", args),
      isNeverSave: (ctx, args) => call(ctx, "isNeverSave", args),
      getNeverSaveOrigins: (ctx, args) => call(ctx, "getNeverSaveOrigins", args),
      getNeverSaveOriginsPage: (ctx, args) => call(ctx, "getNeverSaveOriginsPage", args),
      removeNeverSave: (ctx, args) => call(ctx, "removeNeverSave", args),
      updateLastUsed: (ctx, args) => call(ctx, "updateLastUsed", args),
      getFormFillSuggestions: (ctx, args) => call(ctx, "getFormFillSuggestions", args),
      listFormFillValues: (ctx, args) => call(ctx, "listFormFillValues", args),
      listFormFillValuesPage: (ctx, args) => call(ctx, "listFormFillValuesPage", args),
      addFormFillValue: (ctx, args) => call(ctx, "addFormFillValue", args),
      updateFormFillValue: (ctx, args) => call(ctx, "updateFormFillValue", args),
      markFormFillValueUsed: (ctx, args) => call(ctx, "markFormFillValueUsed", args),
      deleteFormFillValue: (ctx, args) => call(ctx, "deleteFormFillValue", args),
      clearFormFillValues: (ctx, args) => call(ctx, "clearFormFillValues", args),
      applyCookieMutations: (ctx, args) => call(ctx, "applyCookieMutations", args),
      listCookieOrigins: (ctx, args) => call(ctx, "listCookieOrigins", args),
      listCookieOriginsPage: (ctx, args) => call(ctx, "listCookieOriginsPage", args),
      getCookiesForOrigin: (ctx, args) => call(ctx, "getCookiesForOrigin", args),
      listCookiesPage: (ctx, args) => call(ctx, "listCookiesPage", args),
      clearCookiesForOrigin: (ctx, args) => call(ctx, "clearCookiesForOrigin", args),
      clearAllCookies: (ctx, args) => call(ctx, "clearAllCookies", args),
      endBrowserSession: (ctx, args) => call(ctx, "endBrowserSession", args),
      getCookieSiteSummary: (ctx, args) => call(ctx, "getCookieSiteSummary", args),
      addCookiesBatch: (ctx, args) => call(ctx, "addCookiesBatch", args),
      addPasswordsBatch: (ctx, args) => call(ctx, "addPasswordsBatch", args),
      addFormFillBatch: (ctx, args) => call(ctx, "addFormFillBatch", args),
    }),
  };
}
