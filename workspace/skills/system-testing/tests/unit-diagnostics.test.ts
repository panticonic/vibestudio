import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { unitDiagnosticsTests } from "./unit-diagnostics.js";

function execution(
  code: string,
  returnValue: unknown,
  final = "The workspace has 2 recurring jobs and 1 configured agent heartbeat."
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { id: "prompt", kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        id: "eval",
        kind: "message",
        senderId: "agent",
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
        complete: true,
        content: final,
      },
    ],
  } as TestExecutionResult;
}

const scheduleTest = unitDiagnosticsTests.find(
  (candidate) => candidate.name === "schedule-surfaces-readonly"
)!;

describe("schedule surface system test validator", () => {
  const readCode =
    "const recurring = await workspace.recurring.list(); const heartbeats = await workspace.heartbeats.list(); return { recurring: recurring.length, heartbeats: heartbeats.length };";

  it("requires both typed read-only surfaces and exact bounded counts", () => {
    expect(scheduleTest.validate(execution(readCode, { recurring: 2, heartbeats: 1 }))).toEqual({
      passed: true,
    });
  });

  it("rejects prose-only schedule claims", () => {
    expect(
      scheduleTest.validate(execution("return { recurring: 2, heartbeats: 1 };", {}))
    ).toMatchObject({
      passed: false,
      reason: "Expected exactly one successful eval inspecting recurring jobs and heartbeats",
    });
  });

  it("rejects schedule mutation attempts", () => {
    expect(
      scheduleTest.validate(
        execution(`${readCode}\nawait workspace.heartbeats.runNow('news');`, {
          recurring: 2,
          heartbeats: 1,
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Schedule inspection probe attempted a mutating operation",
    });
  });

  it("rejects raw or extra schedule data", () => {
    expect(
      scheduleTest.validate(
        execution(readCode, { recurring: 2, heartbeats: 1, jobs: [{ name: "news" }] })
      )
    ).toMatchObject({
      passed: false,
      reason:
        "Schedule inspection eval did not return exact nonnegative recurring/heartbeat counts",
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
          "const units = await workspace.units.list(); const detail = await workspace.units.diagnostics(units[0].name, { limit: 5, errorLimit: 2 }); return { units: units.length, detail };",
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
