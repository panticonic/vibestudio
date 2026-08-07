import { RPC_PROGRESS_SEMANTICS } from "./progressSemantics.generated.js";

/** Contract-owned lookup used by generic RPC execution observers. */
export function progressSemanticsForRpcMethod(qualifiedMethod: string) {
  return RPC_PROGRESS_SEMANTICS[qualifiedMethod as keyof typeof RPC_PROGRESS_SEMANTICS];
}

export function externalWaitResource(
  semantics: { resource: { arg: number; kind: string } },
  args: unknown[]
): { kind: string; value: unknown } {
  return {
    kind: semantics.resource.kind,
    value: structuredClone(args[semantics.resource.arg]),
  };
}
