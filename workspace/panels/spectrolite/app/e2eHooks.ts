type SpectroliteE2EHookGlobal = typeof globalThis & {
  __VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS__?: unknown;
  __vibestudioEnv?: Record<string, string>;
  process?: { env?: Record<string, string> };
};

export function spectroliteE2EHooksEnabled(): boolean {
  const env = globalThis as SpectroliteE2EHookGlobal;
  const value =
    env.__VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS__ ??
    env.__vibestudioEnv?.["VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS"] ??
    env.process?.env?.["VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS"];
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
  }
  return value === true;
}
