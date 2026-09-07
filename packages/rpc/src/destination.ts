import type { AuthenticatedCaller, RpcDestination } from "./types.js";

export function isWorkspaceRpcDestination(
  destination: unknown
): destination is Extract<RpcDestination, { kind: "workspace" }> | undefined {
  return (
    destination === undefined ||
    (!!destination &&
      typeof destination === "object" &&
      (destination as { kind?: unknown }).kind === "workspace" &&
      typeof (destination as { workspaceId?: unknown }).workspaceId === "string" &&
      Boolean((destination as { workspaceId: string }).workspaceId))
  );
}

/** Omitted routing remains local; a hub address can never name a workspace. */
export function isLocalRpcDestination(
  destination: RpcDestination | undefined,
  workspaceId: string | undefined
): boolean {
  return (
    destination === undefined ||
    (isWorkspaceRpcDestination(destination) && destination?.workspaceId === workspaceId)
  );
}

/** Compare an authenticated reply owner with the requested transport owner. */
export function rpcDestinationMatchesCaller(
  destination: RpcDestination | undefined,
  caller: AuthenticatedCaller
): boolean {
  if (!destination) return true;
  return destination.kind === "workspace"
    ? caller.workspaceId === destination.workspaceId
    : destination.kind === "hub" && caller.workspaceId === undefined && caller.callerId === "hub";
}

export function rpcDestinationKey(destination: RpcDestination): string {
  return destination.kind === "hub"
    ? JSON.stringify(["hub"])
    : JSON.stringify(["workspace", workspaceRpcDestination(destination)]);
}

/** Workspace-only receivers must reject hub addresses before local fallback. */
export function workspaceRpcDestination(
  destination: RpcDestination | undefined
): string | undefined {
  if (destination === undefined) return undefined;
  if (!isWorkspaceRpcDestination(destination)) {
    throw new Error("This receiver requires a workspace RPC destination");
  }
  return destination.workspaceId;
}
