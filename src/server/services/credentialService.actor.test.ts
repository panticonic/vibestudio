import type { Credential, StoredCredentialSummary } from "@vibestudio/credential-client/types";
import { StoreUrlBoundCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestExecutionSession } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { describe, expect, it, vi } from "vitest";
import { createCredentialService } from "./credentialService.js";

class MemoryCredentialStore {
  readonly credentials = new Map<string, Credential>();
  loadUrlBound(id: string): Credential | null {
    return this.credentials.get(id) ?? null;
  }
  listUrlBound(): Credential[] {
    return [...this.credentials.values()];
  }
  saveUrlBound(credential: Credential & { id: string }): void {
    this.credentials.set(credential.id, credential);
  }
}

function approvingQueue(decision: "session" | "agent" | "version") {
  return {
    request: vi.fn(async (): Promise<"session" | "agent" | "version"> => decision),
    resolve: vi.fn(),
    resolveMatching: vi.fn(),
    listPending: vi.fn(() => []),
  };
}

const DARA = "usr_dara";
const BOB = "usr_bob";

function asUser<T extends ReturnType<typeof createVerifiedCaller>>(caller: T, userId: string): T {
  return { ...caller, subject: { userId, handle: userId.slice(4) } };
}

function workerCaller(userId = DARA) {
  return asUser(
    createVerifiedCaller("worker:test", "worker", {
      callerId: "worker:test",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
    }),
    userId
  );
}

const agentId = "do:workers/agent-worker:AiChatWorker:conversation-1";

function agentCaller(userId = DARA) {
  const callerId = "do:vibestudio/internal:EvalDO:hash-1";
  return asUser(agentCallerWithoutUser(callerId), userId);
}

function agentCallerWithoutUser(callerId: string) {
  return createVerifiedCaller(
    callerId,
    "do",
    {
      callerId,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
      executionDigest: "a".repeat(64),
      requested: [],
      evalOrigin: { ownerId: agentId },
    },
    { entityId: agentId, contextId: "ctx-agent", channelId: "conversation-1" },
    null,
    createTestExecutionSession({
      runtimeId: callerId,
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
      harnessPrincipal: `code:workers/agent-worker@${"a".repeat(64)}`,
      contextId: "ctx-agent",
      agentBinding: { entityId: agentId, channelId: "conversation-1", bindingId: agentId },
    })
  );
}

function storeParams(actor: "human" | "agent", label: string, extra: Record<string, unknown> = {}) {
  return {
    label,
    actor,
    ...extra,
    audience: [{ url: "https://api.example.test/", match: "origin" as const }],
    injection: {
      type: "header" as const,
      name: "Authorization",
      valueTemplate: "Bearer {token}",
    },
    material: { type: "bearer-token" as const, token: `${actor}-token` },
  };
}

describe("credentialService credential actor", () => {
  it("persists the provider actor attribution and reports it in secret-free summaries", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvingQueue("session") as never,
    });
    const params = storeParams("human", "Provider (you)");
    expect(StoreUrlBoundCredentialParamsSchema.parse(params)).toEqual(params);

    const stored = (await service.handler({ caller: workerCaller() }, "storeCredential", [
      params,
    ])) as StoredCredentialSummary;

    expect(stored.actor).toBe("human");
    expect(store.loadUrlBound(stored.id)?.actor).toBe("human");
    const listed = (await service.handler(
      { caller: workerCaller() },
      "listStoredCredentials",
      []
    )) as StoredCredentialSummary[];
    expect(listed).toEqual([expect.objectContaining({ id: stored.id, actor: "human" })]);
    expect(JSON.stringify(listed)).not.toContain("human-token");
  });

  it("refuses an agent its user's human credential without an agent exchange, without prompting", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("session");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    await service.handler({ caller: workerCaller() }, "storeCredential", [
      storeParams("human", "Provider (you)"),
    ]);
    approvalQueue.request.mockClear();
    approvalQueue.request.mockImplementation(async () => "agent");

    await expect(
      service.handler({ caller: agentCaller() }, "resolveCredential", [
        { url: "https://api.example.test/v1" },
      ])
    ).rejects.toThrow(/credential-actor-mismatch/);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("lets an agent session resolve an agent-attributed credential through ordinary consent", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("session");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    const stored = (await service.handler({ caller: workerCaller() }, "storeCredential", [
      storeParams("agent", "Provider (your agents)"),
    ])) as StoredCredentialSummary;
    approvalQueue.request.mockClear();
    approvalQueue.request.mockImplementation(async () => "agent");

    await expect(
      service.handler({ caller: agentCaller() }, "resolveCredential", [
        { url: "https://api.example.test/v1" },
      ])
    ).resolves.toMatchObject({ id: stored.id, actor: "agent" });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("does not preapprove an agent's own use when it connects a human-attributed credential", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("agent");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });

    const stored = (await service.handler({ caller: agentCaller() }, "storeCredential", [
      storeParams("human", "Provider (you)"),
    ])) as StoredCredentialSummary;

    expect(store.loadUrlBound(stored.id)?.grants ?? []).toEqual([]);
  });

  it("stamps the owning member from the verified caller", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvingQueue("session") as never,
    });
    const stored = (await service.handler({ caller: workerCaller(BOB) }, "storeCredential", [
      storeParams("human", "Provider"),
    ])) as StoredCredentialSummary;
    expect(store.loadUrlBound(stored.id)?.owner?.userId).toBe(BOB);
    // The request cannot name an owner: the schema has no such field.
    expect(() =>
      StoreUrlBoundCredentialParamsSchema.parse({
        ...storeParams("human", "Provider"),
        owner: { userId: DARA },
      })
    ).toThrow();
  });

  it("lets every member keep their own human credential under one label, but no one else's", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("session");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    const daras = (await service.handler({ caller: workerCaller(DARA) }, "storeCredential", [
      storeParams("human", "Namlu"),
    ])) as StoredCredentialSummary;
    const bobs = (await service.handler({ caller: workerCaller(BOB) }, "storeCredential", [
      storeParams("human", "Namlu"),
    ])) as StoredCredentialSummary;
    expect(daras.id).not.toBe(bobs.id);
    // Shared (non-personal) labels stay unique across the hub.
    await service.handler({ caller: workerCaller(DARA) }, "storeCredential", [
      storeParams("agent", "Shared"),
    ]);
    await expect(
      service.handler({ caller: workerCaller(BOB) }, "storeCredential", [
        storeParams("agent", "Shared"),
      ])
    ).rejects.toThrow(/already in use/);

    // Each member resolves their own; a member with none is asked to connect one.
    await expect(
      service.handler({ caller: workerCaller(BOB) }, "resolveCredential", [
        { url: "https://api.example.test/v1", credentialLabel: "Namlu" },
      ])
    ).resolves.toMatchObject({ id: bobs.id });
    await expect(
      service.handler({ caller: workerCaller("usr_carol") }, "resolveCredential", [
        { url: "https://api.example.test/v1", credentialLabel: "Namlu" },
      ])
    ).rejects.toThrow(/credential-owner-required/);
    await expect(
      service.handler({ caller: workerCaller(BOB) }, "resolveCredential", [
        { url: "https://api.example.test/v1", credentialId: daras.id },
      ])
    ).rejects.toThrow(/credential-owner-mismatch/);
  });

  it("lets an agent resolve its user's human credential when it declares an agent exchange", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("session");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    const agentExchange = {
      tokenUrl: "https://auth.example.test/oauth/token",
      clientId: "vibestudio",
    };
    const stored = (await service.handler({ caller: workerCaller() }, "storeCredential", [
      storeParams("human", "Provider", {
        agentExchange,
        metadata: { oauthTokenOrigin: "https://auth.example.test" },
      }),
    ])) as StoredCredentialSummary;
    expect(stored.agentExchange).toEqual(agentExchange);
    approvalQueue.request.mockClear();
    approvalQueue.request.mockImplementation(async () => "agent");

    await expect(
      service.handler({ caller: agentCaller() }, "resolveCredential", [
        { url: "https://api.example.test/v1" },
      ])
    ).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    // ...but another member's agent may not.
    await expect(
      service.handler({ caller: agentCaller(BOB) }, "resolveCredential", [
        { url: "https://api.example.test/v1" },
      ])
    ).rejects.toThrow(/credential-owner-required/);
  });

  it("refuses an agent exchange aimed anywhere but the credential's own token endpoint origin", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      approvalQueue: approvingQueue("session") as never,
    });
    await expect(
      service.handler({ caller: workerCaller() }, "storeCredential", [
        storeParams("human", "Provider", {
          agentExchange: { tokenUrl: "https://evil.example.test/oauth/token", clientId: "x" },
          metadata: { oauthTokenOrigin: "https://auth.example.test" },
        }),
      ])
    ).rejects.toThrow(/share its origin/);
    // the retirement call spends the same subject token, so it is held to the same origin
    await expect(
      service.handler({ caller: workerCaller() }, "storeCredential", [
        storeParams("human", "Provider", {
          agentExchange: {
            tokenUrl: "https://auth.example.test/oauth/token",
            retireUrl: "https://evil.example.test/oauth/agents/retire",
            clientId: "x",
          },
          metadata: { oauthTokenOrigin: "https://auth.example.test" },
        }),
      ])
    ).rejects.toThrow(/retireUrl must share its origin/);
    await expect(
      service.handler({ caller: workerCaller() }, "storeCredential", [
        storeParams("agent", "Provider", {
          agentExchange: { tokenUrl: "https://auth.example.test/oauth/token", clientId: "x" },
          metadata: { oauthTokenOrigin: "https://auth.example.test" },
        }),
      ])
    ).rejects.toThrow(/human-attributed/);
  });
});
