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
import {
  SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER,
  SHELL_APPROVAL_INPUT_AUTHORITY_RESOLVER,
  SHELL_APPROVAL_READ_AUTHORITY_RESOLVER,
  shellApprovalMethods,
} from "@vibestudio/service-schemas/shellApproval";
import type { WorkspaceCreationReviewState } from "@vibestudio/service-schemas/shellApproval";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityState,
} from "@vibestudio/shared/serviceDefinition";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { isBootstrapUnitApproval } from "@vibestudio/shared/bootstrapApprovals";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ResolvedVia } from "@vibestudio/shared/governance/types";
import type { ApprovalQueue, ApprovalResolver } from "./approvalQueue.js";
import { pushMetrics, type PushMetrics } from "./pushMetrics.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

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
  workspaceCreationReviewState?: () => WorkspaceCreationReviewState;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}): ServiceDefinition {
  const { approvalQueue } = deps;
  const metrics = deps.metrics ?? pushMetrics;
  const deviceLabelFor = deps.deviceLabelFor ?? (() => undefined);
  const workspaceCreationReviewState =
    deps.workspaceCreationReviewState ?? (() => ({ status: "resolved" as const }));
  const serviceName = "shellApproval";
  const preparePresenter = (capability: string) => (ctx: ServiceContext) => {
    if (
      isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability }) ||
      (!ctx.caller.code && !ctx.caller.executionSession)
    ) {
      return preparedAuthorityState([]);
    }
    return preparedAuthorityState([
      fixedPreparedAuthoritySelection({ capability, resourceKey: capability }),
    ]);
  };

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    authority: { principals: ["user", "code", "host"] },
    methods: shellApprovalMethods,
    authorityPreparation: {
      [SHELL_APPROVAL_READ_AUTHORITY_RESOLVER]: preparePresenter("approvals.read"),
      [SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER]: preparePresenter("approvals.decide"),
      [SHELL_APPROVAL_INPUT_AUTHORITY_RESOLVER]: preparePresenter("protected-input.submit"),
    },
    handler: defineServiceHandler(serviceName, shellApprovalMethods, {
      resolve: async (ctx, [approvalId, decision]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending) {
          throw new ServiceError(serviceName, "resolve", "No pending approval found", "ENOENT");
        }
        if (pending.kind === "unit-install-review") {
          throw new ServiceError(
            serviceName,
            "resolve",
            "Unit install reviews must be resolved through resolveInstallReview",
            "EINVAL"
          );
        }
        // The resolver rides into the queue's `settle` coordinator, which
        // writes the ApprovalProvenanceRecord and broadcasts `resolvedBy`.
        await approvalQueue.resolve(approvalId, decision, resolverFrom(ctx, deviceLabelFor));
        metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
      },
      resolveInstallReview: async (ctx, [approvalId, resolution]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "unit-install-review") {
          throw new ServiceError(
            serviceName,
            "resolveInstallReview",
            "No pending review found",
            "ENOENT"
          );
        }
        const resolver = resolverFrom(ctx, deviceLabelFor);
        if (!resolver) {
          throw new ServiceError(
            serviceName,
            "resolveInstallReview",
            "Adding or updating parts requires an authenticated human",
            "EACCES"
          );
        }
        const result = await approvalQueue.resolveInstallReview(approvalId, resolution, resolver);
        metrics.recordApprovalResolved({
          decision: resolution.decision,
          source: ctx.caller.runtime.kind,
        });
        // The receipt goes back to the surface that asked (§7.2). It is the only
        // one that knows a decision was made here, so it is the only one that
        // can say what came of it — including that the outcome is still under
        // way, which is what an absent `landing` means.
        return result;
      },
      resolveTaskRules: async (ctx, [approvalId, resolution]) => {
        const pending = approvalQueue
          .listPending()
          .find((approval) => approval.approvalId === approvalId);
        if (!pending || pending.kind !== "capability" || pending.cardType !== "task.rules") {
          throw new ServiceError(
            serviceName,
            "resolveTaskRules",
            "No pending chat-rules review found",
            "ENOENT"
          );
        }
        const resolver = resolverFrom(ctx, deviceLabelFor);
        if (!resolver) {
          throw new ServiceError(
            serviceName,
            "resolveTaskRules",
            "Choosing chat permissions requires an authenticated human",
            "EACCES"
          );
        }
        if (!approvalQueue.resolveTaskRules) {
          throw new ServiceError(
            serviceName,
            "resolveTaskRules",
            "Chat-rules resolution is unavailable",
            "ENOSYS"
          );
        }
        await approvalQueue.resolveTaskRules(approvalId, resolution, resolver);
        metrics.recordApprovalResolved({
          decision: resolution.decision,
          source: ctx.caller.runtime.kind,
        });
      },
      resolveBootstrap: async (ctx, [approvalIds, decision]) => {
        const results: Array<{
          approvalId: string;
          status: "resolved" | "not-pending";
        }> = [];
        const resolver = resolverFrom(ctx, deviceLabelFor);
        // The launch gate answers an install review, so it settles through the
        // install-review path like every other surface — that path is what
        // records admission and mints clearance. The gate offers no
        // per-permission choice (§7.6 asks whose code this is, not what it may
        // reach), so accepting clears the full slate the manifest allows.
        // A batch may have partially settled before one resolution fails. The
        // result makes already-settled ids explicit; retrying the same snapshot
        // can therefore skip them and converge on the remaining approvals.
        for (const approvalId of approvalIds) {
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || !isBootstrapUnitApproval(pending)) {
            results.push({ approvalId, status: "not-pending" });
            continue;
          }
          await approvalQueue.resolveInstallReview(
            approvalId,
            decision === "once"
              ? defaultAcceptance(pending.mode, pending.parts)
              : { decision: "cancel" },
            resolver
          );
          metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
          results.push({ approvalId, status: "resolved" });
        }
        return results;
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
      getWorkspaceCreationReviewState: () => workspaceCreationReviewState(),
    }),
  };
}
