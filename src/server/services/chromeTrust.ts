import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { UserRole } from "@vibestudio/identity/types";

export interface CapabilityTrustDeps {
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  hasPlatformCapability?: (caller: VerifiedCaller, capability: AppCapability) => boolean;
  /**
   * Live role lookup from the shared identity DB (WP9 §3) — resolves the
   * CURRENT role of `subject.userId` (never a value snapshotted onto the
   * connection), so a promotion/demotion takes effect immediately. Backs
   * `capabilityAuthorizer.isRootOrAdmin`, the gate for host-administrative ops
   * (invite/revoke user, workspace create/delete). Wired from the hub-owned
   * `UserStore.getUser(id)?.role`; undefined where no identity store is in
   * reach, in which case the role gate denies (no role can be affirmed). NEVER
   * consulted in capability-grant matching, which stays code-identity-scoped.
   */
  roleOf?: (userId: string) => UserRole | null | undefined;
}

/**
 * Genuinely-platform capabilities granted by concrete platform principal.
 *
 * `panel-hosting` is the only platform capability. Account/device management is
 * exposed exclusively by the typed hub control plane and its live role gates.
 */
const PLATFORM_HOST_CAPABILITIES = ["panel-hosting"] as const;

const PLATFORM_PRINCIPAL_CAPABILITIES: Readonly<Record<string, readonly AppCapability[]>> = {
  shell: PLATFORM_HOST_CAPABILITIES,
  server: PLATFORM_HOST_CAPABILITIES,
  "electron-main": PLATFORM_HOST_CAPABILITIES,
  "headless-host": PLATFORM_HOST_CAPABILITIES,
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
  if (kind === "shell" && id.startsWith("shell:")) return PLATFORM_HOST_CAPABILITIES;
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
