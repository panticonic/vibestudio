import { describe, expect, it } from "vitest";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import { modelIsConnectable, toCredentialConnectRequest } from "./providerConnect";

describe("model quick-connect eligibility", () => {
  it.each([
    "https://openrouter.ai/api",
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1/messages",
  ])("offers setup for a base overlapping the provider API: %s", (baseUrl) => {
    expect(modelIsConnectable("openrouter", baseUrl)).toBe(true);
  });

  it.each([
    "https://openrouter.ai/api/v10",
    "https://openrouter.ai/account",
    "https://openrouter.ai.evil.test/api",
    "https://other.example/api",
    "http://openrouter.ai/api",
    "https://openrouter.ai:444/api",
    "https://{tenant}.example/api",
    "not a URL",
  ])("does not offer an unrelated preset: %s", (baseUrl) => {
    expect(modelIsConnectable("openrouter", baseUrl)).toBe(false);
  });

  it("keeps actual credential use scoped to the versioned API", () => {
    const request = toCredentialConnectRequest("openrouter")!;
    expect(request.credential.audience).toEqual([
      { url: "https://openrouter.ai/api/v1", match: "path-prefix" },
    ]);
    expect(
      findMatchingUrlAudience("https://openrouter.ai/api", request.credential.audience)
    ).toBeNull();
    expect(
      findMatchingUrlAudience("https://openrouter.ai/api/v1/messages", request.credential.audience)
    ).not.toBeNull();
    expect(modelIsConnectable("unknown-provider", "https://openrouter.ai/api")).toBe(false);
  });
});

describe("Claude connection methods", () => {
  it("defaults to subscription OAuth and records its request authentication method", () => {
    const request = toCredentialConnectRequest("anthropic")!;
    expect(request.flow).toMatchObject({
      type: "oauth2-auth-code-pkce",
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenRequestEncoding: "json",
      extraTokenParams: { state: "{state}" },
      persistRefreshToken: true,
    });
    expect(request.redirect).toEqual({
      type: "loopback",
      host: "localhost",
      port: 53692,
      callbackPath: "/callback",
    });
    expect(request.credential).toMatchObject({
      metadata: { modelProviderId: "anthropic", modelAuthMethod: "subscription" },
      injection: { name: "Authorization", valueTemplate: "Bearer {token}" },
    });
    expect(
      toCredentialConnectRequest("anthropic", { browser: "external" })?.redirect
    ).not.toHaveProperty("type");
  });

  it("retains API-key setup as an explicit choice and rejects unknown methods", () => {
    const request = toCredentialConnectRequest("anthropic", { method: "api-key" })!;
    expect(request.flow.type).toBe("api-key");
    expect(request.credential).toMatchObject({
      metadata: { modelAuthMethod: "api-key" },
      injection: { name: "x-api-key", valueTemplate: "{token}" },
    });
    expect(request.redirect).toBeUndefined();
    expect(toCredentialConnectRequest("anthropic", { method: "unknown" })).toBeNull();
  });
});

it.each(["openai-codex", "anthropic", "github-copilot", "kimi-coding", "meta", "xai"])(
  "offers subscription sign-in for %s",
  (provider) => {
    const request = toCredentialConnectRequest(provider, { method: "subscription" })!;
    expect(request.credential.metadata).toMatchObject({
      modelProviderId: provider,
      modelAuthMethod: "subscription",
    });
    expect(["oauth2-auth-code-pkce", "model-provider-oauth"]).toContain(request.flow.type);
  }
);

it("scopes configurable providers to the account and endpoint supplied by the user", () => {
  expect(() => toCredentialConnectRequest("cloudflare-workers-ai")).toThrow(
    "account ID is required"
  );
  const request = toCredentialConnectRequest("cloudflare-workers-ai", {
    configuration: { CLOUDFLARE_ACCOUNT_ID: "account123" },
  })!;
  expect(request.credential.audience[0]?.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/account123/ai/v1"
  );
  expect(() =>
    toCredentialConnectRequest("cloudflare-workers-ai", {
      configuration: { CLOUDFLARE_ACCOUNT_ID: "../another-account" },
    })
  ).toThrow();
  expect(() =>
    toCredentialConnectRequest("azure", {
      configuration: { ENDPOINT: "http://insecure.example" },
    })
  ).toThrow();
});
