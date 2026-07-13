import type { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  ServiceError,
  type ServiceContext,
  type DeferredResult,
} from "@vibestudio/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { withCapability } from "./capabilityPermission.js";
import {
  authorizeCorsSchema,
  corsApprovalMethods,
  type CorsApprovalResult,
} from "@vibestudio/service-schemas/corsApproval";

export type { CorsApprovalResult } from "@vibestudio/service-schemas/corsApproval";

const SERVICE_NAME = "corsApproval";
const CAPABILITY = "cors-response-read";

export function createCorsApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}): ServiceDefinition {
  async function authorize(
    ctx: ServiceContext,
    rawRequest: z.infer<typeof authorizeCorsSchema>
  ): Promise<CorsApprovalResult | DeferredResult> {
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

    return withCapability(
      {
        approvalQueue: deps.approvalQueue,
        grantStore: deps.grantStore,
      },
      ctx,
      {
        capability: CAPABILITY,
        dedupKey: `cors:${ctx.caller.runtime.id}:${target.origin}`,
        resource: {
          type: "url-origin",
          label: "Target origin",
          value: target.origin,
          key: target.origin,
          scope: { kind: "origin", origin: target.origin },
        },
        operation: {
          kind: "network",
          verb: "Read cross-origin response",
          object: {
            type: "url-origin",
            label: "Target origin",
            value: target.origin,
          },
          groupKey: `cors:${ctx.caller.runtime.id}:${target.origin}`,
        },
        title: `Read responses from ${target.origin}`,
        description: "Allow this requester to read CORS-protected responses from this origin.",
        details: [
          { label: "Request origin", value: request.requestOrigin ?? "unknown" },
          { label: "Target origin", value: target.origin },
        ],
        deniedReason: "Cross-origin response access denied",
      },
      async (authorization): Promise<CorsApprovalResult> =>
        authorization.allowed
          ? { allowed: true, decision: authorization.decision }
          : { allowed: false, reason: authorization.reason }
    );
  }

  return {
    name: SERVICE_NAME,
    description: "Approval-gated CORS response header relaxation",
    policy: { allowed: ["panel", "app", "worker", "do"] },
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
