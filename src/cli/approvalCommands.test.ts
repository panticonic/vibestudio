import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { RpcClient } from "@vibestudio/direct-client";
import { approvalSummary, resolvePendingApproval } from "./approvalCommands.js";

function credentialApproval(): PendingApproval {
  return {
    approvalId: "approval-model-1",
    callerId: "do:workers/agent-worker:AiChatWorker:test",
    callerKind: "do",
    repoPath: "workers/agent-worker",
    executionDigest: "digest-1",
    requestedAt: 1_000,
    decisionDeadlineAt: 1_801_000,
    kind: "credential",
    credentialId: "credential-1",
    credentialLabel: "ChatGPT Codex model credential",
    audience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
    accountIdentity: { providerUserId: "openai-user-1" },
    scopes: ["openid"],
  };
}

function clientFor(pending: PendingApproval[]) {
  const call = vi.fn(async (method: string, _args: unknown[]) => {
    if (method === "shellApproval.listPending") return pending;
    if (method === "shellApproval.resolve") return undefined;
    throw new Error(`unexpected method ${method}`);
  });
  return { client: { call } as unknown as RpcClient, call };
}

describe("approval CLI commands", () => {
  it("summarizes exact requester identity and the queue-owned deadline", () => {
    expect(approvalSummary(credentialApproval())).toMatchObject({
      approvalId: "approval-model-1",
      kind: "credential",
      title: "Use ChatGPT Codex model credential",
      repoPath: "workers/agent-worker",
      requestedAt: 1_000,
      decisionDeadlineAt: 1_801_000,
    });
  });

  it("resolves a credential approval with the selected grant scope", async () => {
    const { client, call } = clientFor([credentialApproval()]);

    await resolvePendingApproval(client, "approval-model-1", "session");

    expect(call).toHaveBeenNthCalledWith(1, "shellApproval.listPending", []);
    expect(call).toHaveBeenNthCalledWith(2, "shellApproval.resolve", [
      "approval-model-1",
      "session",
    ]);
  });

  it("rejects decisions for unknown approval ids", async () => {
    const { client } = clientFor([]);
    await expect(resolvePendingApproval(client, "missing", "once")).rejects.toThrow(
      "no pending approval found for missing"
    );
  });
});
