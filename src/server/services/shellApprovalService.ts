/**
 * Shell approval service — thin RPC shim over the in-memory approvalQueue.
 *
 * The renderer's ConsentApprovalBar calls `resolve` with a user decision and
 * `listPending` on mount to rehydrate. Shell and app-host callers are permitted directly.
 * Embedded Electron shell calls arrive through the trusted main-process
 * serverClient, so the server sees them as `server` callers. Panels/workers
 * remain blocked. Resolution paths record approval_resolved_total with the
 * transport caller kind as the source label.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { shellApprovalMethods } from "@vibestudio/shared/serviceSchemas/shellApproval";
import { isBootstrapUnitApproval } from "@vibestudio/shared/bootstrapApprovals";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ResolvedVia } from "@vibestudio/shared/governance/types";
import type { ApprovalQueue, ApprovalResolver } from "./approvalQueue.js";
import { pushMetrics, type PushMetrics } from "./pushMetrics.js";

/**
 * The surface a resolution arrived from (WP5 §5). Derived from the transport
 * caller kind — the trusted approval bar is `shell`, adopted app-host chrome is
 * `app`, and the embedded desktop / other host relays are `server`.
 */
function resolvedViaFor(kind: string, clientPlatform?: string): ResolvedVia {
  if (clientPlatform === "mobile") return "mobile-notification";
  if (kind === "shell") return "shell";
  if (kind === "server") return "server";
  return "app";
}

/**
 * Capture the resolving human from the verified connection (WP5 §4) — identity
 * from `ctx.caller.subject`, never the wire (INV-3). The queue's `settle`
 * coordinator turns this into the `resolvedBy` on both the live
 * `shell-approval:resolved` event and the durable `ApprovalProvenanceRecord`.
 * Absent for the enumerated pre-identity bootstrap principals (WP0 §5.4), which
 * simply produce no provenance record.
 */
function resolverFrom(
  ctx: ServiceContext,
  deviceLabelFor: (deviceId: string) => string | undefined
): ApprovalResolver | undefined {
  const subject = ctx.caller.subject;
  if (!subject) return undefined;
  const deviceId =
    ctx.caller.runtime.kind === "shell" && ctx.caller.runtime.id.startsWith("shell:")
      ? ctx.caller.runtime.id.slice("shell:".length)
      : undefined;
  const deviceLabel = deviceId ? deviceLabelFor(deviceId) : undefined;
  return {
    subject,
    via: resolvedViaFor(ctx.caller.runtime.kind, ctx.wsClient?.clientPlatform),
    ...(deviceId ? { deviceId } : {}),
    ...(deviceLabel ? { deviceLabel } : {}),
  };
}

export function createShellApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  metrics?: PushMetrics;
  deviceLabelFor?: (deviceId: string) => string | undefined;
}): ServiceDefinition {
  const { approvalQueue } = deps;
  const metrics = deps.metrics ?? pushMetrics;
  const deviceLabelFor = deps.deviceLabelFor ?? (() => undefined);
  const serviceName = "shellApproval";

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    policy: { allowed: ["shell", "app", "server"] },
    methods: shellApprovalMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "resolve": {
          const [approvalId, decision] = args as [string, ApprovalDecision];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending) {
            throw new ServiceError(serviceName, method, "No pending approval found", "ENOENT");
          }
          // The resolver rides into the queue's `settle` coordinator, which
          // writes the ApprovalProvenanceRecord and broadcasts `resolvedBy`.
          await approvalQueue.resolve(approvalId, decision, resolverFrom(ctx, deviceLabelFor));
          metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
          return;
        }
        case "resolveBootstrap": {
          const [approvalId, decision] = args as [
            string,
            Extract<ApprovalDecision, "once" | "deny">,
          ];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || !isBootstrapUnitApproval(pending)) {
            throw new ServiceError(
              serviceName,
              method,
              "No pending startup app approval found",
              "ENOENT"
            );
          }
          await approvalQueue.resolve(approvalId, decision, resolverFrom(ctx, deviceLabelFor));
          metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
          return;
        }
        case "resolveUserland": {
          const [approvalId, choice] = args as [string, string | "dismiss"];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "userland") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending userland approval found",
              "ENOENT"
            );
          }
          if (choice === "dismiss") {
            await approvalQueue.resolve(approvalId, "dismiss", resolverFrom(ctx, deviceLabelFor));
            metrics.recordApprovalResolved({
              decision: "dismiss",
              source: ctx.caller.runtime.kind,
            });
            return;
          }
          if (!pending.options.some((option) => option.value === choice)) {
            throw new ServiceError(
              serviceName,
              method,
              "Userland approval choice was not presented to the user",
              "EINVAL"
            );
          }
          await approvalQueue.resolveUserland(
            approvalId,
            choice,
            resolverFrom(ctx, deviceLabelFor)
          );
          metrics.recordApprovalResolved({ decision: choice, source: ctx.caller.runtime.kind });
          return;
        }
        case "resolveExternalAgent": {
          const [approvalId, behavior] = args as [string, "allow" | "deny"];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "external-agent") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending external-agent approval found",
              "ENOENT"
            );
          }
          await approvalQueue.resolveExternalAgent(
            approvalId,
            behavior,
            resolverFrom(ctx, deviceLabelFor)
          );
          metrics.recordApprovalResolved({ decision: behavior, source: ctx.caller.runtime.kind });
          return;
        }
        case "resolveExternalAgentByRequest": {
          const [ref, behavior] = args as [
            { channelId: string; requestId: string; resolveToken: string },
            "allow" | "deny",
          ];
          const resolved = await approvalQueue.resolveExternalAgentByRequest(
            ref.channelId,
            ref.requestId,
            ref.resolveToken,
            behavior,
            resolverFrom(ctx, deviceLabelFor)
          );
          if (resolved > 0) {
            metrics.recordApprovalResolved({ decision: behavior, source: ctx.caller.runtime.kind });
          }
          return { resolved: resolved > 0 };
        }
        case "submitClientConfig": {
          const [approvalId, values] = args as [string, Record<string, string>];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "client-config") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending client-config approval found",
              "ENOENT"
            );
          }
          await approvalQueue.submitClientConfig(
            approvalId,
            values,
            resolverFrom(ctx, deviceLabelFor)
          );
          metrics.recordApprovalResolved({ decision: "submit", source: ctx.caller.runtime.kind });
          return;
        }
        case "submitCredentialInput": {
          const [approvalId, values] = args as [string, Record<string, string>];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "credential-input") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending credential-input approval found",
              "ENOENT"
            );
          }
          await approvalQueue.submitCredentialInput(
            approvalId,
            values,
            resolverFrom(ctx, deviceLabelFor)
          );
          metrics.recordApprovalResolved({ decision: "submit", source: ctx.caller.runtime.kind });
          return;
        }
        case "submitSecretInput": {
          const [approvalId, values] = args as [string, Record<string, string>];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "secret-input") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending secret-input approval found",
              "ENOENT"
            );
          }
          await approvalQueue.submitSecretInput(
            approvalId,
            values,
            resolverFrom(ctx, deviceLabelFor)
          );
          metrics.recordApprovalResolved({ decision: "submit", source: ctx.caller.runtime.kind });
          return;
        }
        case "listPending": {
          return approvalQueue.listPending();
        }
        default:
          throw new ServiceError(
            serviceName,
            method,
            `Unknown shellApproval method: ${method}`,
            "ENOSYS"
          );
      }
    },
  };
}
