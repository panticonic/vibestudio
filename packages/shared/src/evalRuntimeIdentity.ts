import { createHash } from "node:crypto";

/**
 * The entity that hosts an eval kernel is a session entity (docs/dolt-redesign.md
 * §7.2): a `SessionDO` of the Base template, keyed by its principal and scope. The
 * kernel (a hosted class) acts as that entity, so this is the runtime id of every
 * eval run's executor.
 */
export const EVAL_HOST_SOURCE = "workers/session";
export const EVAL_HOST_CLASS = "SessionDO";
const EVAL_HOST_PREFIX = `do:${EVAL_HOST_SOURCE}:${EVAL_HOST_CLASS}:`;

/** Canonical owner/scope identity shared by the eval service and its clients. */
export function evalRuntimeId(ownerId: string, scopeKey: string): string {
  return `${EVAL_HOST_PREFIX}${evalHostObjectKey(ownerId, scopeKey)}`;
}

/** The object key of the session entity for one owner and scope. */
export function evalHostObjectKey(ownerId: string, scopeKey: string): string {
  return createHash("sha256")
    .update(ownerId + "\0" + scopeKey)
    .digest("hex")
    .slice(0, 40);
}

/** Whether a runtime id names an eval host (a session entity). */
export function isEvalHostRuntimeId(runtimeId: string): boolean {
  return runtimeId.startsWith(EVAL_HOST_PREFIX);
}

/** The object key of an eval host's runtime id. */
export function evalHostObjectKeyOf(runtimeId: string): string | null {
  return isEvalHostRuntimeId(runtimeId) ? runtimeId.slice(EVAL_HOST_PREFIX.length) : null;
}

/** Whether an entity record is an eval host. */
export function isEvalHostRecord(record: {
  kind?: string;
  className?: string;
  source: { repoPath: string };
}): boolean {
  return (
    record.kind === "do" &&
    record.className === EVAL_HOST_CLASS &&
    record.source.repoPath === EVAL_HOST_SOURCE
  );
}
