import { afterEach, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { toCredentialConnectRequest } from "@vibestudio/shared/providerConnect";
import {
  createCredentialConnectionCoordinator,
  type CredentialConnectionCoordinatorDeps,
} from "./credentialConnectionCoordinator";
import type { ApprovalQueue } from "./approvalQueue";

const provider = vi.hoisted(() => ({ login: vi.fn(), toAuth: vi.fn() }));
vi.mock("./credentialMechanisms/modelProvider", () => ({
  modelProviderOAuth: () => provider,
  modelProviderMaterial: async () => ({
    token: "model-access",
    baseUrl: "https://api.business.githubcopilot.com",
    allowedModelIds: ["model-1"],
  }),
}));
afterEach(() => vi.clearAllMocks());

it.each(["github-copilot", "kimi-coding", "meta", "xai"])(
  "connects %s with browser handoff, device-code UI, and encrypted provider state",
  async (providerId) => {
    const caller = createVerifiedCaller("app:test", "app");
    const ctx: ServiceContext = {
      caller,
      connectionId: "connection",
      wsClient: { caller, ws: null, connectionId: "connection", authenticated: true },
    };
    const cancelled = new AbortController();
    const dispose = vi.fn();
    const presentDeviceCode = vi.fn(() => ({
      approvalId: "approval",
      cancelled: cancelled.signal,
      dispose,
    }));
    const storeCredential = vi.fn<CredentialConnectionCoordinatorDeps["storeCredential"]>(
      async (_ctx, request) => ({
        id: "saved",
        label: request.label,
        audience: request.audience.map((entry) => ({ ...entry, match: entry.match ?? "origin" })),
        injection: request.injection,
        scopes: [],
        lifecycle: { state: "active", canRefresh: true },
        metadata: request.metadata,
      })
    );
    const emitToConnection = vi.fn(() => true);
    const coordinator = createCredentialConnectionCoordinator({
      credentialStore: { loadUrlBound: vi.fn(), saveUrlBound: vi.fn() },
      clientConfigStore: { load: vi.fn() },
      approvalQueue: { presentDeviceCode } as unknown as ApprovalQueue,
      eventService: { emitToConnection, emitToCaller: vi.fn(() => true) },
      storeCredential,
      resolveApprovalIdentity: () => ({
        callerId: "app:test",
        repoPath: "test",
        effectiveVersion: "v1",
      }),
      requestCredentialApproval: async () => "session",
      loadActiveCredential: vi.fn(),
      authorizeCredentialSubjectUse: vi.fn(),
      findReplacementCandidate: async () => null,
      validateCredentialBindings: vi.fn(),
      appendAudit: vi.fn(),
    });
    provider.login.mockImplementationOnce(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://provider.example/device",
        expiresInSeconds: 900,
      });
      return {
        type: "oauth",
        access: "model-access",
        refresh: "private-session",
        expires: Date.now() + 3600000,
        availableModelIds: ["model-1"],
      };
    });
    const request = toCredentialConnectRequest(providerId, { browser: "external" })!;
    const result = await coordinator.connect(ctx, ConnectCredentialParamsSchema.parse(request));
    expect(presentDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-EFGH", credentialLabel: request.credential.label })
    );
    expect(emitToConnection).toHaveBeenCalledWith(
      "app:test",
      "connection",
      "external-open:open",
      expect.objectContaining({ url: "https://provider.example/device" })
    );
    expect(storeCredential.mock.calls[0]![1]).toMatchObject({
      modelProviderSession: { providerId, credential: { refresh: "private-session" } },
      metadata: { modelAvailableIds: '["model-1"]' },
    });
    expect(JSON.stringify(result)).not.toContain("private-session");
    expect(dispose).toHaveBeenCalledOnce();
  }
);
