import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { panelTests } from "./panels.js";

const createPanelTest = panelTests.find((test) => test.name === "create-panel")!;

describe("create-panel validation", () => {
  it("rejects a success marker when the documented panel operations did not complete", () => {
    expect(
      createPanelTest.validate(
        execution('const handle = await openPanel("panels/spectrolite");', "complete")
      )
    ).toMatchObject({ passed: false, reason: expect.stringContaining("lightweightPage") });
  });

  it("rejects screenshot evidence from a failed eval", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/spectrolite");',
        "const page = await handle.cdp.lightweightPage();",
        "await handle.cdp.captureScreenshot({ format: \"png\" });",
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "error"
    );
    expect(createPanelTest.validate(result).passed).toBe(false);
  });

  it("accepts successful open, page, screenshot, and console-history evidence", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/spectrolite");',
        "const page = await handle.cdp.lightweightPage();",
        "await handle.cdp.captureScreenshot({ format: \"png\" });",
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "complete"
    );
    expect(createPanelTest.validate(result)).toEqual({ passed: true });
  });
});

function execution(code: string, status: "complete" | "error"): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        id: "prompt",
        kind: "message",
        senderId: "user",
        complete: true,
        content: "Exercise a child panel.",
      },
      {
        id: "eval-card",
        kind: "message",
        senderId: "agent",
        complete: true,
        content: "",
        contentType: "invocation",
        invocation: {
          id: "call-eval",
          name: "eval",
          status,
          terminalOutcome: status === "complete" ? "success" : "tool_error",
          isError: status === "error",
          arguments: { code },
        },
      } as unknown as TestExecutionResult["messages"][number],
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        complete: true,
        content: "PANEL_OPEN_OK handle=panel-1",
      },
    ],
  } as TestExecutionResult;
}
