import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type { ClientPrincipalGrantResponse } from "@vibestudio/service-schemas/clients";
import type { ClientPrincipal } from "../../clients/clientPrincipals.js";

export interface PrincipalGrantDeps {
  getServerId: () => string;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  connectionGrants?: Pick<ConnectionGrantService, "grant">;
  grantClientPrincipal?: (
    deviceId: string,
    expected: { source: string; buildKey: string; executionDigest: string }
  ) => Promise<ClientPrincipal>;
}

export interface PrincipalGrantRequest {
  source: string;
  buildKey: string;
  executionDigest: string;
  /** Authenticated device whose client principal is requested. */
  deviceId: string;
  subject: UserSubject;
  /** Runtime id of the authenticated connection that requested the grant. */
  issuedBy: string;
  /** Endpoint of the requesting Iroh connection; absent for loopback callers. */
  remoteEndpointId?: string;
}

/**
 * Exchange an authenticated device for the principal of the exact client build
 * it verified and runs itself, and mint a one-use connection grant for it.
 *
 * The grant is bound to the requesting transport endpoint, so only a session
 * the same device opens over the same connection path can redeem it, and the
 * principal to the exact build (`buildKey`, `executionDigest`) the host checked.
 */
export async function grantClientPrincipal(
  deps: PrincipalGrantDeps,
  request: PrincipalGrantRequest
): Promise<ClientPrincipalGrantResponse> {
  if (!deps.connectionGrants || !deps.grantClientPrincipal) {
    throw new ServiceError(
      "auth",
      "grantClientPrincipal",
      "Client principals are not configured on this server",
      "PRINCIPAL_GRANTS_UNAVAILABLE"
    );
  }
  let principal: ClientPrincipal;
  try {
    principal = await deps.grantClientPrincipal(request.deviceId, {
      source: request.source,
      buildKey: request.buildKey,
      executionDigest: request.executionDigest,
    });
  } catch (error) {
    throw new ServiceError(
      "auth",
      "grantClientPrincipal",
      error instanceof Error ? error.message : String(error),
      "PRINCIPAL_UNAVAILABLE"
    );
  }
  const granted = deps.connectionGrants.grant(principal.principalId, request.issuedBy, {
    subject: request.subject,
    ...(request.remoteEndpointId ? { remoteEndpointId: request.remoteEndpointId } : {}),
  });
  return {
    connectionGrant: granted.token,
    expiresAt: granted.expiresAt,
    principalId: principal.principalId,
    deviceId: request.deviceId,
    serverId: deps.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}
