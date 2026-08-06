export const RUNTIME_IMAGE_WARMING_ERROR_CODE = "RUNTIME_IMAGE_WARMING" as const;
export const RUNTIME_IMAGE_UNAVAILABLE_ERROR_CODE = "RUNTIME_IMAGE_UNAVAILABLE" as const;

function structuredErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; errorCode?: unknown };
  return candidate.code ?? candidate.errorCode;
}

/**
 * A sealed execution mismatch cannot be repaired by retrying the same host
 * generation. The retained artifact must be restored, the entity advanced, or
 * the host restarted after its execution provider is repaired.
 */
export function isPermanentRuntimeReadinessError(error: unknown): boolean {
  return structuredErrorCode(error) === RUNTIME_IMAGE_UNAVAILABLE_ERROR_CODE;
}
