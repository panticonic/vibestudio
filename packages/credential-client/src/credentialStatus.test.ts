import { describe, expect, it } from "vitest";
import { credentialLifecycle, isStoredCredentialUsable } from "./credentialStatus.js";

const NOW = 2_000;
const PUBLIC_REFRESH_RECIPE = {
  tokenUrl: "https://auth.example.test/oauth/token",
  clientId: "public-client",
  tokenAuth: "none" as const,
};

describe("credential lifecycle", () => {
  it("projects active, renewable, expired, and revoked credentials without exposing material", () => {
    expect(credentialLifecycle({ expiresAt: NOW + 1 }, NOW)).toEqual({
      state: "active",
      canRefresh: false,
    });
    expect(
      credentialLifecycle(
        {
          expiresAt: NOW - 1,
          refreshToken: "secret",
          oauthRefresh: PUBLIC_REFRESH_RECIPE,
        },
        NOW
      )
    ).toEqual({ state: "expired", canRefresh: true });
    expect(credentialLifecycle({ expiresAt: NOW - 1 }, NOW)).toEqual({
      state: "expired",
      canRefresh: false,
    });
    expect(
      credentialLifecycle({ revokedAt: NOW - 1, refreshToken: "secret" }, NOW)
    ).toEqual({ state: "revoked", canRefresh: false });
  });

  it("requires an exact refresh recipe instead of trusting token presence", () => {
    expect(credentialLifecycle({ refreshToken: "secret" }, NOW).canRefresh).toBe(false);
    expect(
      credentialLifecycle({
        refreshToken: "secret",
        oauthRefresh: {
          tokenUrl: PUBLIC_REFRESH_RECIPE.tokenUrl,
          clientId: "confidential-client",
          tokenAuth: "client_secret_post",
        },
      }).canRefresh
    ).toBe(false);
    expect(
      credentialLifecycle({
        refreshToken: "secret",
        oauthRefresh: {
          tokenUrl: PUBLIC_REFRESH_RECIPE.tokenUrl,
          clientId: "confidential-client",
          tokenAuth: "client_secret_post",
          clientConfig: { configId: "provider", configVersion: "version-1" },
        },
      }).canRefresh
    ).toBe(true);
  });

  it("only considers active or renewable credentials usable", () => {
    expect(isStoredCredentialUsable({ lifecycle: { state: "active", canRefresh: false } })).toBe(
      true
    );
    expect(isStoredCredentialUsable({ lifecycle: { state: "expired", canRefresh: true } })).toBe(
      true
    );
    expect(isStoredCredentialUsable({ lifecycle: { state: "expired", canRefresh: false } })).toBe(
      false
    );
    expect(isStoredCredentialUsable({ lifecycle: { state: "revoked", canRefresh: false } })).toBe(
      false
    );
  });
});
