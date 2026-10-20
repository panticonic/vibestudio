import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type { ClientPrincipalGrantResponse } from "@vibestudio/service-schemas/clients";
import type {
  WorkspaceChildClientPrincipalAttestation,
  WorkspaceChildHubPort,
} from "../../workspaceChildHubPort.js";

/**
 * Vets the exact client build `deviceId` runs and returns the facts the hub
 * attests about it (principal id, sealed authority, effective capabilities).
 * Provided by the System workspace's ClientHost; it rejects when the build is
 * not the one the client runs. Absent in every other workspace.
 */
export type ClientPrincipalAttester = (
  deviceId: string,
  expected: { source: string; buildKey: string; executionDigest: string }
) => Promise<WorkspaceChildClientPrincipalAttestation>;

export interface PrincipalGrantDeps {
  getServerId: () => string;
  getServerBootId: () => string;
  attestClientPrincipal?: ClientPrincipalAttester;
  hub?: Pick<WorkspaceChildHubPort, "attestClientPrincipal" | "mintClientCredential">;
}

export interface PrincipalGrantRequest {
  source: string;
  buildKey: string;
  executionDigest: string;
  /** Authenticated device whose client principal is requested. */
  deviceId: string;
  /** Device key the requesting Iroh connection is bound to; absent for loopback callers. */
  remoteDeviceKey?: string;
}

/**
 * Exchange an authenticated device for a hub-attested principal of the exact
 * client build it verified and runs itself, and a reusable credential for it.
 *
 * The hub is the trust root: it accepts the attestation only from the System
 * workspace of the device's user. The credential is bound to the principal's
 * execution digest (a rebuilt client invalidates it) and, over Iroh, to the
 * requesting connection's device key. Any workspace server redeems it.
 */
export async function grantClientPrincipal(
  deps: PrincipalGrantDeps,
  request: PrincipalGrantRequest
): Promise<ClientPrincipalGrantResponse> {
  if (!deps.attestClientPrincipal || !deps.hub) {
    throw new ServiceError(
      "auth",
      "grantClientPrincipal",
      "Client principals are attested only by the System workspace",
      "PRINCIPAL_GRANTS_UNAVAILABLE"
    );
  }
  let attestation: WorkspaceChildClientPrincipalAttestation;
  try {
    attestation = await deps.attestClientPrincipal(request.deviceId, {
      source: request.source,
      buildKey: request.buildKey,
      executionDigest: request.executionDigest,
    });
    await deps.hub.attestClientPrincipal(attestation);
  } catch (error) {
    throw new ServiceError(
      "auth",
      "grantClientPrincipal",
      error instanceof Error ? error.message : String(error),
      "PRINCIPAL_UNAVAILABLE"
    );
  }
  const { token } = await deps.hub.mintClientCredential({
    principalId: attestation.principalId,
    ...(request.remoteDeviceKey ? { deviceKey: request.remoteDeviceKey } : {}),
  });
  return {
    credential: token,
    principalId: attestation.principalId,
    deviceId: request.deviceId,
    serverId: deps.getServerId(),
    serverBootId: deps.getServerBootId(),
  };
}
