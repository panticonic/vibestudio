import { createHash } from "node:crypto";

/**
 * The entity that hosts an eval kernel is a session entity (docs/dolt-redesign.md
 * §7.2): a `SessionDO` of the Base template, keyed by its principal and scope. The
 * kernel (a hosted class) acts as that entity, so this is the runtime id of every
 * eval run's executor.
 */
export const EVAL_HOST_SOURCE = "workers/session";
/** The class of dynamic code an eval host hosts: a session entity, or any entity whose manifest `hosts` it. */
export const EVAL_KERNEL_SOURCE = "workers/eval-kernel";
export const EVAL_KERNEL_CLASS = "EvalKernel";
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

/**
 * Whether a manifest's `hosts` entries name the eval kernel: the class hosts its own kernel
 * (docs/dolt-redesign.md §6.11.6). Such an entity is an eval host itself: the kernel acts as it, so
 * its runtime id is the executor of its runs and no session entity stands between them.
 */
export function declaresEvalKernel(
  hosts: ReadonlyArray<{ source: string; className: string }> | undefined
): boolean {
  return (
    hosts?.some(
      (entry) => entry.source === EVAL_KERNEL_SOURCE && entry.className === EVAL_KERNEL_CLASS
    ) === true
  );
}

/** The call coordinate of the entity a record describes. */
export function entityHostRef(record: {
  className?: string;
  key?: string;
  source: { repoPath: string };
}): { source: string; className: string; objectKey: string } | null {
  return record.className && record.key
    ? { source: record.source.repoPath, className: record.className, objectKey: record.key }
    : null;
}

/**
 * The entity of the retired product `EvalDO` that kept this owner's notebook for
 * this scope before the kernel became hosted code (docs/dolt-redesign.md §7.10, D5).
 * Same object key as the session entity; only the class and source differ. Its
 * state was dropped by the upgrade, and a run of the scope tells the user once.
 */
export function legacyEvalDoRuntimeId(ownerId: string, scopeKey: string): string {
  return `do:vibestudio/internal:EvalDO:${evalHostObjectKey(ownerId, scopeKey)}`;
}
