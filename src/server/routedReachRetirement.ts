import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { RpcServer } from "./rpcServer.js";

export interface RoutedReachRetirementDeps {
  tokenManager: Pick<TokenManager, "revokeToken">;
  rpcServer: Pick<RpcServer, "retireCaller">;
  disarmRoute(key: string): Promise<void>;
}

/**
 * Invalidate workspace credentials now, then remove their transport reach once
 * each caller's already-running response has drained. Duplicate principals and
 * routes collapse to the same terminal operation.
 */
export async function retireRoutedReach(
  deps: RoutedReachRetirementDeps,
  callerIds: readonly string[],
  routeKeys: readonly string[]
): Promise<void> {
  await Promise.all(
    [...new Set(callerIds)].map((callerId) => {
      deps.tokenManager.revokeToken(callerId);
      return deps.rpcServer.retireCaller(callerId);
    })
  );
  await Promise.all([...new Set(routeKeys)].map((key) => deps.disarmRoute(key)));
}
