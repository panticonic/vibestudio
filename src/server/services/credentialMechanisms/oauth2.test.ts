import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyOAuthClientAssertion, basicAuthHeader, signJwtAssertion } from "./oauth2.js";

describe("OAuth 2 client authentication", () => {
  it("encodes client credentials for HTTP Basic auth", () => {
    expect(basicAuthHeader("client id", "s:ecret")).toBe(
      `Basic ${Buffer.from("client%20id:s%3Aecret").toString("base64")}`
    );
  });

  it("creates a verifiable RS256 client assertion with bounded lifetime", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const assertion = signJwtAssertion({
      issuer: "client-1",
      subject: "client-1",
      audience: "https://issuer.example.test/token",
      privateKeyPem,
      keyId: "key-1",
    });
    const [encodedHeader, encodedPayload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "key-1",
    });
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as {
      iss: string;
      sub: string;
      aud: string;
      iat: number;
      exp: number;
      jti: string;
    };
    expect(payload).toMatchObject({
      iss: "client-1",
      sub: "client-1",
      aud: "https://issuer.example.test/token",
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.any(String),
    });
    expect(payload.exp - payload.iat).toBe(300);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("adds private_key_jwt fields and rejects missing key material", () => {
    const body = new URLSearchParams();
    expect(() =>
      applyOAuthClientAssertion(body, {
        tokenUrl: "https://issuer.example.test/token",
        clientId: "client-1",
        tokenAuth: "private_key_jwt",
      })
    ).toThrow(expect.objectContaining({ code: "client_config_unavailable" }));

    applyOAuthClientAssertion(body, {
      tokenUrl: "https://issuer.example.test/token",
      clientId: "client-1",
      tokenAuth: "none",
    });
    expect([...body]).toEqual([]);
  });
});
