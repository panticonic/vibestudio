import { createHash } from "node:crypto";
import {
  verifiedInitiator,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import {
  BROWSER_ENVIRONMENT_KEY_VERSION,
  browserEnvironmentKeyMaterial,
} from "@vibestudio/browser-data";

export interface BrowserEnvironmentIdentity {
  workspaceId: string;
  ownerUserId: string;
  environmentKey: string;
}

/**
 * Resolve the one browser environment owned by a verified account in a
 * workspace. The subject is host-attested; callers never provide a user id or
 * an object key.
 */
export function browserEnvironmentIdentity(
  workspaceId: string,
  caller: Pick<VerifiedCaller, "subject">
): BrowserEnvironmentIdentity {
  const normalized = browserEnvironmentKeyMaterial(workspaceId, caller.subject?.userId ?? "");
  const digest = createHash("sha256").update(normalized.material).digest("base64url");
  return {
    workspaceId: normalized.workspaceId,
    ownerUserId: normalized.ownerUserId,
    environmentKey: `${BROWSER_ENVIRONMENT_KEY_VERSION}_${digest}`,
  };
}

export function browserEnvironmentIdentityFromContext(
  workspaceId: string,
  ctx: Pick<ServiceContext, "caller" | "authorizingCaller">
): BrowserEnvironmentIdentity {
  return browserEnvironmentIdentity(workspaceId, verifiedInitiator(ctx));
}
