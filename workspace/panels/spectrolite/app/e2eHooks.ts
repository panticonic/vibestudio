type SpectroliteE2EHookGlobal = typeof globalThis & {
  __VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS__?: unknown;
};

export function spectroliteE2EHooksEnabled(): boolean {
  return (globalThis as SpectroliteE2EHookGlobal).__VIBESTUDIO_ENABLE_SPECTROLITE_E2E_HOOKS__ === true;
}
