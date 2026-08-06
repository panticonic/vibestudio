import type { RpcClient } from "@vibestudio/rpc";
import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { TemplateInstallResolution } from "@vibestudio/shared/authority/unitInstallReview";
import type { InstallReviewResolution } from "@vibestudio/service-schemas/shellApproval";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import { SHELL_APPROVAL_PENDING_CHANGED_EVENT } from "@vibestudio/shell-core/approvalState";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

/**
 * Thin wrapper over the existing global shell-approval queue. The terminal
 * browser is just a new presentation of the same queue the Electron shell uses
 * (`ConsentApprovalBar`), so decisions made here are authoritative everywhere.
 */
export interface ApprovalsClient {
  list(): Promise<PendingApproval[]>;
  resolve(approvalId: string, decision: ApprovalDecisionId): Promise<void>;
  /**
   * The only valid resolution for a `unit-install-review` approval (§8 of
   * docs/template-install-unit-approval-ux-plan.md): it carries the per-part
   * `allowNow` selection the review offered, never a bare decision id, so
   * `resolve` above cannot be used for this approval kind.
   *
   * Returns what actually happened — which parts landed, which failed, and
   * whether the workspace was left unchanged — because the surface that gave the
   * answer is the one that has to be able to say what came of it, including
   * that nothing did.
   */
  resolveInstallReview(
    approvalId: string,
    resolution: TemplateInstallResolution
  ): Promise<InstallReviewResolution>;
  /** Subscribe to queue changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function createApprovalsClient(rpc: RpcClient): ApprovalsClient {
  const shellApproval = createTypedServiceClient(
    "shellApproval",
    shellApprovalMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  const events = new EventsClient(rpc);
  let changeListeners = 0;
  return {
    async list() {
      const pending = await shellApproval.listPending();
      return Array.isArray(pending) ? filterRuntimeApprovals(pending) : [];
    },
    async resolve(approvalId, decision) {
      await shellApproval.resolve(approvalId, decision);
    },
    async resolveInstallReview(approvalId, resolution) {
      return await shellApproval.resolveInstallReview(approvalId, resolution);
    },
    onChange(listener) {
      const stopListening = events.on(SHELL_APPROVAL_PENDING_CHANGED_EVENT, () => listener());
      changeListeners += 1;
      if (changeListeners === 1) {
        void events
          .subscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT)
          .catch((error: unknown) =>
            console.warn("[terminal-browser] approval event watch failed:", error)
          );
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        stopListening();
        changeListeners = Math.max(0, changeListeners - 1);
        if (changeListeners === 0) {
          void events.unsubscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT).catch(() => {});
        }
      };
    },
  };
}
