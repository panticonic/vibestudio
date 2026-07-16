import type { EventService } from "@vibestudio/shared/eventsService";
import { assertAllowedOAuthExternalUrl } from "@vibestudio/shared/externalOpen";
import type { OpenExternalOptions, OpenExternalResult } from "@vibestudio/shared/externalOpen";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

const CAPABILITY = "external-browser-open";
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export interface ExternalOpenServiceDeps {
  eventService: EventService;
}

export function createExternalOpenService(deps: ExternalOpenServiceDeps): ServiceDefinition {
  function emitOpen(ctx: ServiceContext, url: URL): void {
    const caller = ctx.authorizingCaller ?? ctx.caller;
    deps.eventService.emit("external-open:open", {
      url: url.toString(),
      callerId: caller.runtime.id,
      callerKind: caller.runtime.kind,
    });
  }

  function requestOpen(
    ctx: ServiceContext,
    rawUrl: string,
    options?: OpenExternalOptions
  ): Promise<OpenExternalResult> {
    const url = normalizeExternalUrl(rawUrl);
    if (options?.expectedRedirectUri) {
      assertAllowedOAuthExternalUrl(url.toString(), options.expectedRedirectUri);
    }
    emitOpen(ctx, url);
    const decision = ctx.authorityDecisions?.get(CAPABILITY);
    return Promise.resolve(decision ? { approvalDecision: decision } : {});
  }

  return {
    name: "externalOpen",
    description: "Approval-gated system browser opens",
    authority: { principals: ["user", "host", "code"] },
    methods: externalOpenMethods,
    handler: defineServiceHandler("externalOpen", externalOpenMethods, {
      openExternal: (ctx, [url, options]) => requestOpen(ctx, url, options),
    }),
  };
}

function normalizeExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("openExternal requires an absolute URL");
  }
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error("openExternal only supports http(s) and mailto URLs");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.hash = "";
  }
  return url;
}
