import type { RpcServer } from "../rpcServer.js";
import type { RuntimeEntityHooks } from "./runtimeService.js";

/** Initialization is an ordinary routed receiver invocation, owned by its creator. */
export function createRuntimeAgentInitializer(
  resolveRpc: () => Pick<RpcServer, "callTargetAs">
): NonNullable<RuntimeEntityHooks["initializeAgent"]> {
  return ({ record, caller, signal, initialization }) =>
    resolveRpc().callTargetAs(
      caller,
      record.id,
      "subscribeChannel",
      [
        {
          ...initialization,
          contextId: record.contextId,
        },
      ],
      { signal }
    ) as Promise<{ ok: boolean; participantId: string }>;
}
