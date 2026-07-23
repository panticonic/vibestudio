import type { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  CORS_RESPONSE_AUTHORITY_RESOLVER,
  CORS_RESPONSE_CAPABILITY,
  authorizeCorsSchema,
  corsApprovalMethods,
  type CorsApprovalResult,
} from "@vibestudio/service-schemas/corsApproval";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";

export type { CorsApprovalResult } from "@vibestudio/service-schemas/corsApproval";

const SERVICE_NAME = "corsApproval";
export function createCorsApprovalService(): ServiceDefinition {
  async function authorize(
    ctx: ServiceContext,
    rawRequest: z.infer<typeof authorizeCorsSchema>
  ): Promise<CorsApprovalResult> {
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "app" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        SERVICE_NAME,
        "authorize",
        "corsApproval requires a verified panel, app, worker, or DO caller",
        "EACCES"
      );
    }

    const request = authorizeCorsSchema.parse(rawRequest);
    const target = normalizeHttpOrigin(request.targetUrl);
    if (!target) {
      return { allowed: false, reason: "CORS target must be an http(s) URL" };
    }

    return {
      allowed: true,
      decision: ctx.authorityDecisions?.get(CORS_RESPONSE_CAPABILITY),
    };
  }

  return {
    name: SERVICE_NAME,
    description: "Approval-gated CORS response header relaxation",
    authority: { principals: ["code"] },
    methods: corsApprovalMethods,
    authorityPreparation: {
      [CORS_RESPONSE_AUTHORITY_RESOLVER]: (ctx, [rawRequest]) => {
        const request = authorizeCorsSchema.parse(rawRequest);
        const target = normalizeHttpOrigin(request.targetUrl);
        if (!target) {
          throw new ServiceError(
            SERVICE_NAME,
            "authorize",
            "CORS target must be an http(s) URL",
            "EINVAL"
          );
        }
        const resource = {
          type: "url-origin",
          label: "Website",
          value: target.origin,
        };
        const copy = describeCapability(CORS_RESPONSE_CAPABILITY, "panel");
        return [
          {
            capability: CORS_RESPONSE_CAPABILITY,
            resourceKey: target.origin,
            challenge: {
              title: copy.title,
              description: copy.description,
              deniedReason: "Reading this website's response was not allowed",
              dedupKey: `cors:${ctx.caller.runtime.id}:${target.origin}`,
              resource,
              operation: {
                kind: "network",
                verb: copy.action,
                object: resource,
                groupKey: `cors:${ctx.caller.runtime.id}:${target.origin}`,
              },
              details: [
                { label: "Requesting website", value: request.requestOrigin ?? "unknown" },
                { label: "Website", value: target.origin },
              ],
            },
          },
        ];
      },
    },
    handler: defineServiceHandler(SERVICE_NAME, corsApprovalMethods, {
      authorize: (ctx, [request]) => authorize(ctx, request),
    }),
  };
}

function normalizeHttpOrigin(rawUrl: string): { origin: string } | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { origin: url.origin };
  } catch {
    return null;
  }
}
