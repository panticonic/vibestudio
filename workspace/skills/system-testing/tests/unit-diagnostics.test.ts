import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { unitDiagnosticsTests } from "./unit-diagnostics.js";

function execution(
  code: string,
  returnValue: unknown,
  final = "The workspace has 4 automations: 2 active, 1 running, and 1 failed in the last 24 hours."
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { id: "prompt", kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        id: "eval",
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        contentType: "invocation",
        content: "",
        invocation: {
          id: "eval-call",
          name: "eval",
          status: "complete",
          terminalOutcome: "success",
          isError: false,
          arguments: { code },
          result: { details: { success: true, returnValue } },
        },
      } as unknown as TestExecutionResult["messages"][number],
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: final,
      },
    ],
  } as TestExecutionResult;
}

const automationTest = unitDiagnosticsTests.find(
  (candidate) => candidate.name === "automation-overview-readonly"
)!;

describe("automation overview system test validator", () => {
  const readCode =
    "const service = await workers.resolveService('vibestudio.missions.v1'); const overview = await rpc.call(service.targetId, 'overview', [{}]); return { automations: overview.stats.total, active: overview.stats.active, running: overview.stats.running, failedLast24Hours: overview.stats.failedLast24Hours };";

  it("requires the canonical read-only surface and exact bounded counts", () => {
    expect(
      automationTest.validate(
        execution(readCode, { automations: 4, active: 2, running: 1, failedLast24Hours: 1 })
      )
    ).toEqual({ passed: true });
  });

  it("pregrants only the canonical automation service read", () => {
    expect(automationTest.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "read-automation-overview",
          capability: { kind: "exact", key: "workspace-service:missions" },
          resource: {
            kind: "prefix",
            prefix: "do:vibestudio/internal:MissionsDO:",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    });
  });

  it("rejects prose-only automation claims", () => {
    expect(
      automationTest.validate(
        execution("return { automations: 4, active: 2, running: 1, failedLast24Hours: 1 };", {})
      )
    ).toMatchObject({
      passed: false,
      reason: "Expected exactly one successful eval reading the automation overview",
    });
  });

  it("rejects automation mutation attempts", () => {
    expect(
      automationTest.validate(
        execution(`${readCode}\nawait rpc.call(service.targetId, 'runNow', ['id']);`, {
          automations: 4,
          active: 2,
          running: 1,
          failedLast24Hours: 1,
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Automation inspection probe attempted a mutating operation",
    });
  });

  it("rejects raw or extra automation data", () => {
    expect(
      automationTest.validate(
        execution(readCode, {
          automations: 4,
          active: 2,
          running: 1,
          failedLast24Hours: 1,
          definitions: [{ name: "news" }],
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Automation inspection eval did not return the exact bounded overview counts",
    });
  });
});

describe("workspace unit diagnostics semantic validators", () => {
  const listTest = unitDiagnosticsTests.find(
    (candidate) => candidate.name === "unit-list-inspect"
  )!;

  it("accepts natural prose backed by list and detail inspection evidence", () => {
    expect(
      listTest.validate(
        execution(
          "const units = await runtime.supervision.list(); const detail = await runtime.supervision.health(units[0].identity, { limit: 5, errorLimit: 2 }); return { units: units.length, detail };",
          { units: 3, detail: { status: "running" } },
          "There are 3 workspace units available; the representative unit I inspected is running."
        )
      )
    ).toEqual({ passed: true });
  });

  it("rejects the same natural claim when the detail inspection was fabricated", () => {
    expect(
      listTest.validate(
        execution(
          "return { units: 3, detail: { status: 'running' } };",
          { units: 3, detail: { status: "running" } },
          "There are 3 workspace units available; the representative unit I inspected is running."
        )
      )
    ).toMatchObject({ passed: false });
  });
});
