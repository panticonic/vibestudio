import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { RuntimeAgentChannelAdmission } from "@vibestudio/shared/runtime/entitySpec";
import type { RpcServer } from "../rpcServer.js";
import type { RuntimeEntityHooks } from "./runtimeService.js";

/** Initialization is an ordinary routed receiver invocation, owned by its creator. */
export function createRuntimeAgentInitializer(
  resolveRpc: () => Pick<RpcServer, "callTargetAs">,
  resolveEndpoint: (
    input: Parameters<NonNullable<RuntimeEntityHooks["initializeAgent"]>>[0] & { channelId: string }
  ) => Promise<DORef>
): NonNullable<RuntimeEntityHooks["initializeAgent"]> {
  return async (input) => {
    const { record, caller, signal, initialization } = input;
    signal?.throwIfAborted();
    const channelRef = await resolveEndpoint({ ...input, channelId: initialization.channelId });
    signal?.throwIfAborted();
    if (
      !channelRef.source ||
      !channelRef.className ||
      channelRef.objectKey !== initialization.channelId
    )
      throw new Error("Agent initialization resolved another channel endpoint");
    const admission: RuntimeAgentChannelAdmission = { ...initialization, channelRef };
    return resolveRpc().callTargetAs(
      caller,
      record.id,
      "subscribeChannel",
      [
        {
          ...admission,
          contextId: record.contextId,
        },
      ],
      { signal }
    ) as Promise<{ ok: boolean; participantId: string }>;
  };
}
