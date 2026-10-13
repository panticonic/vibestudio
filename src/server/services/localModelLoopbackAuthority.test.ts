import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { LocalModelLoopbackAuthority } from "./localModelLoopbackAuthority.js";

const nativeInvocation = {
  owner: {
    runtimeId: "do:workers/agent-worker:AiChatWorker:agent-1",
    authoritySessionId: "authority-1",
  },
  task: { conversationId: 1, taskId: 2 },
  operation: {
    kind: "model" as const,
    purpose: "generation" as const,
    attempt: 0,
    cutoff: 1,
    providerId: "local",
    modelId: "lfm2.5-1.2b",
    endpoint: null,
  },
};

describe("LocalModelLoopbackAuthority", () => {
  it("injects provider authority only for the exact active local model and endpoint", async () => {
    const readRuntimeAuth = vi.fn(runtimeAuth);
    const authority = fixture({ readRuntimeAuth });
    const caller = agentCaller();

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer attacker-controlled" },
      })
    ).resolves.toEqual({
      trustedForwardHeaders: { authorization: "Bearer loopback-secret" },
    });
    expect(readRuntimeAuth).toHaveBeenCalledWith(caller, "lfm2.5-1.2b");

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43118/v1/chat/completions"),
        method: "POST",
        headers: {},
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller: { ...caller, codeApproved: undefined },
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: {},
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("https://example.test/v1/chat/completions"),
        method: "POST",
        headers: {},
      })
    ).resolves.toBe(false);
  });

  it("authorizes sealed capability facts rather than a product class name", async () => {
    const authority = fixture();
    const id = "do:workers/custom:Processor:processor-1";
    const caller = {
      ...createVerifiedCaller(id, "do", {
        callerId: id,
        callerKind: "do",
        repoPath: "workers/custom",
        effectiveVersion: "ev-custom",
        executionDigest: "b".repeat(64),
        requested: [
          {
            capability: "internal-model-runtime.use",
            resource: { kind: "exact" as const, key: "local-models" },
          },
        ],
      }),
      codeApproved: true as const,
      nativeInvocation,
    };

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: {},
      })
    ).resolves.toEqual({
      trustedForwardHeaders: { authorization: "Bearer loopback-secret" },
    });
  });

  it("fails closed for inactive, wrong-model, and unavailable provider facts", async () => {
    const input = {
      caller: agentCaller(),
      targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
      method: "POST",
      headers: {},
    };
    await expect(
      fixture({
        resolveNativeInvocation: async () => ({
          nativeInvocation,
          active: false,
        }),
      }).authorize(input)
    ).rejects.toThrow("Local model runtime authority is unavailable");
    await expect(
      fixture({
        resolveNativeInvocation: async () => ({
          nativeInvocation: {
            ...nativeInvocation,
            operation: { ...nativeInvocation.operation, modelId: "other" },
          },
          active: true,
        }),
      }).authorize(input)
    ).rejects.toThrow("Local model runtime authority is unavailable");
    await expect(
      fixture({
        readRuntimeAuth: async () => {
          throw new Error("provider retired");
        },
      }).authorize(input)
    ).rejects.toThrow("Local model runtime authority is unavailable");
  });

  it.each([
    null,
    {},
    { apiKey: "loopback-secret", baseUrl: 43117 },
    { apiKey: "loopback-secret", baseUrl: "not a URL" },
  ])("rejects malformed provider attestations: %j", async (auth) => {
    await expect(
      fixture({ readRuntimeAuth: async () => auth }).authorize({
        caller: agentCaller(),
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: {},
      })
    ).rejects.toThrow("Local model runtime authority is unavailable");
  });

  it("revalidates the provider incarnation on every request", async () => {
    let auth = await runtimeAuth();
    const authority = fixture({ readRuntimeAuth: async () => auth });
    const input = {
      caller: agentCaller(),
      targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
      method: "POST",
      headers: {},
    };
    await expect(authority.authorize(input)).resolves.toEqual({
      trustedForwardHeaders: { authorization: "Bearer loopback-secret" },
    });
    auth = {
      apiKey: "replacement-key",
      baseUrl: "http://127.0.0.1:44117/v1",
    };
    await expect(authority.authorize(input)).resolves.toBe(false);
    await expect(
      authority.authorize({
        ...input,
        targetUrl: new URL("http://127.0.0.1:44117/v1/chat/completions"),
      })
    ).resolves.toEqual({
      trustedForwardHeaders: { authorization: "Bearer replacement-key" },
    });
  });
});

function fixture(
  overrides: Partial<ConstructorParameters<typeof LocalModelLoopbackAuthority>[0]> = {}
) {
  return new LocalModelLoopbackAuthority({
    resolveNativeInvocation: async () => ({ nativeInvocation, active: true }),
    readRuntimeAuth: runtimeAuth,
    ...overrides,
  });
}

async function runtimeAuth() {
  return {
    apiKey: "loopback-secret",
    baseUrl: "http://127.0.0.1:43117/v1",
  };
}

function agentCaller() {
  const id = nativeInvocation.owner.runtimeId;
  return {
    ...createVerifiedCaller(id, "do", {
      callerId: id,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "internal-model-runtime.use",
          resource: { kind: "exact" as const, key: "local-models" },
        },
      ],
    }),
    codeApproved: true as const,
    nativeInvocation,
  };
}
