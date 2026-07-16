import type { RpcClient } from "@vibestudio/rpc";
import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import {
  SHELL_APPROVAL_PENDING_CHANGED_EVENT,
} from "@vibestudio/shell-core/approvalState";
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
  resolveUserland(approvalId: string, choice: string): Promise<void>;
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
    async resolveUserland(approvalId, choice) {
      await shellApproval.resolveUserland(approvalId, choice);
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
