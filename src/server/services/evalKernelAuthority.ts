import { ServiceAccessError, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { isEvalHostRecord } from "@vibestudio/shared/evalRuntimeIdentity";

/** Whether a class declares (in its manifest) that it hosts the eval kernel in its own cell. */
export type HostsEvalKernel = (source: string, className: string) => boolean;

/** An eval host: a session entity, or an entity whose class hosts its own kernel (§6.11.6). */
export function isEvalHost(
  record: { kind?: string; className?: string; source: { repoPath: string } },
  hostsEvalKernel?: HostsEvalKernel
): boolean {
  return (
    isEvalHostRecord(record) ||
    (record.kind === "do" &&
      record.className !== undefined &&
      hostsEvalKernel?.(record.source.repoPath, record.className) === true)
  );
}

/** The kernel acts as the entity that hosts it (a session entity, or an agent that hosts its own). Kernel bookkeeping is code-owned. Evaluated effects cannot use this ingress,
 * even when they run in the same DO: their host-bound admission remains present
 * on every guest RPC. The authenticated runtime and its active kernel image
 * are the control identity. caller.code may intentionally attribute an eval host
 * to its immutable code owner; it is not the resident kernel identity. */
export function requireEvalKernel(
  caller: VerifiedCaller,
  entities: Pick<EntityCache, "resolveActive">,
  service: string,
  method: string,
  hostsEvalKernel?: HostsEvalKernel
) {
  const entity = entities.resolveActive(caller.runtime.id);
  const mismatch = caller.executionSession
    ? "guest execution admission"
    : caller.website || caller.executionAuthority
      ? "website execution"
      : !entity
        ? "inactive runtime"
        : !isEvalHost(entity, hostsEvalKernel)
          ? "non-kernel runtime"
          : !entity.activeExecutionDigest
            ? "missing active image"
            : null;
  if (mismatch || !entity) {
    throw new ServiceAccessError(
      service,
      method,
      `This operation requires the exact sealed eval kernel (${mismatch})`,
      "EACCES"
    );
  }
  return entity;
}
