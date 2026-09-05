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
