import type { EventService } from "@vibestudio/shared/eventsService";
import { assertAllowedOAuthExternalUrl } from "@vibestudio/shared/externalOpen";
import type { OpenExternalOptions, OpenExternalResult } from "@vibestudio/shared/externalOpen";
import {
  EXTERNAL_OPEN_AUTHORITY_RESOLVER,
  EXTERNAL_OPEN_CAPABILITY,
  externalOpenMethods,
} from "@vibestudio/service-schemas/externalOpen";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  describeCapability,
  type CapabilityRequesterKind,
} from "@vibestudio/shared/authorityPresentation";

const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export interface ExternalOpenServiceDeps {
  eventService: EventService;
}

export function createExternalOpenService(deps: ExternalOpenServiceDeps): ServiceDefinition {
  function emitOpen(ctx: ServiceContext, url: URL): void {
    deps.eventService.emit("external-open:open", {
      url: url.toString(),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
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
    const decision = ctx.authorityDecisions?.get(EXTERNAL_OPEN_CAPABILITY);
    return Promise.resolve(decision ? { approvalDecision: decision } : {});
  }

  return {
    name: "externalOpen",
    description: "Approval-gated system browser opens",
    authority: { principals: ["user", "host", "code"] },
    methods: externalOpenMethods,
    authorityPreparation: {
      [EXTERNAL_OPEN_AUTHORITY_RESOLVER]: (ctx, [rawUrl, rawOptions]) => {
        if (!ctx.caller.code && ctx.caller.sessionOrigin !== true) return [];
        const url = normalizeExternalUrl(String(rawUrl));
        const options = rawOptions as OpenExternalOptions | undefined;
        if (options?.expectedRedirectUri) {
          assertAllowedOAuthExternalUrl(url.toString(), options.expectedRedirectUri);
        }
        const resource = resourceForExternalUrl(url);
        const copy = describeCapability(
          EXTERNAL_OPEN_CAPABILITY,
          requesterKind(ctx.caller.runtime.kind)
        );
        return [
          {
            capability: EXTERNAL_OPEN_CAPABILITY,
            resourceKey: resource.key,
            challenge: {
              title: copy.title,
              description: copy.description,
              deniedReason: "Opening this link was not allowed",
              dedupKey: `external-open:${ctx.caller.runtime.id}:${resource.key}`,
              resource,
              operation: {
                kind: "browser",
                verb: copy.action,
                object: resource,
                groupKey: `external-open:${ctx.caller.runtime.id}:${resource.key}`,
              },
              details: externalOpenDetails(url, options),
            },
          },
        ];
      },
    },
    handler: defineServiceHandler("externalOpen", externalOpenMethods, {
      openExternal: (ctx, [url, options]) => requestOpen(ctx, url, options),
    }),
  };
}

function requesterKind(kind: string): CapabilityRequesterKind | undefined {
  if (kind === "do") return "durable-object";
  if (kind === "app" || kind === "panel" || kind === "worker" || kind === "extension") {
    return kind;
  }
  return undefined;
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

function resourceForExternalUrl(url: URL): {
  key: string;
  type: string;
  label: string;
  value: string;
} {
  if (url.protocol === "mailto:") {
    return { key: "mailto:", type: "url-origin", label: "Scheme", value: "mailto:" };
  }
  return { key: url.origin, type: "url-origin", label: "Origin", value: url.origin };
}

function externalOpenDetails(
  url: URL,
  options: OpenExternalOptions | undefined
): Array<{ label: string; value: string }> {
  const details = [{ label: "URL", value: url.toString() }];
  if (options?.expectedRedirectUri) {
    details.push({ label: "OAuth callback", value: options.expectedRedirectUri });
  }
  return details;
}
