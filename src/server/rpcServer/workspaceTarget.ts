import type { RpcEnvelope } from "@vibestudio/rpc";

/** Omitted addressing is local. An explicit foreign address must enter the boundary router. */
export function isLocalWorkspaceTarget(
  envelope: Pick<RpcEnvelope, "targetWorkspaceId">,
  workspaceId: string | undefined
): boolean {
  return (
    envelope.targetWorkspaceId === undefined ||
    (typeof workspaceId === "string" &&
      workspaceId.length > 0 &&
      envelope.targetWorkspaceId === workspaceId)
  );
}

export const WORKSPACE_RPC_NOT_ADMITTED =
  "Cross-workspace RPC has not been admitted by both workspace boundaries";
