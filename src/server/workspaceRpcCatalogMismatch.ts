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
    activeEffectiveVersion?: string | null;
    declaredMethods: readonly string[];
    callerContextId?: string | null;
    candidateStateHash?: string | null;
    candidateBuildKey?: string | null;
    candidateDeclaresMethod?: boolean;
  }) {
    const declaredMethods = [...new Set(input.declaredMethods)].sort();
    const target = `${input.source}:${input.className}:${input.objectKey}`;
    const alternatives = declaredMethods.length > 0 ? declaredMethods.join(", ") : "none";
    const verifiedCandidate = input.candidateDeclaresMethod && input.candidateBuildKey;
    super(
      verifiedCandidate
        ? `RPC method ${input.method} exists in verified context candidate build ` +
            `${input.candidateBuildKey}, but live workspace service ${target} is still active at ` +
            `${input.activeBuildKey ?? "an older build"}. Build verification does not update a ` +
            `live service. Commit the provider edits, push ${input.source} to protected main, ` +
            "wait for publication to finish, then resolve the service again and retry."
        : `Active workspace service build for ${target} does not declare RPC method ` +
            `${input.method}. Declared methods: ${alternatives}. If this method was just added, ` +
            `verify the provider, commit its edits, and push ${input.source} to protected main ` +
            "before resolving the service again; otherwise use a method from the live service docs."
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
      ...(input.activeEffectiveVersion
        ? { activeEffectiveVersion: input.activeEffectiveVersion }
        : {}),
      declaredMethods,
      ...(input.callerContextId ? { callerContextId: input.callerContextId } : {}),
      ...(input.candidateStateHash ? { candidateStateHash: input.candidateStateHash } : {}),
      ...(input.candidateBuildKey ? { candidateBuildKey: input.candidateBuildKey } : {}),
      candidateDeclaresMethod: input.candidateDeclaresMethod === true,
      recovery: {
        kind: verifiedCandidate
          ? "publish-verified-provider-candidate"
          : "inspect-or-publish-provider",
        repoPath: input.source,
        liveRuntimeUpdated: false,
        steps: [
          {
            operation: "vcs.commit",
            when: "provider has uncommitted working edits",
            arguments: { message: "<describe the provider update>" },
          },
          {
            operation: "vcs.push",
            arguments: { repoPaths: [input.source] },
            successStatuses: ["pushed", "up-to-date"],
          },
          {
            operation: "workers.resolveService",
            arguments: [input.serviceName ?? input.source],
          },
          {
            operation: "rpc.call",
            method: input.method,
            instruction: "Retry with the newly resolved target and the original arguments.",
          },
        ],
      },
    };
  }
}
