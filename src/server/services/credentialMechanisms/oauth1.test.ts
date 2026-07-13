import { describe, expect, it } from "vitest";
import { oauth1AuthorizationHeader, oauthPercentEncode } from "./oauth1.js";

describe("OAuth 1 signing", () => {
  it("uses RFC 5849 percent encoding", () => {
    expect(oauthPercentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    expect(oauthPercentEncode("An encoded string!")).toBe("An%20encoded%20string%21");
  });

  it("builds a deterministic, sorted HMAC-SHA1 Authorization header", () => {
    const header = oauth1AuthorizationHeader({
      method: "POST",
      url: new URL("https://api.example.test/request?z=last&a=first"),
      consumerKey: "consumer key",
      consumerSecret: "consumer-secret",
      token: "access-token",
      tokenSecret: "token-secret",
      extraOAuthParams: {
        oauth_callback: "https://client.example.test/callback",
        oauth_nonce: "fixed-nonce",
        oauth_timestamp: "1700000000",
      },
    });

    expect(header).toMatch(/^OAuth oauth_callback=/);
    expect(header).toContain('oauth_consumer_key="consumer%20key"');
    expect(header).toContain('oauth_nonce="fixed-nonce"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_timestamp="1700000000"');
    expect(header).toContain('oauth_token="access-token"');
    expect(header).toMatch(/oauth_signature="[A-Za-z0-9%]+"/);
    expect(header).toBe(
      oauth1AuthorizationHeader({
        method: "POST",
        url: new URL("https://api.example.test/request?z=last&a=first"),
        consumerKey: "consumer key",
        consumerSecret: "consumer-secret",
        token: "access-token",
        tokenSecret: "token-secret",
        extraOAuthParams: {
          oauth_callback: "https://client.example.test/callback",
          oauth_nonce: "fixed-nonce",
          oauth_timestamp: "1700000000",
        },
      })
    );
  });
});
