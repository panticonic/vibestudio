import { createHash } from "node:crypto";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

export interface BrowserEnvironmentIdentity {
  workspaceId: string;
  ownerUserId: string;
  environmentKey: string;
}

const ENVIRONMENT_KEY_VERSION = "v1";

/**
 * Resolve the one browser environment owned by a verified account in a
 * workspace. The subject is host-attested; callers never provide a user id or
 * an object key.
 */
export function browserEnvironmentIdentity(
  workspaceId: string,
  caller: Pick<VerifiedCaller, "subject">
): BrowserEnvironmentIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error("Browser environment resolution requires a workspace id");
  }
  const ownerUserId = caller.subject?.userId.trim();
  if (!ownerUserId || ownerUserId === "system") {
    throw new Error("Browser environment resolution requires a verified user");
  }
  const digest = createHash("sha256")
    .update(`${ENVIRONMENT_KEY_VERSION}\x00${normalizedWorkspaceId}\x00${ownerUserId}`)
    .digest("base64url");
  return {
    workspaceId: normalizedWorkspaceId,
    ownerUserId,
    environmentKey: `${ENVIRONMENT_KEY_VERSION}_${digest}`,
  };
}

export function browserEnvironmentIdentityFromContext(
  workspaceId: string,
  ctx: Pick<ServiceContext, "caller">
): BrowserEnvironmentIdentity {
  return browserEnvironmentIdentity(workspaceId, ctx.caller);
}

export function isBrowserDataDurableObject(source: string, className: string): boolean {
  return source === "vibestudio/internal" && className === "BrowserDataDO";
}
