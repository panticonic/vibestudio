import { formatOAuthTokenExchangeError } from "./credentialMechanisms/errors.js";
import { refreshModelProviderCredential } from "./credentialMechanisms/modelProvider.js";
import type { Credential, CredentialAgentLineageLink } from "@vibestudio/credential-client/types";
import type { CredentialStore } from "@vibestudio/credential-client/store";
import type { ClientConfigStore } from "@vibestudio/credential-client/clientConfigStore";
import type { OAuthConnectionErrorCode } from "@vibestudio/credential-client/types";
import { isOAuthRefreshRecipeComplete } from "@vibestudio/credential-client/credentialStatus";
import { encodeOAuthTokenRequest } from "./credentialMechanisms/oauth2.js";
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

/** An agent-attributed token obtained through a credential's agent exchange. */
export interface AgentExchangeToken {
  accessToken: string;
  /** Absent when the provider returned no `expires_in` (never cached then). */
  expiresAt?: number;
}

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const AGENT_LINEAGE_TOKEN_TYPE = "urn:vibestudio:params:oauth:token-type:agent-lineage";
const AGENT_EXCHANGE_SKEW_MS = 30_000;

export class CredentialLifecycle {
  private readonly refreshes = new Map<string, Promise<Credential & { id: string }>>();
  /** Exchanged agent tokens by (credential id, leaf agent entity). */
  private readonly agentTokens = new Map<string, AgentExchangeToken>();
  private readonly agentExchanges = new Map<string, Promise<AgentExchangeToken>>();
  constructor(private readonly deps: CredentialLifecycleDeps) {}

  /**
   * RFC 8693 exchange of a human-attributed credential's current access token
   * for a token attributed to the agent entity at the end of `lineage` (root
   * first), acting for that human. The provider gives each entity its own
   * agent principal; whether the user trusts the entity's program version was
   * decided by the host's credential-use grant before this is called. The host performs it; the agent never holds the
   * subject token or the delegation authority. Tokens are reused until 30 s
   * before the provider-declared expiry and never beyond it.
   */
  exchangeForAgent(
    credential: Credential & { id: string },
    lineage: readonly CredentialAgentLineageLink[]
  ): Promise<AgentExchangeToken> {
    const leaf = lineage.at(-1);
    if (!leaf) {
      return Promise.reject(
        new CredentialLifecycleError("invalid_connection_spec", "agent lineage is empty")
      );
    }
    const key = `${credential.id}\u0000${leaf.entity}`;
    const cached = this.agentTokens.get(key);
    if (cached?.expiresAt !== undefined && cached.expiresAt > Date.now() + AGENT_EXCHANGE_SKEW_MS) {
      return Promise.resolve(cached);
    }
    this.agentTokens.delete(key);
    const pending = this.agentExchanges.get(key);
    if (pending) return pending;
    const exchange = this.performAgentExchange(credential, lineage)
      .then((token) => {
        if (token.expiresAt !== undefined) this.agentTokens.set(key, token);
        return token;
      })
      .finally(() => this.agentExchanges.delete(key));
    this.agentExchanges.set(key, exchange);
    return exchange;
  }

  /**
   * Report to the provider that agent entity `entityId` was retired, so it
   * revokes that agent's authority and retires its principal (idempotent; a
   * provider that never saw the entity answers 400 `unknown_entity`, which is
   * success). A credential without `agentExchange.retireUrl` has nothing to
   * report. Spends the owner's access token (refreshed first), so it is only
   * ever called for the entity's own owner's credential. When the provider no
   * longer honours that member's session (the refresh material is missing or
   * rejected) the host can no longer mint agent tokens for it either, so there
   * is nothing to retire and this returns; a transport failure or a rejected
   * retirement throws.
   */
  async retireAgentEntity(
    credential: Credential & { id: string },
    entityId: string
  ): Promise<void> {
    this.forgetAgentToken(credential.id, entityId);
    const exchange = credential.agentExchange;
    if (credential.actor !== "human" || !exchange?.retireUrl) return;
    let subject: Credential & { id: string };
    try {
      subject = await this.refreshIfNeeded(credential);
    } catch (error) {
      if (error instanceof CredentialLifecycleError) return;
      throw error;
    }
    const response = await fetch(exchange.retireUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${subject.accessToken}`,
      },
      body: new URLSearchParams({ client_id: exchange.clientId, entity: entityId }),
    });
    const text = await response.text();
    if (response.ok) return;
    const data = parseJsonObject(text, { strict: false });
    if (data?.["error"] === "unknown_entity") return;
    throw new CredentialLifecycleError(
      "token_exchange_failed",
      `agent retirement failed: ${formatOAuthTokenExchangeError(response.status, data, text)}`
    );
  }

  /** Drop a cached agent token the provider has since rejected. */
  forgetAgentToken(credentialId: string, leafEntity: string): void {
    this.agentTokens.delete(`${credentialId}\u0000${leafEntity}`);
  }

  private async performAgentExchange(
    credential: Credential & { id: string },
    lineage: readonly CredentialAgentLineageLink[]
  ): Promise<AgentExchangeToken> {
    const exchange = credential.agentExchange;
    if (credential.actor !== "human" || !exchange) {
      throw new CredentialLifecycleError(
        "invalid_connection_spec",
        "credential has no agent exchange"
      );
    }
    const subject = await this.refreshIfNeeded(credential);
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(exchange.extraParams ?? {})) body.set(name, value);
    body.set("grant_type", TOKEN_EXCHANGE_GRANT);
    body.set("client_id", exchange.clientId);
    body.set("subject_token", subject.accessToken);
    body.set("subject_token_type", ACCESS_TOKEN_TYPE);
    body.set(
      "actor_token",
      JSON.stringify({
        v: 2,
        chain: lineage.map((link) => ({
          entity: link.entity,
          program: link.program,
          version: link.version,
          ...(link.label ? { label: link.label } : {}),
        })),
      })
    );
    body.set("actor_token_type", AGENT_LINEAGE_TOKEN_TYPE);
    if (exchange.scope) body.set("scope", exchange.scope);

    const response = await fetch(exchange.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
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
        "agent token exchange did not return bearer token_type"
      );
    }
    const expiresIn = readNumericField(data?.["expires_in"]);
    return {
      accessToken,
      ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    };
  }

  async refreshIfNeeded(
    credential: Credential & { id: string },
    options: { skewMs?: number } = {}
  ): Promise<Credential & { id: string }> {
    const skewMs = options.skewMs ?? 30_000;
    if (typeof credential.expiresAt !== "number" || credential.expiresAt > Date.now() + skewMs) {
      return credential;
    }
    if (
      !credential.modelProviderSession &&
      (!credential.refreshToken || !isOAuthRefreshRecipeComplete(credential.oauthRefresh))
    ) {
      throw new CredentialLifecycleError(
        "client_not_authorized",
        "OAuth credential is expired and has no complete refresh material"
      );
    }
    return this.refreshCredential(credential);
  }

  refreshCredential(credential: Credential & { id: string }): Promise<Credential & { id: string }> {
    const pending = this.refreshes.get(credential.id);
    if (pending) return pending;
    const refresh = this.performRefresh(credential).finally(() =>
      this.refreshes.delete(credential.id)
    );
    this.refreshes.set(credential.id, refresh);
    return refresh;
  }

  private async performRefresh(
    credential: Credential & { id: string }
  ): Promise<Credential & { id: string }> {
    if (credential.modelProviderSession) {
      const refreshed = await refreshModelProviderCredential(credential);
      await this.deps.credentialStore.saveUrlBound(refreshed);
      return refreshed;
    }
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
    const encoded = encodeOAuthTokenRequest(body, recipe.tokenRequestEncoding);
    const headers: Record<string, string> = { "content-type": encoded.contentType };
    if (tokenAuth === "client_secret_basic" && clientSecret) {
      headers["authorization"] = basicAuthHeader(clientId, clientSecret);
    }

    const response = await fetch(recipe.tokenUrl, {
      method: "POST",
      headers,
      body: encoded.body,
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
