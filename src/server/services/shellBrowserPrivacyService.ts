import { shellBrowserPrivacyMethods } from "@vibestudio/service-schemas/shellBrowserPrivacy";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

const SERVICE = "shellBrowserPrivacy";

/** Direct protected-data manager for the authenticated trusted paired shell. */
export function createShellBrowserPrivacyService(deps: {
  doDispatch: DoDispatcher;
  workspaceId: string;
}): ServiceDefinition {
  const call = <T>(ctx: ServiceContext, method: string, args: unknown[]): Promise<T> => {
    if (
      ctx.caller.runtime.kind !== "shell" ||
      !ctx.caller.runtime.id.startsWith("shell:") ||
      !ctx.caller.subject?.userId ||
      ctx.caller.subject.userId === "system"
    ) {
      throw new Error("Browser privacy management requires an authenticated human shell");
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

  const forward = (method: string) => (ctx: ServiceContext, args: unknown[]) =>
    call(ctx, method, args);

  return {
    name: SERVICE,
    description: "Direct paginated browser-vault management for an authenticated paired shell",
    authority: { principals: ["user"] },
    methods: shellBrowserPrivacyMethods,
    handler: defineServiceHandler(SERVICE, shellBrowserPrivacyMethods, {
      listPasswordSummariesPage: forward("listPasswordSummariesPage"),
      getNeverSaveOriginsPage: forward("getNeverSaveOriginsPage"),
      listFormFillValuesPage: forward("listFormFillValuesPage"),
      listCookieOriginsPage: forward("listCookieOriginsPage"),
      deletePassword: forward("deletePassword"),
      removeNeverSave: forward("removeNeverSave"),
      addFormFillValue: forward("addFormFillValue"),
      updateFormFillValue: forward("updateFormFillValue"),
      deleteFormFillValue: forward("deleteFormFillValue"),
      clearFormFillValues: forward("clearFormFillValues"),
      clearCookiesForOrigin: forward("clearCookiesForOrigin"),
      clearAllCookies: forward("clearAllCookies"),
      endBrowserSession: forward("endBrowserSession"),
      getCookieSiteSummary: forward("getCookieSiteSummary"),
      getPasswordCountForSite: async (ctx, args) => {
        const parsed = new URL(args[0]);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Password-site inspection requires an HTTP(S) origin");
        }
        const origin = parsed.origin;
        const rows = await call<unknown[]>(ctx, "getPasswordForSite", [origin]);
        return { origin, passwordCount: rows.length };
      },
    }),
  };
}
