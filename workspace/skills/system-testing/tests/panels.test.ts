import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { panelTests } from "./panels.js";

const createPanelTest = panelTests.find((test) => test.name === "create-panel")!;

describe("create-panel validation", () => {
  it("preauthorizes inspection of the panel that the unattended test creates", () => {
    expect(createPanelTest.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "manage-panel-state",
          capability: { kind: "exact", key: "workspace.runtime-state.manage" },
          resource: { kind: "exact", key: "workspace.runtime-state.manage" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "manage-panel-context-boundary",
          capability: { kind: "exact", key: "context.boundary" },
          resource: { kind: "prefix", prefix: "context/" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "use-testkit-driver",
          capability: { kind: "exact", key: "workspace-service:testkit-driver" },
          resource: {
            kind: "exact",
            key: "do:workers/testkit-driver:TestkitDriverDO:workspace-testkit-driver",
          },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "inspect-created-panel",
          capability: { kind: "exact", key: "panel.inspect" },
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    });
  });

  it("rejects a success marker when the documented panel operations did not complete", () => {
    expect(
      createPanelTest.validate(
        execution('const handle = await openPanel("panels/chat");', "complete")
      )
    ).toMatchObject({ passed: false, reason: expect.stringContaining(".cdp.page(") });
  });

  it("rejects screenshot evidence from a failed eval", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/chat");',
        "const page = await handle.cdp.page();",
        'await handle.cdp.screenshot({ format: "png" });',
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "error"
    );
    expect(createPanelTest.validate(result).passed).toBe(false);
  });

  it("accepts successful open, page, screenshot, and console-history evidence", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/chat");',
        "const page = await handle.cdp.page();",
        'await handle.cdp.screenshot({ format: "png" });',
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "complete",
      true,
      "PANEL_OPEN_OK handle=panel-1; visible label: Agentic Chat"
    );
    expect(createPanelTest.validate(result)).toEqual({ passed: true });
  });

  it("accepts diagnose as the canonical bounded host-console packet", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/chat");',
        "const page = await handle.cdp.page();",
        'await page.screenshot({ format: "png" });',
        "const diagnostics = await handle.diagnose();",
        "return diagnostics.consoleHistory;",
      ].join("\n"),
      "complete",
      true,
      "PANEL_OPEN_OK handle=panel-1; visible label: Agentic Chat"
    );
    expect(createPanelTest.validate(result)).toEqual({ passed: true });
  });

  it("rejects image evidence without a page-specific visible fact", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/chat");',
        "const page = await handle.cdp.page();",
        'await handle.cdp.screenshot({ format: "png" });',
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "complete",
      true
    );
    expect(createPanelTest.validate(result)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("Agentic Chat"),
    });
  });

  it("rejects a screenshot that was never read as image content", () => {
    const result = execution(
      [
        'const handle = await openPanel("panels/chat");',
        "const page = await handle.cdp.page();",
        'await handle.cdp.screenshot({ format: "png" });',
        "await handle.cdp.consoleHistory();",
      ].join("\n"),
      "complete",
      false,
      "PANEL_OPEN_OK handle=panel-1; visible label: Agentic Chat"
    );
    expect(createPanelTest.validate(result)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("read it as image content"),
    });
  });
});

function execution(
  code: string,
  status: "complete" | "error",
  includeImageRead = false,
  finalContent = "PANEL_OPEN_OK handle=panel-1"
): TestExecutionResult {
  const messages: TestExecutionResult["messages"] = [
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
  ];
  if (includeImageRead) {
    messages.push({
      id: "read-card",
      kind: "message",
      senderId: "agent",
      complete: true,
      content: "",
      contentType: "invocation",
      invocation: {
        id: "call-read",
        name: "read",
        status: "complete",
        terminalOutcome: "success",
        arguments: { target: "file:panel-capture", kind: "file" },
        result: {
          details: { mimeType: "image/png", size: 4096 },
        },
      },
    } as unknown as TestExecutionResult["messages"][number]);
  }
  messages.push({
    id: "final",
    kind: "message",
    senderId: "agent",
    complete: true,
    content: finalContent,
  });
  return {
    duration: 0,
    messages,
  } as TestExecutionResult;
}
