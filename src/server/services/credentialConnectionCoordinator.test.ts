import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { EventPayloads } from "@vibestudio/shared/eventsService";
import { toCredentialConnectRequest } from "@vibestudio/shared/providerConnect";
import {
  createCredentialConnectionCoordinator,
  type CredentialConnectionCoordinatorDeps,
} from "./credentialConnectionCoordinator";

afterEach(() => vi.unstubAllGlobals());

it("exchanges Claude's browser callback with PKCE and JSON state, persisting its refresh recipe", async () => {
  const caller = createVerifiedCaller("shell:test", "shell");
  const ctx: ServiceContext = {
    caller,
    connectionId: "connection-1",
    wsClient: {
      caller,
      ws: null,
      connectionId: "connection-1",
      authenticated: true,
      oauthCallbackMode: "client-loopback",
    },
    signal: AbortSignal.timeout(5000),
  };
  let authorization: URL | undefined;
  let callback: Promise<void> | undefined;
  const storeCredential = vi.fn<CredentialConnectionCoordinatorDeps["storeCredential"]>(
    async (_ctx, params) => ({
      id: "claude-credential",
      label: params.label,
      audience: params.audience.map((entry) => ({ ...entry, match: entry.match ?? "origin" })),
      injection: params.injection,
      scopes: params.scopes ?? [],
      lifecycle: { state: "active", canRefresh: true },
    })
  );
  const coordinator = createCredentialConnectionCoordinator({
    credentialStore: { loadUrlBound: vi.fn(), saveUrlBound: vi.fn() },
    clientConfigStore: { load: vi.fn() },
    storeCredential,
    resolveApprovalIdentity: () => ({
      callerId: caller.runtime.id,
      repoPath: "test",
      effectiveVersion: "test",
    }),
    requestCredentialApproval: async () => "session",
    loadActiveCredential: vi.fn(),
    authorizeCredentialSubjectUse: vi.fn(),
    findReplacementCandidate: async () => null,
    validateCredentialBindings: vi.fn(),
    appendAudit: vi.fn(),
    eventService: {
      emitToCaller: () => false,
      emitToConnection: (_callerId, _connectionId, event, data) => {
        if (event === "external-open:open") {
          const payload = data as EventPayloads["external-open:open"];
          authorization = new URL(payload.url);
          const handoff = payload.oauthLoopback!;
          callback = new Promise<void>((resolve, reject) =>
            setTimeout(() => {
              coordinator
                .forwardOAuthCallback(ctx, {
                  transactionId: handoff.transactionId,
                  url: `${handoff.redirectUri}?code=authorization-code&state=${encodeURIComponent(handoff.state)}`,
                })
                .then(resolve, reject);
            }, 0)
          );
        }
        return true;
      },
    },
  });
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://platform.claude.com/v1/oauth/token");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code: "authorization-code",
      state: authorization!.searchParams.get("state"),
      redirect_uri: "http://localhost:53692/callback",
    });
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
      authorization!.searchParams.get("code_challenge")
    );
    return Response.json({
      access_token: "test-access",
      refresh_token: "test-refresh",
      expires_in: 3600,
      scope: "user:inference",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await coordinator.connect(
    ctx,
    ConnectCredentialParamsSchema.parse(
      toCredentialConnectRequest("anthropic", { browser: "external" })
    )
  );
  await callback;
  expect(result.id).toBe("claude-credential");
  expect(authorization!.origin).toBe("https://claude.ai");
  expect(authorization!.searchParams.get("code")).toBe("true");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(storeCredential.mock.calls[0]![1]).toMatchObject({
    material: { type: "bearer-token", token: "test-access" },
    refreshToken: "test-refresh",
    oauthRefresh: {
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      tokenAuth: "none",
      tokenRequestEncoding: "json",
    },
    metadata: { modelProviderId: "anthropic", modelAuthMethod: "subscription" },
  });
});
