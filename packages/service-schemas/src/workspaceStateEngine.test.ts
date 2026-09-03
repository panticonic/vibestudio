import { describe, expect, it } from "vitest";
import { workspaceStateEngineMethods } from "./workspaceStateEngine.js";

describe("workspace state entity source identity", () => {
  it("accepts an honest absent execution version for an inert session", () => {
    expect(
      workspaceStateEngineMethods.entityActivate.args.parse([
        {
          kind: "session",
          source: { repoPath: "agent-cli", effectiveVersion: "" },
          contextId: "ctx-system-tests",
          key: "system-tests",
        },
      ])
    ).toEqual([
      {
        kind: "session",
        source: { repoPath: "agent-cli", effectiveVersion: "" },
        contextId: "ctx-system-tests",
        key: "system-tests",
      },
    ]);
  });

  it("keeps host-derived root ownership on the internal slot-create command", () => {
    expect(
      workspaceStateEngineMethods.slotCreate.args.parse([
        {
          slotId: "panel:root",
          parentSlotId: null,
          ownerUserId: "user-verified",
        },
      ])
    ).toEqual([
      {
        slotId: "panel:root",
        parentSlotId: null,
        ownerUserId: "user-verified",
      },
    ]);
  });

  it("preserves task-scoped system-test authority through alarm scheduling", () => {
    const input = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "chat-test",
      wakeAt: 1,
      testPolicy: {
        policyId: "case-policy",
        kind: "case" as const,
        orchestratorPolicyId: "orchestrator-policy",
        case: {
          testId: "chat-task-permission-reuse",
          agent: {
            model: "openai-codex:gpt-5.6-luna",
            approvalLevel: 2 as const,
            fallback: "disabled" as const,
          },
          authority: [
            {
              ruleId: "permissions-read",
              capability: { kind: "exact" as const, key: "permissions.read" },
              resource: { kind: "exact" as const, key: "workspace" },
              tier: "gated" as const,
              decision: "task" as const,
            },
          ],
          unexpectedPrompts: "fail" as const,
        },
      },
    };

    expect(workspaceStateEngineMethods.alarmSet.args.parse([input])).toEqual([input]);
  });
});
