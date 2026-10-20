import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  DEVICE_LEVEL_CAPABILITIES,
  type ClientCapability,
} from "@vibestudio/workspace-contracts/clients";
import type { UserRole } from "@vibestudio/identity/types";
import type { IdentityDb } from "@vibestudio/identity/identityDb";

export interface CapabilityTrustDeps {
  /** Whether the live client principal `callerId` holds `capability` (see `hasClientCapability`). */
  hasClientCapability?: (callerId: string, capability: ClientCapability) => boolean;
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
 * Hosts are trusted native code (§4.1): their own sessions hold every
 * device-level capability. That is the device shell session `shell:<deviceId>`
 * a paired host opens, the local desktop host's loopback principal
 * `electron-main`, the server itself, and the headless renderer.
 */
function isHostPrincipal(caller: Pick<VerifiedCaller, "runtime">): boolean {
  const { id, kind } = caller.runtime;
  if (id === "server") return kind === "server";
  if (kind !== "shell") return false;
  return id === "electron-main" || id === "headless-host" || id.startsWith("shell:");
}

/**
 * Whether the hub-attested client principal `callerId` holds `capability`.
 * Read live from identity.db on every call: an unattested or revoked principal
 * holds nothing, whichever workspace asks.
 */
export function hasClientCapability(
  identity: Pick<IdentityDb, "getClientPrincipal">,
  callerId: string,
  capability: ClientCapability
): boolean {
  const principal = identity.getClientPrincipal(callerId);
  return (
    !!principal && principal.revokedAt === undefined && principal.capabilities.includes(capability)
  );
}

export function callerHasClientCapability(
  caller: Pick<VerifiedCaller, "runtime">,
  capability: ClientCapability,
  deps: Pick<CapabilityTrustDeps, "hasClientCapability">
): boolean {
  return (
    caller.runtime.kind === "client" &&
    deps.hasClientCapability?.(caller.runtime.id, capability) === true
  );
}

export function callerHasCapability(
  caller: Pick<VerifiedCaller, "runtime">,
  capability: ClientCapability,
  deps: CapabilityTrustDeps = {}
): boolean {
  if (callerHasClientCapability(caller, capability, deps)) return true;
  return isHostPrincipal(caller) && DEVICE_LEVEL_CAPABILITIES.includes(capability);
}

/**
 * A host, or a client trusted to act as this device (`device-session`, which
 * only clients in `trust.clients` receive). This is the code that may drive
 * account-level surfaces on the person's behalf.
 */
export function isTrustedDeviceCaller(
  caller: Pick<VerifiedCaller, "runtime">,
  deps: CapabilityTrustDeps = {}
): boolean {
  return callerHasCapability(caller, "device-session", deps);
}

/**
 * A trusted client with a person in front of it.
 *
 * Publications from trusted first-party UI — setup, settings, layout — record
 * admission silently, because the click IS the consent and gating would confirm
 * a dialog the person just confirmed
 * (docs/template-install-unit-approval-ux-plan.md §5.2). A publication that
 * changes which client holds a device-level capability is never silent
 * (docs/client-hosts-and-clients-plan.md §4.4.1); that narrowing is applied by
 * the main-advance gate, not here.
 *
 * `server` and the headless renderer also hold device-level capabilities, but
 * they have no person and no click, so their publications take the ordinary
 * gate. A desktop or device host session is a host acting on the person's
 * direct input (the launch gate), so it counts.
 */
export function isInteractiveClient(
  caller: Pick<VerifiedCaller, "runtime">,
  deps: CapabilityTrustDeps = {}
): boolean {
  if (callerHasClientCapability(caller, "device-session", deps)) return true;
  const { id, kind } = caller.runtime;
  return kind === "shell" && (id === "electron-main" || id.startsWith("shell:"));
}
