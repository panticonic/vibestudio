import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";

export interface CapabilityTrustDeps {
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  hasPlatformCapability?: (caller: VerifiedCaller, capability: AppCapability) => boolean;
}

const TRUSTED_PLATFORM_CAPABILITIES = ["panel-hosting", "connection-management"] as const;
const PANEL_HOST_CAPABILITIES = ["panel-hosting"] as const;

const PLATFORM_PRINCIPAL_CAPABILITIES: Readonly<Record<string, readonly AppCapability[]>> = {
  shell: TRUSTED_PLATFORM_CAPABILITIES,
  server: TRUSTED_PLATFORM_CAPABILITIES,
  "electron-main": TRUSTED_PLATFORM_CAPABILITIES,
  "headless-host": PANEL_HOST_CAPABILITIES,
};

function platformCapabilitiesForCaller(caller: VerifiedCaller): readonly AppCapability[] | null {
  const { id, kind } = caller.runtime;
  const exact = PLATFORM_PRINCIPAL_CAPABILITIES[id];
  if (exact) {
    if (id === "server" && kind !== "server") return null;
    if ((id === "shell" || id === "electron-main" || id === "headless-host") && kind !== "shell") {
      return null;
    }
    return exact;
  }

  // Device-scoped shell principals are issued by pairing/device auth as
  // concrete ids like shell:<deviceId>. This keeps trust keyed on the principal
  // namespace rather than on every caller with kind:"shell".
  if (kind === "shell" && id.startsWith("shell:")) return TRUSTED_PLATFORM_CAPABILITIES;
  return null;
}

export function callerHasPlatformCapability(
  caller: VerifiedCaller,
  capability: AppCapability,
  deps: Pick<CapabilityTrustDeps, "hasPlatformCapability"> = {}
): boolean {
  if (deps.hasPlatformCapability?.(caller, capability)) return true;
  return platformCapabilitiesForCaller(caller)?.includes(capability) === true;
}

export function callerHasAppCapability(
  caller: VerifiedCaller,
  capability: AppCapability,
  deps: Pick<CapabilityTrustDeps, "hasAppCapability">
): boolean {
  return (
    caller.runtime.kind === "app" && deps.hasAppCapability?.(caller.runtime.id, capability) === true
  );
}

export function callerHasCapability(
  caller: VerifiedCaller,
  capability: AppCapability,
  deps: CapabilityTrustDeps = {}
): boolean {
  return (
    callerHasAppCapability(caller, capability, deps) ||
    callerHasPlatformCapability(caller, capability, deps)
  );
}

export function isAuthorizedChrome(
  caller: VerifiedCaller,
  deps: CapabilityTrustDeps = {}
): boolean {
  return callerHasCapability(caller, "panel-hosting", deps);
}
