/**
 * Userland approvals client — the portable `approvals` namespace derived once in
 * `createHostedRuntime`. Wraps the free-function approval helpers so every
 * target (panel · worker · eval) gets the identical `{ request, revoke, list }`
 * surface instead of re-binding the functions per barrel.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import {
  listUserlandApprovals,
  requestUserlandApproval,
  revokeUserlandApproval,
  type UserlandApprovalChoice,
  type UserlandApprovalGrant,
  type UserlandApprovalRequest,
} from "../approvals.js";

export interface ApprovalsApi {
  /** Ask for a provider-defined custom-resource choice. The result is the choice, not a grant id. */
  request(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
  /** Forget a saved custom-resource choice using the same subject id passed to request(). */
  revoke(subjectId: string): Promise<boolean>;
  /**
   * List this caller's saved custom-resource choices only. To inspect all active
   * workspace permission grants, call the host `permissions.list` service.
   */
  list(): Promise<UserlandApprovalGrant[]>;
}

export function createApprovalsApi(rpc: RpcCaller): ApprovalsApi {
  return {
    request: (req) => requestUserlandApproval(rpc, req),
    revoke: (subjectId) => revokeUserlandApproval(rpc, subjectId),
    list: () => listUserlandApprovals(rpc),
  };
}
