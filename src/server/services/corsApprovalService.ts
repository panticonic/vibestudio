import type { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  authorizeCorsSchema,
  corsApprovalMethods,
  type CorsApprovalResult,
} from "@vibestudio/service-schemas/corsApproval";

export type { CorsApprovalResult } from "@vibestudio/service-schemas/corsApproval";

const SERVICE_NAME = "corsApproval";
const CAPABILITY = "cors-response-read";

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

    const decision = ctx.authorityDecisions?.get(CAPABILITY);
    return Promise.resolve({ allowed: true, ...(decision ? { decision } : {}) });
  }

  return {
    name: SERVICE_NAME,
    description: "Approval-gated CORS response header relaxation",
    authority: { principals: ["code"] },
    methods: corsApprovalMethods,
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
