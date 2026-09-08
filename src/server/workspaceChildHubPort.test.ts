import { describe, expect, it, vi } from "vitest";
import { createWorkspaceChildHubPort } from "./workspaceChildHubPort.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WorkspaceChildHubPort", () => {
  it("exposes exact typed operations over the process-authenticated child boundary", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ agentId: "agt_one", agentToken: "agent:agt_one:secret" })
    );
    const port = createWorkspaceChildHubPort({
      hubUrl: "http://127.0.0.1:7777",
      runtimeToken: "child-runtime-token",
      fetchImpl,
    });

    await expect(
      port.mintAgentCredential({ entityId: "agent:one", ttlMs: 10_000 })
    ).resolves.toEqual({ agentId: "agt_one", agentToken: "agent:agt_one:secret" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:7777/_r/s/internal/agent-credential/mint");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer child-runtime-token",
      },
      body: JSON.stringify({ entityId: "agent:one", ttlMs: 10_000 }),
    });
    expect(port).not.toHaveProperty("call");
    expect(port).not.toHaveProperty("request");
  });

  it("fails closed on malformed hub results and preserves hub errors", async () => {
    const malformed = createWorkspaceChildHubPort({
      hubUrl: "http://127.0.0.1:7777",
      runtimeToken: "child-runtime-token",
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({ revoked: "yes" })
      ),
    });
    await expect(malformed.revokeAgentCredential("agt_one")).rejects.toThrow();

    const denied = createWorkspaceChildHubPort({
      hubUrl: "http://127.0.0.1:7777",
      runtimeToken: "child-runtime-token",
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({ error: "runtime retired" }, 401)
      ),
    });
    await expect(denied.touchDevice(`dev_${"d".repeat(24)}`)).rejects.toThrow("runtime retired");
  });
  it("carries only host-attested requester evidence and validates minimal receipts", async () => {
    const receipt = {
      operationId: "creation-operation-0001",
      state: "registered",
      workspaceId: "ws_new",
      name: "New",
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(receipt)
    );
    const port = createWorkspaceChildHubPort({
      hubUrl: "http://127.0.0.1:7777",
      runtimeToken: "child-token",
      fetchImpl,
    });
    const requester = { userId: "alice", subject: "website:site" };
    await expect(
      port.createWorkspace({
        requester,
        input: { operationId: receipt.operationId, workspace: "New" },
      })
    ).resolves.toEqual(receipt);
    await expect(
      port.workspaceCreationReceipt({ requester, input: { operationId: receipt.operationId } })
    ).resolves.toEqual(receipt);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/_r/s/internal/workspace/create",
      "/_r/s/internal/workspace/creation-receipt",
    ]);
    await expect(
      port.createWorkspace({
        requester: { ...requester, workspaceId: "forged" },
        input: { operationId: receipt.operationId, workspace: "New" },
      } as never)
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
