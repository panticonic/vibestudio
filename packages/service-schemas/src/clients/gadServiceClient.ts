import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  type RpcCallerLike,
  type DurableObjectServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
import { gadWireMethods } from "../workspaceSource.js";
import { createDurableObjectServiceClient } from "./durableObjectServiceClient.js";

export const gadRpcMethods = createRpcMethods("gad", gadWireMethods, "");

export function createGadServiceClient(
  rpc: RpcCallerLike
): DurableObjectServiceClient<typeof gadRpcMethods> {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL, gadRpcMethods);
}
