import { describe, expect, it } from "vitest";
import { workspaceStateEngineMethods } from "./workspaceStateEngine.js";

describe("workspace state entity source identity", () => {
  it("requires the exact lifetime for retirement cleanup completion", () => {
    expect(
      workspaceStateEngineMethods.entityCleanupComplete.args.parse(["entity", "lifetime"])
    ).toEqual(["entity", "lifetime"]);
    expect(
      workspaceStateEngineMethods.entityCleanupComplete.args.safeParse(["entity"]).success
    ).toBe(false);
    expect(
      workspaceStateEngineMethods.entityCleanupComplete.args.safeParse(["entity", ""]).success
    ).toBe(false);
  });
  it("retains the exact successful-pass token without exposing it on ordinary alarm scheduling", () => {
    const key = { source: "workers/agent", className: "Agent", objectKey: "one" };
    const input = {
      ...key,
      dispatchOwner: "driver-1",
      dispatchGeneration: 3,
      wakeRequest: { incarnation: "owner-1", generation: 5 },
      nextAlarm: null,
    };
    expect(workspaceStateEngineMethods.alarmComplete.args.parse([input])).toEqual([input]);
    expect(
      workspaceStateEngineMethods.alarmSourceRequest.args.parse([
        { ...key, incarnation: "owner-1" },
      ])
    ).toEqual([{ ...key, incarnation: "owner-1" }]);
    expect(() =>
      workspaceStateEngineMethods.alarmComplete.args.parse([{ ...input, dispatchGeneration: 0 }])
    ).toThrow();
    expect(() =>
      workspaceStateEngineMethods.alarmComplete.args.parse([
        { ...input, wakeRequest: { incarnation: "owner-1", generation: 0 } },
      ])
    ).toThrow();
    expect(
      workspaceStateEngineMethods.alarmSet.args.parse([
        { ...key, wakeAt: 0, wakeRequest: input.wakeRequest },
      ])
    ).toEqual([{ ...key, wakeAt: 0 }]);
  });
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

  it("omits private ownership for shared panel initialization instead of encoding null", () => {
    const seeds = [{ source: "panels/chat" }];
    expect(workspaceStateEngineMethods.initializePanels.args.parse([seeds])).toEqual([seeds]);
    expect(workspaceStateEngineMethods.initializePanels.args.parse([seeds, "user-owner"])).toEqual([
      seeds,
      "user-owner",
    ]);
    expect(() => workspaceStateEngineMethods.initializePanels.args.parse([seeds, null])).toThrow();
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
