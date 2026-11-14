import { ServiceAccessError, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { isEvalHostRecord } from "@vibestudio/shared/evalRuntimeIdentity";

/** The kernel acts as the session entity that hosts it. Kernel bookkeeping is code-owned. Evaluated effects cannot use this ingress,
 * even when they run in the same DO: their host-bound admission remains present
 * on every guest RPC. The authenticated runtime and its active kernel image
 * are the control identity. caller.code may intentionally attribute an eval host
 * to its immutable code owner; it is not the resident kernel identity. */
export function requireEvalKernel(
  caller: VerifiedCaller,
  entities: Pick<EntityCache, "resolveActive">,
  service: string,
  method: string
) {
  const entity = entities.resolveActive(caller.runtime.id);
  const mismatch = caller.executionSession
    ? "guest execution admission"
    : caller.website || caller.executionAuthority
      ? "website execution"
      : !entity
        ? "inactive runtime"
        : !isEvalHostRecord(entity)
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
