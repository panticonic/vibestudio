import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { LocalModelLoopbackAuthority } from "./localModelLoopbackAuthority.js";

describe("LocalModelLoopbackAuthority", () => {
  it("admits only the exact reviewed agent vessel, live port, and bearer", async () => {
    const authority = new LocalModelLoopbackAuthority({ readRuntimeAuth: runtimeAuth });
    const caller = agentCaller();

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(true);

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43118/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller: { ...caller, codeApproved: undefined },
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("https://example.test/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(false);
  });

  it("authorizes by sealed capability facts rather than a product class name", async () => {
    const authority = new LocalModelLoopbackAuthority({ readRuntimeAuth: runtimeAuth });
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
    };

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(true);
  });

  it("fails closed when the provider is unavailable or no endpoint is live", async () => {
    const input = {
      caller: agentCaller(),
      targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
      method: "POST",
      headers: { Authorization: "Bearer loopback-secret" },
    };
    await expect(
      new LocalModelLoopbackAuthority({
        readRuntimeAuth: async () => ({ apiKey: "loopback-secret", origins: [] }),
      }).authorize(input)
    ).resolves.toBe(false);
    await expect(
      new LocalModelLoopbackAuthority({
        readRuntimeAuth: async () => {
          throw new Error("provider retired");
        },
      }).authorize(input)
    ).rejects.toThrow("Local model runtime authority is unavailable");
  });

  it.each([
    null,
    {},
    { apiKey: "loopback-secret", origins: "http://127.0.0.1:43117" },
    { apiKey: "loopback-secret", origins: ["http://127.0.0.1:43117", 43118] },
  ])("rejects malformed provider attestations: %j", async (auth) => {
    const authority = new LocalModelLoopbackAuthority({ readRuntimeAuth: async () => auth });
    await expect(
      authority.authorize({
        caller: agentCaller(),
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).rejects.toThrow("Local model runtime authority is unavailable");
  });

  it("revalidates the provider's incarnation on every request", async () => {
    let auth = await runtimeAuth();
    const authority = new LocalModelLoopbackAuthority({ readRuntimeAuth: async () => auth });
    const input = {
      caller: agentCaller(),
      targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
      method: "POST",
      headers: { Authorization: "Bearer loopback-secret" },
    };
    expect(await authority.authorize(input)).toBe(true);
    auth = { apiKey: "replacement-key", origins: ["http://127.0.0.1:44117"] };
    expect(await authority.authorize(input)).toBe(false);
    expect(
      await authority.authorize({
        ...input,
        targetUrl: new URL("http://127.0.0.1:44117/v1/chat/completions"),
        headers: { Authorization: "Bearer replacement-key" },
      })
    ).toBe(true);
  });
});

async function runtimeAuth() {
  return {
    apiKey: "loopback-secret",
    origins: ["http://127.0.0.1:43117", "http://127.0.0.1:43118"],
  };
}

function agentCaller() {
  const id = "do:workers/agent-worker:AiChatWorker:agent-1";
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
          resource: { kind: "exact", key: "local-models" },
        },
      ],
    }),
    codeApproved: true as const,
  };
}
