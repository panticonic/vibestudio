import { afterEach, expect, it, vi } from "vitest";
import type { Credential } from "@vibestudio/credential-client/types";
import { credentialLifecycle } from "@vibestudio/credential-client/credentialStatus";
import { CredentialLifecycle } from "../credentialLifecycle";

afterEach(() => vi.unstubAllGlobals());

it.each(["anthropic", "github-copilot", "kimi-coding", "meta", "xai"])(
  "renews %s through Pi while keeping session material private",
  async (providerId) => {
    const token =
      providerId === "github-copilot"
        ? "renewed;proxy-ep=proxy.individual.githubcopilot.com;"
        : "renewed";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
      if (providerId === "github-copilot")
        return Response.json({ token, expires_at: Date.now() / 1000 + 3600 });
      if (providerId === "meta") return Response.json({ api_key: token });
      return Response.json({ access_token: token, refresh_token: "rotated", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const credential: Credential & { id: string } = {
      id: "provider-1",
      providerId: "url-bound",
      connectionId: "provider-1",
      connectionLabel: "Provider",
      accountIdentity: { providerUserId: "user" },
      accessToken: "old",
      expiresAt: 1,
      scopes: [],
      modelProviderSession: {
        providerId,
        credential: { type: "oauth", access: "old", refresh: "renew-session", expires: 1 },
      },
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: "https://api.individual.githubcopilot.com", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      ],
    };
    expect(credentialLifecycle(credential)).toEqual({ state: "expired", canRefresh: true });
    const saveUrlBound = vi.fn(async () => {});
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound },
      clientConfigStore: { loadVersion: vi.fn() },
    });
    const [first, second] = await Promise.all([
      lifecycle.refreshIfNeeded(credential),
      lifecycle.refreshIfNeeded(credential),
    ]);
    expect(first.accessToken).toBe(token);
    expect(second.accessToken).toBe(token);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(saveUrlBound).toHaveBeenCalledOnce();
    expect(first.metadata).not.toHaveProperty("refresh");
    if (providerId === "github-copilot")
      expect(first.metadata?.["modelBaseUrl"]).toBe("https://api.individual.githubcopilot.com");
    const destinations = fetchMock.mock.calls.map(([url]) => String(url));
    expect(
      destinations.some((url) =>
        providerId === "meta"
          ? url.endsWith("/muse-code/key")
          : providerId === "github-copilot"
            ? url.includes("copilot_internal/v2/token")
            : url.endsWith("/token")
      )
    ).toBe(true);
  }
);
