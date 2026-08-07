import type { RpcErrorData, RpcErrorKind } from "@vibestudio/rpc";

export const WORKSPACE_RPC_METHOD_UNDECLARED = "WORKSPACE_RPC_METHOD_UNDECLARED";

/**
 * Correctable refusal for a method absent from the exact active worker build.
 * Keep this structured across RPC so agents can distinguish stale publication
 * from receiver failure or missing service authority without parsing prose.
 */
export class WorkspaceRpcMethodUndeclaredError extends Error {
  readonly code = WORKSPACE_RPC_METHOD_UNDECLARED;
  readonly errorKind: RpcErrorKind = "application";
  readonly errorData: RpcErrorData;

  constructor(input: {
    source: string;
    className: string;
    objectKey: string;
    method: string;
    serviceName?: string;
    activeBuildKey?: string | null;
    declaredMethods: readonly string[];
  }) {
    const declaredMethods = [...new Set(input.declaredMethods)].sort();
    const target = `${input.source}:${input.className}:${input.objectKey}`;
    const alternatives = declaredMethods.length > 0 ? declaredMethods.join(", ") : "none";
    super(
      `Active workspace service build for ${target} does not declare RPC method ` +
        `${input.method}. Declared methods: ${alternatives}. ` +
        "If this method was just added, publish or activate that exact provider build before " +
        "calling it; otherwise use a method from the live service docs."
    );
    this.name = "WorkspaceRpcMethodUndeclaredError";
    this.errorData = {
      code: WORKSPACE_RPC_METHOD_UNDECLARED,
      source: input.source,
      className: input.className,
      objectKey: input.objectKey,
      method: input.method,
      ...(input.serviceName ? { serviceName: input.serviceName } : {}),
      ...(input.activeBuildKey ? { activeBuildKey: input.activeBuildKey } : {}),
      declaredMethods,
      safeActions: [
        "open-live-service-docs",
        "use-declared-method",
        "publish-or-activate-provider-build",
      ],
    };
  }
}
