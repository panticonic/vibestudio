/**
 * WorkspaceClient -- Shared workspace RPC wrappers.
 *
 * Wraps workspace-related server RPC calls, delegating to a typed client
 * derived from the shared `workspaceMethods` schema table. Platform-specific
 * Server-wide catalog operations intentionally live on `hubControl` and are
 * absent from this current-workspace client.
 */
import type { RpcClient } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "../workspace.js";
import { runtimeMethods } from "../runtime.js";

export class WorkspaceClient {
  private typed: TypedServiceClient<typeof workspaceMethods>;
  private runtime: TypedServiceClient<typeof runtimeMethods>;
  constructor(rpc: Pick<RpcClient, "call">) {
    this.typed = createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
      rpc.call("main", `${service}.${method}`, args)
    );
    this.runtime = createTypedServiceClient("runtime", runtimeMethods, (service, method, args) =>
      rpc.call("main", `${service}.${method}`, args)
    );
  }
  getInfo(): ReturnType<typeof this.typed.getInfo> {
    return this.typed.getInfo();
  }
  getActive(): Promise<string> {
    return this.typed.getActive();
  }
  appVersions(
    name: string
  ): Promise<{ current: unknown; previous: unknown[]; retentionLimit: number }> {
    return this.runtime.supervision.versions({ kind: "app", releaseId: name });
  }
  rollbackApp(name: string, opts?: { buildKey?: string }): Promise<unknown> {
    return this.runtime.supervision.rollback({ kind: "app", releaseId: name }, opts);
  }
}
