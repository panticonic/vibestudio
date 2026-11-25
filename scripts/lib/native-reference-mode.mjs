/** Immutable process-owner ceiling for disposable, model-free native targets. */
export function readNativeReferenceOnly(env = process.env) {
  const value = env.VIBESTUDIO_NATIVE_REFERENCE_ONLY;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("VIBESTUDIO_NATIVE_REFERENCE_ONLY must be 1, 0, or absent");
}
