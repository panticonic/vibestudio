import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";

/**
 * A workerd Durable Object service has one bearer for its reviewed source/class
 * service, while every object presents its concrete runtime id in a separate
 * authenticated header. Keep that projection identical at every HTTP boundary
 * (direct RPC admission and the egress proxy's loopback-RPC fast path).
 */
export function isRuntimeIdForServiceToken(
  authenticatedCallerId: string,
  runtimeId: string | undefined
): boolean {
  if (!runtimeId || !authenticatedCallerId.startsWith("do-service:")) return false;
  const serviceTargetPrefix = `do:${authenticatedCallerId.slice("do-service:".length)}:`;
  return runtimeId.length > serviceTargetPrefix.length && runtimeId.startsWith(serviceTargetPrefix);
}

export function resolveHttpRuntimeCaller(
  authenticatedCallerId: string,
  _callerKind: CallerKind,
  runtimeIdHeader: string | string[] | undefined
): string {
  const runtimeId = Array.isArray(runtimeIdHeader) ? runtimeIdHeader[0] : runtimeIdHeader;
  if (runtimeId == null || runtimeId === "") return authenticatedCallerId;
  if (typeof runtimeId !== "string") {
    throw new Error("Invalid RPC runtime identity");
  }
  if (runtimeId === authenticatedCallerId) return authenticatedCallerId;
  if (isRuntimeIdForServiceToken(authenticatedCallerId, runtimeId)) return runtimeId;
  throw new Error(
    `RPC runtime identity denied: ${authenticatedCallerId} cannot act as ${runtimeId}`
  );
}
