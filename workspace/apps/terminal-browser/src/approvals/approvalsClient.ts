import type { RpcBridge } from "@natstack/rpc";
import { RPC_METHODS, type ApprovalDecisionId } from "@natstack/shared/approvalContract";
import type { PendingApproval } from "@natstack/shared/approvals";

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

export function createApprovalsClient(bridge: RpcBridge): ApprovalsClient {
  return {
    async list() {
      const pending = await bridge.call<PendingApproval[]>(
        "main",
        RPC_METHODS.shellApproval.listPending,
        [],
      );
      return Array.isArray(pending) ? pending : [];
    },
    async resolve(approvalId, decision) {
      await bridge.call("main", RPC_METHODS.shellApproval.resolve, [approvalId, decision]);
    },
    async resolveUserland(approvalId, choice) {
      await bridge.call("main", RPC_METHODS.shellApproval.resolveUserland, [approvalId, choice]);
    },
    onChange(listener) {
      return bridge.onEvent("shell-approval:pending-changed", () => listener());
    },
  };
}
