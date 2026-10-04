import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

/** Resolve a verified caller's host-owned execution lifetime, never its storage identity. */
export function authoritySessionIdForCaller(
  caller: VerifiedCaller,
  entities: Pick<EntityCache, "resolve">
): string {
  if (caller.executionSession) return caller.executionSession.authoritySessionId;
  const record = entities.resolve(caller.runtime.id);
  if (record?.authoritySessionId) {
    if (record.status !== "active" || (caller.runtime.kind === "do" && record.kind !== "do"))
      throw new Error(`Runtime ${caller.runtime.id} has no active authority lifetime`);
    return record.authoritySessionId;
  }
  if (caller.runtime.kind === "do")
    throw new Error(`Durable Object ${caller.runtime.id} has no active authority lifetime`);
  return caller.runtime.id;
}
