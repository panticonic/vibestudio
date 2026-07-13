import { describe, expect, it } from "vitest";
import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { toCredentialConnectRequest as toSharedCredentialConnectRequest } from "@vibestudio/shared/providerConnect";

import { toCredentialConnectRequest } from "./providerConnect";

describe("provider connect presets", () => {
  it("builds a schema-valid OpenAI Codex external-browser credential request", () => {
    const request = toCredentialConnectRequest(
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      { browser: "external" }
    );

    expect(request).toMatchObject({
      flow: { type: "oauth2-auth-code-pkce" },
      credential: {
        label: "ChatGPT Codex model credential",
        audience: [{ url: "https://chatgpt.com/backend-api/codex", match: "path-prefix" }],
        metadata: {
          modelProviderId: "openai-codex",
          accountIdentityJwtClaimRoot: "https://api.openai.com/auth",
          accountIdentityJwtClaimField: "chatgpt_account_id",
        },
      },
      redirect: {
        type: "client-loopback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      browser: "external",
    });
    expect(() => ConnectCredentialParamsSchema.parse(request)).not.toThrow();
  });

  it("uses the in-process loopback redirect for internal OAuth", () => {
    const request = toCredentialConnectRequest(
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      { browser: "internal" }
    );

    expect(request?.redirect).toMatchObject({
      type: "loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    });
    expect(request?.browser).toBe("internal");
  });

  it("exports the presets from the shared package path", () => {
    expect(
      toSharedCredentialConnectRequest("openai", "https://api.openai.com/v1")?.credential.label
    ).toBe("OpenAI API key");
  });
});
