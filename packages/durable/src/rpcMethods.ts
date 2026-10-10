import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
import type { DurableObjectBase } from "./index.js";
export const durableRpcMethods = createReceiverRpcMethods<
  Pick<DurableObjectBase, "acceptChannelInvocation" | "cancelChannelInvocation">
>(["acceptChannelInvocation", "cancelChannelInvocation"]);
