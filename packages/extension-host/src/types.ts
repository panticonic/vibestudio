import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { CodeIdentityCallerKind } from "@vibestudio/shared/principalKinds";
import type { CapabilityScope } from "@vibestudio/rpc";
import type { EvalAuthorityDelegation } from "@vibestudio/shared/authorityManifest";
import type { ExtensionInvocation, ExtensionSource, RegistryEntry } from "@vibestudio/extension";

export type { ExtensionInvocation, ExtensionSource, RegistryEntry };

export interface ExtensionHealth {
  state: "healthy" | "degraded" | "unhealthy";
  summary: string;
  reasons?: string[];
  reportedAt: number;
  retryAt?: number;
}

export interface ExtensionProcessState {
  name: string;
  version: string;
  bundlePath: string;
  /** Exact ABI-keyed dependency layer for native/external packages. */
  runtimeNodeModulesDir?: string;
  storageDir: string;
  gatewayUrl: string;
  rpcToken: string;
}

export interface ExtensionUserlandCaller {
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  repoPath: string;
  executionDigest: string;
  requested: readonly CapabilityScope[];
  delegations: readonly EvalAuthorityDelegation[];
  contextId?: string;
}

export function invocationFromServiceContext(
  ctx: ServiceContext,
  extensionName: string,
  method: string,
  requestId: string,
  resolveContextId?: (callerId: string) => string | null
): ExtensionInvocation {
  const directContextId = resolveContextId?.(ctx.caller.runtime.id) ?? null;
  const callerKind = ctx.caller.runtime.kind;
  const invocation: ExtensionInvocation = {
    requestId,
    extensionName,
    method,
    caller: {
      callerId: ctx.caller.runtime.id,
      callerKind,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
      ...(directContextId ? { contextId: directContextId } : {}),
    },
  };
  if (
    ctx.caller.runtime.kind === "panel" ||
    ctx.caller.runtime.kind === "app" ||
    ctx.caller.runtime.kind === "worker" ||
    ctx.caller.runtime.kind === "do"
  ) {
    const identity = ctx.caller.code;
    if (identity && identity.callerKind === ctx.caller.runtime.kind) {
      const chainContextId = resolveContextId?.(identity.callerId) ?? null;
      (invocation as ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller }).chainCaller =
        {
          callerId: identity.callerId,
          callerKind: identity.callerKind,
          repoPath: identity.repoPath,
          executionDigest: identity.executionDigest,
          requested: identity.requested,
          delegations: identity.delegations,
          ...(chainContextId ? { contextId: chainContextId } : {}),
        };
    }
  } else if (ctx.caller.runtime.kind === "extension" && ctx.chainCaller) {
    const contextId = resolveContextId?.(ctx.chainCaller.callerId) ?? null;
    invocation.chainCaller = {
      ...ctx.chainCaller,
      ...(contextId ? { contextId } : {}),
    };
  }
  return invocation;
}
