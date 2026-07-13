import type { AccountIdentity } from "@vibestudio/credential-client/types";
import { oauthConnectionError } from "./errors.js";

export interface BearerTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

export function normalizeAccountIdentity(
  input: Partial<AccountIdentity> | undefined,
  callerId: string
): AccountIdentity {
  return {
    providerUserId: input?.providerUserId ?? input?.email ?? input?.username ?? callerId,
    ...(input?.email ? { email: input.email } : {}),
    ...(input?.username ? { username: input.username } : {}),
    ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
  };
}

export function parseBearerTokenResponse(
  tokenData: Record<string, unknown> | null,
  options: { allowMissingExpiry?: boolean; persistRefreshToken?: boolean }
): BearerTokenResult {
  const accessToken = tokenData?.["access_token"];
  const tokenType = tokenData?.["token_type"];
  if (typeof accessToken !== "string") {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return an access_token"
    );
  }
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return bearer token_type"
    );
  }
  const expiresIn = readNumericField(tokenData?.["expires_in"]);
  if (expiresIn === undefined && !options.allowMissingExpiry) {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return expires_in"
    );
  }
  const refreshToken = tokenData?.["refresh_token"];
  const scope = tokenData?.["scope"];
  return {
    accessToken,
    ...(options.persistRefreshToken && typeof refreshToken === "string" && refreshToken.length > 0
      ? { refreshToken }
      : {}),
    ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof scope === "string" && scope.trim() ? { scopes: scope.trim().split(/\s+/) } : {}),
  };
}

export function deriveAccountIdentityFromJwt(
  accessToken: string,
  metadata: Readonly<Record<string, string>> | undefined
): Partial<AccountIdentity> {
  const root = metadata?.["accountIdentityJwtClaimRoot"];
  const field = metadata?.["accountIdentityJwtClaimField"];
  if (!field) return {};
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};
  const container = root ? payload[root] : payload;
  if (!container || typeof container !== "object") return {};
  const providerUserId = (container as Record<string, unknown>)[field];
  return typeof providerUserId === "string" && providerUserId.length > 0 ? { providerUserId } : {};
}

export function readStringClaim(
  data: Readonly<Record<string, unknown>>,
  path: string | undefined
): string | undefined {
  if (!path) return undefined;
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const payload: unknown = JSON.parse(decoded);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readNumericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
