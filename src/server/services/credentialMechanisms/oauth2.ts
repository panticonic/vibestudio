import { createSign, randomUUID } from "node:crypto";
import { OAuthConnectionError } from "./errors.js";

export interface OAuthClientAssertionParams {
  tokenUrl: string;
  clientId: string;
  privateKeyPem?: string;
  keyId?: string;
  keyAlgorithm?: string;
  tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
}

export interface JwtAssertionParams {
  issuer: string;
  subject: string;
  audience: string;
  privateKeyPem: string;
  keyId?: string;
  keyAlgorithm?: string;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString("base64")}`;
}

export function applyOAuthClientAssertion(
  body: URLSearchParams,
  params: OAuthClientAssertionParams
): void {
  if (params.tokenAuth !== "private_key_jwt") return;
  if (!params.privateKeyPem) {
    throw new OAuthConnectionError(
      "client_config_unavailable",
      "private_key_jwt requires a configured private key"
    );
  }
  body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  body.set(
    "client_assertion",
    signJwtAssertion({
      issuer: params.clientId,
      subject: params.clientId,
      audience: params.tokenUrl,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
    })
  );
}

export function signJwtAssertion(params: JwtAssertionParams): string {
  const algorithm = params.keyAlgorithm || "RS256";
  if (algorithm !== "RS256") {
    throw new OAuthConnectionError(
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
    iss: params.issuer,
    sub: params.subject,
    aud: params.audience,
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

export function base64UrlJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
