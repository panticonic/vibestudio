import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceAppTarget } from "@vibestudio/shared/unitManifest";
import type { UserSubject } from "@vibestudio/identity/types";
import type {
  AppPrincipalGrantResponse,
  AppPrincipalTarget,
} from "@vibestudio/service-schemas/auth";
import type { DeviceAppPrincipal } from "../../deviceAppPrincipals.js";

export type PrincipalGrantTarget = AppPrincipalTarget;

const APP_TARGET_FOR_PRINCIPAL: Record<PrincipalGrantTarget, WorkspaceAppTarget> = {
  "react-native-app": "react-native",
  "terminal-app": "terminal",
};

const UNAVAILABLE_REASON: Record<PrincipalGrantTarget, string> = {
  "react-native-app": "No active React Native workspace app principal is available",
  "terminal-app":
    "The workspace terminal app is not running; start it through its launch gate " +
    "(`vibestudio terminal` does this) before requesting its principal",
};

export interface PrincipalGrantDeps {
  getServerId: () => string;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  connectionGrants?: Pick<ConnectionGrantService, "grant">;
  /** Mobile clients may pair before the native app has been prepared. */
  ensureMobileAppReady?: (source?: string | null) => Promise<{
    ready: boolean;
    reason?: string;
    details?: string[];
  }>;
  registerDevicePrincipal?: (
    target: WorkspaceAppTarget,
    deviceId: string,
    source: string | null
  ) => Promise<DeviceAppPrincipal | null>;
}

export interface PrincipalGrantRequest {
  principal: PrincipalGrantTarget;
  source: string | null;
  /** Authenticated device whose app principal is requested. */
  deviceId: string;
  subject: UserSubject;
  /** Runtime id of the authenticated connection that requested the grant. */
  issuedBy: string;
  /** Endpoint of the requesting Iroh connection; absent for loopback callers. */
  remoteEndpointId?: string;
}

function unavailable(message: string, code = "PRINCIPAL_UNAVAILABLE"): ServiceError {
  return new ServiceError("auth", "grantAppPrincipal", message, code);
}

/**
 * Exchange an authenticated device for the device-scoped principal of an app
 * that device runs itself, and mint a one-use connection grant for it.
 *
 * The grant is bound to the requesting transport endpoint, so only a session
 * the same device opens over the same connection path can redeem it, and to
 * the exact app incarnation the principal was activated from.
 */
export async function grantAppPrincipal(
  deps: PrincipalGrantDeps,
  request: PrincipalGrantRequest
): Promise<AppPrincipalGrantResponse> {
  if (!deps.connectionGrants || !deps.registerDevicePrincipal) {
    throw unavailable(
      "Device-scoped app principals are not configured",
      "PRINCIPAL_GRANTS_UNAVAILABLE"
    );
  }
  if (request.principal === "react-native-app") {
    const readiness = await deps.ensureMobileAppReady?.(request.source);
    if (readiness && !readiness.ready) {
      throw unavailable(
        [
          readiness.reason ?? UNAVAILABLE_REASON["react-native-app"],
          ...(readiness.details?.length ? readiness.details : []),
        ].join(": ")
      );
    }
  }
  const principal = await deps.registerDevicePrincipal(
    APP_TARGET_FOR_PRINCIPAL[request.principal],
    request.deviceId,
    request.source
  );
  if (!principal) throw unavailable(UNAVAILABLE_REASON[request.principal]);
  const granted = deps.connectionGrants.grant(principal.principalId, request.issuedBy, {
    subject: request.subject,
    ...(request.remoteEndpointId ? { remoteEndpointId: request.remoteEndpointId } : {}),
  });
  return {
    connectionGrant: granted.token,
    expiresAt: granted.expiresAt,
    callerId: principal.principalId,
    deviceId: request.deviceId,
    serverId: deps.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
    app: {
      appId: principal.appId,
      source: principal.source,
      buildKey: principal.buildKey,
      effectiveVersion: principal.effectiveVersion,
      artifacts: principal.artifacts,
    },
  };
}
