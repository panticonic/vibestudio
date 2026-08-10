import { createHash } from "node:crypto";

const INTERNAL_EVAL_DO_PREFIX = "do:vibestudio/internal:EvalDO:";

/** Canonical owner/scope identity shared by the eval service and its clients. */
export function evalRuntimeId(ownerId: string, scopeKey: string): string {
  const objectKey = createHash("sha256")
    .update(ownerId + "\0" + scopeKey)
    .digest("hex")
    .slice(0, 40);
  return `${INTERNAL_EVAL_DO_PREFIX}${objectKey}`;
}
