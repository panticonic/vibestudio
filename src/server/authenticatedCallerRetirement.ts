import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { RpcServer } from "./rpcServer.js";

export interface AuthenticatedCallerRetirementDeps {
  tokenManager: Pick<TokenManager, "revokeToken">;
  rpcServer: Pick<RpcServer, "retireCaller">;
}

/**
 * Invalidate workspace credentials now, then remove their transport reach once
 * each caller's already-running response has drained. Duplicate principals and
 * routes collapse to the same terminal operation.
 */
export async function retireAuthenticatedCallers(
  deps: AuthenticatedCallerRetirementDeps,
  callerIds: readonly string[]
): Promise<void> {
  await Promise.all(
    [...new Set(callerIds)].map((callerId) => {
      deps.tokenManager.revokeToken(callerId);
      return deps.rpcServer.retireCaller(callerId);
    })
  );
}
