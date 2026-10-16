import { createTypedRpcServiceClient } from "@vibestudio/shared/typedRpcServiceClient";
/**
 * WorkspaceClient -- Shared workspace RPC wrappers.
 *
 * Wraps workspace-related server RPC calls, delegating to a typed client
 * derived from the shared `workspaceMethods` schema table. Platform-specific
 * Server-wide catalog operations intentionally live on `hubControl` and are
 * absent from this current-workspace client.
 */
import type { RpcClient } from "@vibestudio/rpc";
import { type TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "../workspace.js";

export class WorkspaceClient {
  private typed: TypedServiceClient<typeof workspaceMethods>;
  constructor(rpc: Pick<RpcClient, "call">) {
    this.typed = createTypedRpcServiceClient(
      rpc,
      { targetId: "main", namespace: "workspace" },
      workspaceMethods
    );
  }
  getInfo(): ReturnType<TypedServiceClient<typeof workspaceMethods>["getInfo"]> {
    return this.typed.getInfo();
  }
  getActive(): Promise<string> {
    return this.typed.getActive();
  }
}
