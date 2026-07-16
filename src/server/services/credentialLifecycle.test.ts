import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@vibestudio/credential-client/types";
import { CredentialLifecycle } from "./credentialLifecycle.js";

describe("CredentialLifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refreshes public OAuth provider presets without a redundant client-config record", async () => {
    const saveUrlBound = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-token");
      expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
      expect(body.get("client_secret")).toBeNull();
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = new CredentialLifecycle({
      credentialStore: { saveUrlBound },
      clientConfigStore: {
        load: vi.fn(async () => null),
        loadVersion: vi.fn(async () => null),
      },
    });
    const credential = {
      id: "cred-openai-codex",
      label: "ChatGPT Codex model credential",
      providerId: "url-bound",
      connectionId: "cred-openai-codex",
      connectionLabel: "ChatGPT Codex model credential",
      owner: { sourceId: "workers/agent-worker", sourceKind: "workspace", label: "agent" },
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1,
      scopes: ["offline_access"],
      accountIdentity: { providerUserId: "account" },
      bindings: [],
      metadata: {
        modelProviderId: "openai-codex",
        oauthTokenAuth: "none",
      },
    } satisfies Credential & { id: string };

    const refreshed = await lifecycle.refreshCredential(credential);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(refreshed).toMatchObject({
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      metadata: expect.objectContaining({ oauthTokenUpdatedAt: expect.any(String) }),
    });
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(saveUrlBound).toHaveBeenCalledWith(refreshed);
  });
});
