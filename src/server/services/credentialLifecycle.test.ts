import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@vibestudio/credential-client/types";
import { CredentialLifecycle, CredentialLifecycleError } from "./credentialLifecycle.js";

function credential(overrides: Partial<Credential> = {}): Credential & { id: string } {
  return {
    id: "credential-1",
    providerId: "url-bound",
    connectionId: "credential-1",
    connectionLabel: "Example OAuth",
    accountIdentity: { providerUserId: "user-1" },
    accessToken: "expired-access",
    refreshToken: "refresh-1",
    oauthRefresh: {
      tokenUrl: "https://auth.example.test/oauth/token",
      clientId: "public-client",
      tokenAuth: "none",
    },
    scopes: ["read", "write"],
    expiresAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CredentialLifecycle", () => {
  it("refreshes a public OAuth client from its exact persisted recipe", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const saveUrlBound = vi.fn(async () => undefined);
    const loadVersion = vi.fn();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-1");
      expect(body.get("client_id")).toBe("public-client");
      expect(body.has("client_secret")).toBe(false);
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 60,
          scope: "read",
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound },
      clientConfigStore: { loadVersion },
    });

    const refreshed = await lifecycle.refreshCredential(credential());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.example.test/oauth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(loadVersion).not.toHaveBeenCalled();
    expect(refreshed).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "refresh-2",
      expiresAt: 70_000,
      scopes: ["read"],
    });
    expect(refreshed.oauthRefresh).toEqual(credential().oauthRefresh);
    expect(saveUrlBound).toHaveBeenCalledWith(refreshed);
  });

  it("loads the exact configured-client version and authenticates the refresh", async () => {
    const saveUrlBound = vi.fn(async () => undefined);
    const loadVersion = vi.fn(async () => ({
      version: "version-1",
      authorizeUrl: "https://auth.example.test/oauth/authorize",
      tokenUrl: "https://auth.example.test/oauth/token",
      fields: {
        clientId: { value: "confidential-client", type: "text" as const, updatedAt: 1 },
        clientSecret: { value: "client-secret", type: "secret" as const, updatedAt: 1 },
      },
      createdAt: 1,
    }));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["authorization"]).toMatch(/^Basic /);
      return new Response(
        JSON.stringify({ access_token: "fresh-access", token_type: "Bearer", expires_in: 60 }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound },
      clientConfigStore: { loadVersion },
    });
    const configured = credential({
      oauthRefresh: {
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "confidential-client",
        tokenAuth: "client_secret_basic",
        clientConfig: { configId: "provider", configVersion: "version-1" },
      },
    });

    await lifecycle.refreshCredential(configured);

    expect(loadVersion).toHaveBeenCalledWith("provider", "version-1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears the replaced token's expiry when the refresh response omits expires_in", async () => {
    const saveUrlBound = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "fresh-access", token_type: "Bearer" }), {
          status: 200,
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound },
      clientConfigStore: { loadVersion: vi.fn() },
    });

    const refreshed = await lifecycle.refreshCredential(credential({ expiresAt: 1 }));

    expect(refreshed).not.toHaveProperty("expiresAt");
    expect(saveUrlBound).toHaveBeenCalledWith(refreshed);
    await expect(lifecycle.refreshIfNeeded(refreshed)).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects token-only records and mismatched client configs instead of guessing", async () => {
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound: vi.fn() },
      clientConfigStore: {
        loadVersion: vi.fn(async () => ({
          version: "version-1",
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://different.example.test/oauth/token",
          fields: {
            clientId: { value: "confidential-client", type: "text" as const, updatedAt: 1 },
          },
          createdAt: 1,
        })),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      lifecycle.refreshCredential(credential({ oauthRefresh: undefined }))
    ).rejects.toBeInstanceOf(CredentialLifecycleError);
    await expect(
      lifecycle.refreshCredential(
        credential({
          oauthRefresh: {
            tokenUrl: "https://auth.example.test/oauth/token",
            clientId: "confidential-client",
            tokenAuth: "client_secret_post",
            clientConfig: { configId: "provider", configVersion: "version-1" },
          },
        })
      )
    ).rejects.toMatchObject({ code: "client_config_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
