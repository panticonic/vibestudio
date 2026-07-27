import type { ExecutionSourceContentRoot } from "@vibestudio/shared/execution/retention";

export type { ExecutionSourceContentRoot } from "@vibestudio/shared/execution/retention";

const STATE_HASH = /^state:[0-9a-f]{64}$/;

/** Validate and type the source closure recorded in immutable build metadata. */
export function executionSourceContentRoot(input: {
  repoPath: string | null;
  stateHash: string | null;
}): ExecutionSourceContentRoot {
  const stateHash = input.stateHash;
  if (typeof stateHash !== "string" || !STATE_HASH.test(stateHash)) {
    throw new Error(
      `execution source root is not a canonical workspace state hash: ${String(input.stateHash)}`
    );
  }
  if (input.repoPath !== null && typeof input.repoPath !== "string") {
    throw new Error("execution source root has an invalid repository path");
  }
  return { repoPath: input.repoPath, stateHash };
}

/** Runtime validation at the content-GC boundary, including externally supplied roots. */
export function assertExecutionSourceContentRoot(
  root: ExecutionSourceContentRoot
): ExecutionSourceContentRoot {
  return executionSourceContentRoot(root);
}
