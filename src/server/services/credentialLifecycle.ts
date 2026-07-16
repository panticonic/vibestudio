import type { Credential } from "@vibestudio/credential-client/types";
import type { CredentialStore } from "@vibestudio/credential-client/store";
import type { ClientConfigStore } from "@vibestudio/credential-client/clientConfigStore";
import type { OAuthConnectionErrorCode } from "@vibestudio/credential-client/types";
import { isOAuthRefreshRecipeComplete } from "@vibestudio/credential-client/credentialStatus";
import { createSign, randomUUID } from "node:crypto";

export class CredentialLifecycleError extends Error {
  constructor(
    public readonly code: OAuthConnectionErrorCode,
    message: string = code
  ) {
    super(message);
  }
}

export interface CredentialLifecycleDeps {
  credentialStore: Pick<CredentialStore, "saveUrlBound">;
  clientConfigStore: Pick<ClientConfigStore, "loadVersion">;
}

export class CredentialLifecycle {
  constructor(private readonly deps: CredentialLifecycleDeps) {}

  async refreshIfNeeded(
    credential: Credential & { id: string },
    options: { skewMs?: number } = {}
  ): Promise<Credential & { id: string }> {
    const skewMs = options.skewMs ?? 30_000;
    if (typeof credential.expiresAt !== "number" || credential.expiresAt > Date.now() + skewMs) {
      return credential;
    }
    if (!credential.refreshToken || !isOAuthRefreshRecipeComplete(credential.oauthRefresh)) {
      throw new CredentialLifecycleError(
        "client_not_authorized",
        "OAuth credential is expired and has no complete refresh material"
      );
    }
    return this.refreshCredential(credential);
  }

  async refreshCredential(
    credential: Credential & { id: string }
  ): Promise<Credential & { id: string }> {
    const refreshToken = credential.refreshToken;
    const recipe = credential.oauthRefresh;
    if (!refreshToken || !isOAuthRefreshRecipeComplete(recipe)) {
      throw new CredentialLifecycleError("client_not_authorized");
    }

    const config = recipe.clientConfig
      ? await this.deps.clientConfigStore.loadVersion(
          recipe.clientConfig.configId,
          recipe.clientConfig.configVersion
        )
      : null;
    if (recipe.clientConfig && !config) {
      throw new CredentialLifecycleError(
        "client_not_authorized",
        "exact client config version is unavailable"
      );
    }
    if (config) {
      if (
        config.status === "deleted" ||
        (config.status === "disabled" && !config.allowRefreshWhenDisabled)
      ) {
        throw new CredentialLifecycleError(
          "client_config_unavailable",
          "client config is unavailable for refresh"
        );
      }
      if (
        config.fields["clientId"]?.value !== recipe.clientId ||
        canonicalUrl(config.tokenUrl) !== canonicalUrl(recipe.tokenUrl)
      ) {
        throw new CredentialLifecycleError(
          "client_config_unavailable",
          "exact client config no longer matches the refresh recipe"
        );
      }
    }

    const clientId = recipe.clientId;
    const clientSecret = config?.fields["clientSecret"]?.value;
    const privateKeyPem = config?.fields["privateKeyPem"]?.value;
    const tokenAuth = recipe.tokenAuth;
    if (tokenAuth === "private_key_jwt" && !privateKeyPem) {
      throw new CredentialLifecycleError(
        "client_config_unavailable",
        "private_key_jwt config is unavailable for refresh"
      );
    }
    if (
      (tokenAuth === "client_secret_basic" || tokenAuth === "client_secret_post") &&
      !clientSecret
    ) {
      throw new CredentialLifecycleError(
        "client_config_unavailable",
        `${tokenAuth} config is unavailable for refresh`
      );
    }

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", clientId);
    if (tokenAuth === "private_key_jwt" && privateKeyPem) {
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set(
        "client_assertion",
        signJwtAssertion({
          clientId,
          tokenUrl: recipe.tokenUrl,
          privateKeyPem,
          keyId: config?.fields["keyId"]?.value,
          keyAlgorithm: config?.fields["algorithm"]?.value,
        })
      );
    } else if (tokenAuth === "client_secret_basic" && clientSecret) {
      // Sent as an Authorization header below.
    } else if (clientSecret) {
      body.set("client_secret", clientSecret);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (tokenAuth === "client_secret_basic" && clientSecret) {
      headers["authorization"] = basicAuthHeader(clientId, clientSecret);
    }

    const response = await fetch(recipe.tokenUrl, {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw new CredentialLifecycleError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }

    const accessToken = data?.["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new CredentialLifecycleError("invalid_token_response");
    }
    const tokenType = data?.["token_type"];
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new CredentialLifecycleError(
        "invalid_token_response",
        "OAuth refresh did not return bearer token_type"
      );
    }

    const expiresIn = readNumericField(data?.["expires_in"]);
    const nextRefreshToken = data?.["refresh_token"];
    const grantedScopes = readScopeField(data?.["scope"]);
    const updated = {
      ...credential,
      accessToken,
      refreshToken:
        typeof nextRefreshToken === "string" && nextRefreshToken ? nextRefreshToken : refreshToken,
      scopes: grantedScopes ?? credential.scopes,
      metadata: {
        ...(credential.metadata ?? {}),
        oauthTokenUpdatedAt: String(Date.now()),
      },
    } as Credential & { id: string };
    if (typeof expiresIn === "number") {
      updated.expiresAt = Date.now() + expiresIn * 1000;
    } else {
      // The new access token owns its own lifetime. An omitted expires_in means
      // unknown lifetime, never inheritance from the token it replaced.
      delete updated.expiresAt;
    }
    await this.deps.credentialStore.saveUrlBound(updated);
    return updated;
  }
}

function parseJsonObject(
  text: string,
  options: { strict: boolean }
): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    if (options.strict) {
      throw new CredentialLifecycleError(
        "invalid_token_response",
        "OAuth token endpoint returned invalid JSON"
      );
    }
    return null;
  }
}

function readNumericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function readScopeField(value: unknown): string[] | undefined {
  return typeof value === "string" && value.trim() ? value.trim().split(/\s+/) : undefined;
}

function canonicalUrl(value: string): string {
  return new URL(value).toString();
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString("base64")}`;
}

function signJwtAssertion(params: {
  clientId: string;
  tokenUrl: string;
  privateKeyPem: string;
  keyId?: string;
  keyAlgorithm?: string;
}): string {
  const algorithm = params.keyAlgorithm || "RS256";
  if (algorithm !== "RS256") {
    throw new CredentialLifecycleError(
      "unsupported_token_auth_method",
      "Only RS256 JWT client assertions are supported"
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: algorithm,
    typ: "JWT",
    ...(params.keyId ? { kid: params.keyId } : {}),
  };
  const payload = {
    iss: params.clientId,
    sub: params.clientId,
    aud: params.tokenUrl,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: randomUUID(),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(params.privateKeyPem).toString("base64url")}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function formatOAuthTokenExchangeError(
  status: number,
  data: Record<string, unknown> | null,
  text: string
): string {
  const error = typeof data?.["error"] === "string" ? data["error"] : undefined;
  const description =
    typeof data?.["error_description"] === "string" ? data["error_description"] : undefined;
  const suffix = error
    ? `${error}${description ? `: ${description}` : ""}`
    : sanitizeOAuthErrorText(text);
  return `OAuth token exchange failed: ${status}${suffix ? ` ${suffix}` : ""}`;
}

function sanitizeOAuthErrorText(text: string): string {
  return text
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2"
    )
    .replace(/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}
