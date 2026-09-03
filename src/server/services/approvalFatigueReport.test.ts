import { describe, expect, it } from "vitest";
import {
  approvalSurfaceRecordsFromGovernance,
  buildApprovalFatigueReport,
  type ApprovalSurfaceRecord,
} from "./approvalFatigueReport.js";

const TASK = "task:trello-board";

function record(
  index: number,
  family: string,
  title: string,
  overrides: Partial<ApprovalSurfaceRecord> = {}
): ApprovalSurfaceRecord {
  return {
    operationId: `operation:${index}`,
    taskSubject: TASK,
    securityIdentity: "agent:builder",
    decisionId: `decision:${index}`,
    semanticFamily: family,
    resource: family,
    sourcesShown: [],
    title,
    description: "Allow this action while building the task board.",
    rows: [family],
    repeatReason: "none",
    ...overrides,
  };
}

describe("approval fatigue accounting", () => {
  it("projects a production decision without correlating another event stream", () => {
    const projected = approvalSurfaceRecordsFromGovernance([
      {
        approvalId: "approval:one",
        approvalKind: "capability",
        decision: "task",
        granted: true,
        workspaceId: "workspace:one",
        resolvedAt: 1,
        resolvedBy: { userId: "user:one", handle: "owner" },
        resolvedVia: "shell",
        requestedBy: { callerId: "agent:one", callerKind: "do" },
        operationId: "acq:one",
        taskSubject: TASK,
        securityIdentity: "security:one",
        semanticFamily: "permission.gated",
        sourcesShown: ["https://trello.com"],
        repeatReason: "new-source",
        resource: { value: "board:one" },
        surface: {
          title: "Extend this chat's permissions?",
          description: "Trello is a new source.",
          rows: ["Write task cards"],
        },
      },
    ]);
    expect(projected).toEqual([
      expect.objectContaining({
        operationId: "acq:one",
        decisionId: "approval:one",
        resource: "board:one",
        repeatReason: "new-source",
      }),
    ]);
  });

  it("reproduces the audited ten decisions and four indistinguishable repeats", () => {
    const records = [
      record(1, "credential", "Use the model account?"),
      record(2, "installation", "Add the task board?"),
      record(3, "storage", "Allow this action?"),
      record(4, "storage", "Allow this action?", { repeatReason: "duplicate" }),
      record(5, "runtime", "Allow runtime control?"),
      record(6, "runtime", "Allow runtime control?", { repeatReason: "duplicate" }),
      record(7, "inspection", "Allow inspection?"),
      record(8, "inspection", "Allow inspection?", { repeatReason: "duplicate" }),
      record(9, "publication", "Allow publication?"),
      record(10, "publication", "Allow publication?", { repeatReason: "duplicate" }),
    ];
    // Identical-card comparison is consecutive within an actor. Interleave the
    // four audited pairs as they appeared to preserve that evidence exactly.
    const paired = [
      records[0]!,
      records[1]!,
      records[2]!,
      records[3]!,
      records[4]!,
      records[5]!,
      records[6]!,
      records[7]!,
      records[8]!,
      records[9]!,
    ];
    const report = buildApprovalFatigueReport(paired);
    expect(report.promptsPerTask[TASK]).toBe(10);
    expect(report.identicalVisibleRepeats).toHaveLength(4);
  });

  it("holds the target budgets with and without planned preflight", () => {
    const withPreflight = [
      record(1, "credential", "Use the model account?"),
      record(2, "installation-and-rules", "Review the task board and its planned actions"),
      record(3, "source-delta", "Extend permissions to Trello?", {
        sourcesShown: ["web:https://trello.com/board/one"],
        repeatReason: "new-source",
      }),
    ];
    const withoutPreflight = [
      record(1, "credential", "Use the model account?"),
      record(2, "installation", "Add the task board?"),
      record(3, "storage", "Use task storage?"),
      record(4, "runtime", "Run the task board?"),
      record(5, "inspection", "Inspect the task board?"),
      record(6, "source-delta", "Extend permissions to Trello?", {
        sourcesShown: ["web:https://trello.com/board/one"],
        repeatReason: "new-source",
      }),
      record(7, "supervision", "Supervise the task board?"),
    ];
    expect(buildApprovalFatigueReport(withPreflight).promptsPerTask[TASK]).toBe(3);
    expect(buildApprovalFatigueReport(withoutPreflight).promptsPerTask[TASK]).toBe(7);
  });
});
