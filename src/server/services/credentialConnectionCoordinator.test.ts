import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { afterEach, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { toCredentialConnectRequest } from "@vibestudio/shared/providerConnect";
import {
  createCredentialConnectionCoordinator,
  type CredentialConnectionCoordinatorDeps,
} from "./credentialConnectionCoordinator";

afterEach(() => vi.unstubAllGlobals());

it("requires the trusted approval UI for native Claude sign-in before opening a browser or storing credentials", async () => {
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
  };
  const emitToConnection = vi.fn(() => true);
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
      emitToConnection,
    },
  });
  await expect(
    coordinator.connect(
      ctx,
      ConnectCredentialParamsSchema.parse(
        toCredentialConnectRequest("anthropic", { browser: "external" })
      )
    )
  ).rejects.toThrow("Provider sign-in requires the trusted approval UI");
  expect(emitToConnection).not.toHaveBeenCalled();
  expect(storeCredential).not.toHaveBeenCalled();
});
