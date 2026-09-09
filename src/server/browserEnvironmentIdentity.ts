import { createHash } from "node:crypto";
import {
  verifiedInitiatingUserId,
  type ServiceContext,
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
 * workspace. The account is host-attested; callers never provide a user id or
 * an object key.
 */
export function browserEnvironmentIdentity(
  workspaceId: string,
  ownerUserId: string | undefined
): BrowserEnvironmentIdentity {
  const normalized = browserEnvironmentKeyMaterial(workspaceId, ownerUserId ?? "");
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
  // A browser environment belongs to an account, so it is resolved from the
  // account behind the operation — not from whichever principal authorized it,
  // which may be workspace infrastructure that owns no browser data.
  return browserEnvironmentIdentity(workspaceId, verifiedInitiatingUserId(ctx));
}
