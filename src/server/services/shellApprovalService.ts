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
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { isBootstrapUnitApproval } from "@vibestudio/shared/bootstrapApprovals";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ResolvedVia } from "@vibestudio/shared/governance/types";
import type { ApprovalQueue, ApprovalResolver } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
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
  capabilityGrantStore?: CapabilityGrantStore;
}): ServiceDefinition {
  const { approvalQueue } = deps;
  const metrics = deps.metrics ?? pushMetrics;
  const deviceLabelFor = deps.deviceLabelFor ?? (() => undefined);
  const serviceName = "shellApproval";

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    authority: { principals: ["user", "code", "host"] },
    methods: shellApprovalMethods,
    handler: defineServiceHandler(serviceName, shellApprovalMethods, {
      resolve: async (ctx, [approvalId, decision]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending) {
          throw new ServiceError(serviceName, "resolve", "No pending approval found", "ENOENT");
        }
        // The resolver rides into the queue's `settle` coordinator, which
        // writes the ApprovalProvenanceRecord and broadcasts `resolvedBy`.
        await approvalQueue.resolve(approvalId, decision, resolverFrom(ctx, deviceLabelFor));
        metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
      },
      blockCapability: async (ctx, [approvalId]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "capability") {
          throw new ServiceError(
            serviceName,
            "blockCapability",
            "No pending capability approval found",
            "ENOENT"
          );
        }
        if (!deps.capabilityGrantStore) {
          throw new ServiceError(
            serviceName,
            "blockCapability",
            "Capability grant store unavailable",
            "ENOSYS"
          );
        }
        const resourceKey = pending.grantResourceKey ?? pending.resource?.value;
        if (!resourceKey) {
          throw new ServiceError(
            serviceName,
            "blockCapability",
            "Capability resource is missing",
            "EINVAL"
          );
        }
        deps.capabilityGrantStore.grant(
          pending.capability,
          resourceKey,
          {
            callerId: pending.callerId,
            repoPath: pending.repoPath,
            effectiveVersion: pending.effectiveVersion,
          },
          "version",
          pending.resourceScope,
          Date.now(),
          "deny"
        );
        await approvalQueue.resolve(approvalId, "deny", resolverFrom(ctx, deviceLabelFor));
        metrics.recordApprovalResolved({ decision: "deny", source: ctx.caller.runtime.kind });
      },
      resolveBootstrap: async (ctx, [approvalId, decision]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || !isBootstrapUnitApproval(pending)) {
          throw new ServiceError(
            serviceName,
            "resolveBootstrap",
            "No pending startup app approval found",
            "ENOENT"
          );
        }
        await approvalQueue.resolve(approvalId, decision, resolverFrom(ctx, deviceLabelFor));
        metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
      },
      resolveUserland: async (ctx, [approvalId, choice]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "userland") {
          throw new ServiceError(
            serviceName,
            "resolveUserland",
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
            "resolveUserland",
            "Userland approval choice was not presented to the user",
            "EINVAL"
          );
        }
        await approvalQueue.resolveUserland(approvalId, choice, resolverFrom(ctx, deviceLabelFor));
        metrics.recordApprovalResolved({ decision: choice, source: ctx.caller.runtime.kind });
      },
      resolveExternalAgent: async (ctx, [approvalId, behavior]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "external-agent") {
          throw new ServiceError(
            serviceName,
            "resolveExternalAgent",
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
      },
      resolveExternalAgentByRequest: async (ctx, [ref, behavior]) => {
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
      },
      submitClientConfig: async (ctx, [approvalId, values]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "client-config") {
          throw new ServiceError(
            serviceName,
            "submitClientConfig",
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
      },
      submitCredentialInput: async (ctx, [approvalId, values]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "credential-input") {
          throw new ServiceError(
            serviceName,
            "submitCredentialInput",
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
      },
      submitSecretInput: async (ctx, [approvalId, values]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "secret-input") {
          throw new ServiceError(
            serviceName,
            "submitSecretInput",
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
      },
      listPending: () => approvalQueue.listPending(),
    }),
  };
}
