import type {
  Credential,
  OAuthRefreshRecipe,
  StoredCredentialLifecycle,
  StoredCredentialSummary,
} from "./types.js";

type CredentialLifecycleSource = Pick<
  Credential,
  "expiresAt" | "oauthRefresh" | "refreshToken" | "revokedAt"
>;

const TOKEN_AUTH_METHODS = new Set([
  "none",
  "client_secret_post",
  "client_secret_basic",
  "private_key_jwt",
]);

/** True only when a persisted recipe can actually redeem a refresh token. */
export function isOAuthRefreshRecipeComplete(
  recipe: OAuthRefreshRecipe | undefined
): recipe is OAuthRefreshRecipe {
  if (!recipe || !recipe.clientId || !TOKEN_AUTH_METHODS.has(recipe.tokenAuth)) return false;
  try {
    const tokenUrl = new URL(recipe.tokenUrl);
    if (tokenUrl.protocol !== "https:" && tokenUrl.protocol !== "http:") return false;
  } catch {
    return false;
  }
  if (recipe.clientConfig) {
    if (!recipe.clientConfig.configId || !recipe.clientConfig.configVersion) return false;
  } else if (recipe.tokenAuth !== "none") {
    return false;
  }
  return true;
}

/**
 * Project secret-bearing credential state into the lifecycle facts that are
 * safe for every credential consumer to see.
 */
export function credentialLifecycle(
  credential: CredentialLifecycleSource,
  now = Date.now()
): StoredCredentialLifecycle {
  if (credential.revokedAt !== undefined) {
    return { state: "revoked", canRefresh: false };
  }
  return {
    state:
      credential.expiresAt !== undefined && credential.expiresAt <= now ? "expired" : "active",
    canRefresh:
      Boolean(credential.refreshToken) && isOAuthRefreshRecipeComplete(credential.oauthRefresh),
  };
}

/** A stored credential is usable now or has persisted material to renew itself. */
export function isStoredCredentialUsable(
  credential: Pick<StoredCredentialSummary, "lifecycle">
): boolean {
  return (
    credential.lifecycle.state === "active" ||
    (credential.lifecycle.state === "expired" && credential.lifecycle.canRefresh)
  );
}
