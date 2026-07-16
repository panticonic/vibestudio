import {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  VCS_SERVICE_PROTOCOL,
} from "@vibestudio/shared/workspaceServiceRpc";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDoLoader.js";

/**
 * Product-sealed identity of the workspace semantic control plane.
 *
 * This is executable product topology, not workspace-authored configuration:
 * a workspace manifest cannot replace the authority that interprets that
 * manifest, owns semantic history, or publishes protected main.
 */
export const SEMANTIC_CONTROL_PLANE = Object.freeze({
  source: INTERNAL_DO_SOURCE,
  className: "GadWorkspaceDO",
  objectKey: "workspace-semantic-control-plane",
  protocols: Object.freeze([GAD_WORKSPACE_SERVICE_PROTOCOL, VCS_SERVICE_PROTOCOL]),
});

/** One process-local call adapter to the existing sealed semantic workspace. */
export interface SemanticControlPlaneCaller {
  call<T = unknown>(method: string, input: unknown): Promise<T>;
}

export function createSemanticControlPlaneCaller(
  dispatch: Pick<DODispatch, "dispatch">
): SemanticControlPlaneCaller {
  const { source, className, objectKey } = SEMANTIC_CONTROL_PLANE;
  return {
    call: <T>(method: string, input: unknown): Promise<T> =>
      dispatch.dispatch({ source, className, objectKey }, method, input) as Promise<T>,
  };
}

/**
 * Check that one host-bound causal coordinate names an invocation row in the
 * canonical trajectory projection. This is an integrity/existence check, not
 * authorship, authorization, or a transported capability.
 */
export async function hasExactCausalInvocation(
  caller: SemanticControlPlaneCaller,
  parent: RpcCausalParent
): Promise<boolean> {
  const inspection = await caller.call<{
    rows: Array<{ log_id?: unknown; head?: unknown; invocation_id?: unknown }>;
  }>("inspectInvocationState", {
    trajectoryId: parent.logId,
    branchId: parent.head,
    invocationId: parent.invocationId,
    limit: 1,
  });
  return inspection.rows.some(
    (row) =>
      row.log_id === parent.logId &&
      row.head === parent.head &&
      row.invocation_id === parent.invocationId
  );
}

/**
 * Process-owned environment for the sealed workspace authority. Workspace
 * identity originates at the hub and is never nominated by a semantic command
 * or inferred from the Durable Object's storage coordinate.
 */
export function semanticControlPlaneEnvironment(
  workspaceId: string
): Readonly<{ WORKSPACE_ID: string }> {
  if (workspaceId.length === 0) {
    throw new Error("Semantic control plane requires a workspace identity");
  }
  return Object.freeze({ WORKSPACE_ID: workspaceId });
}
