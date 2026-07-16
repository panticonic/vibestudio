import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeJwtPayload,
  deriveAccountIdentityFromJwt,
  normalizeAccountIdentity,
  parseBearerTokenResponse,
  readStringClaim,
} from "./tokens.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential token helpers", () => {
  it("normalizes bearer token fields without persisting refresh tokens by default", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(
      parseBearerTokenResponse(
        {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: "60",
          scope: "read write",
        },
        {}
      )
    ).toEqual({ accessToken: "access", expiresAt: 61_000, scopes: ["read", "write"] });
  });

  it("returns refresh material only when the OAuth flow explicitly persists it", () => {
    expect(
      parseBearerTokenResponse(
        {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 60,
        },
        { persistRefreshToken: true }
      )
    ).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
  });

  it("rejects missing required bearer response fields", () => {
    expect(() => parseBearerTokenResponse({}, {})).toThrow(
      expect.objectContaining({ code: "invalid_token_response" })
    );
    expect(() => parseBearerTokenResponse({ access_token: "access" }, {})).toThrow(
      expect.objectContaining({ code: "invalid_token_response" })
    );
  });

  it("decodes nested JWT account claims", () => {
    const token = unsignedJwt({ account: { subject: "provider-user-1" } });
    expect(decodeJwtPayload(token)).toEqual({ account: { subject: "provider-user-1" } });
    expect(
      deriveAccountIdentityFromJwt(token, {
        accountIdentityJwtClaimRoot: "account",
        accountIdentityJwtClaimField: "subject",
      })
    ).toEqual({ providerUserId: "provider-user-1" });
    expect(readStringClaim({ account: { email: "a@example.test" } }, "account.email")).toBe(
      "a@example.test"
    );
  });

  it("uses the caller only when provider identity fields are absent", () => {
    expect(normalizeAccountIdentity({ email: "a@example.test" }, "caller-1")).toEqual({
      providerUserId: "a@example.test",
      email: "a@example.test",
    });
    expect(normalizeAccountIdentity(undefined, "caller-1")).toEqual({
      providerUserId: "caller-1",
    });
  });
});
