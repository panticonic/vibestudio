import { createRpcMethods, type RpcMethods } from "@vibestudio/shared/rpcMethods";
import {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  type RpcCallerLike,
  type DurableObjectServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
import { gadWireMethods, type GadWireMethods } from "../workspaceSource.js";
import { createDurableObjectServiceClient } from "./durableObjectServiceClient.js";

export const gadRpcMethods: RpcMethods<GadWireMethods> = createRpcMethods(
  "gad",
  gadWireMethods,
  ""
);

export function createGadServiceClient(
  rpc: RpcCallerLike
): DurableObjectServiceClient<typeof gadRpcMethods> {
  return createDurableObjectServiceClient(rpc, GAD_WORKSPACE_SERVICE_PROTOCOL, gadRpcMethods);
}
