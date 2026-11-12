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

function workerCaller() {
  return createVerifiedCaller("worker:test", "worker", {
    callerId: "worker:test",
    callerKind: "worker",
    repoPath: "/repo",
    effectiveVersion: "hash-1",
  });
}

const agentId = "do:workers/agent-worker:AiChatWorker:conversation-1";

function agentCaller() {
  const callerId = "do:vibestudio/internal:EvalDO:hash-1";
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

function storeParams(actor: "human" | "agent", label: string) {
  return {
    label,
    actor,
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

  it("refuses an agent session a human-attributed credential without prompting", async () => {
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
});
