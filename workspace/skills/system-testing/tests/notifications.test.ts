import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { notificationTests } from "./notifications.js";

function execution(
  code: string,
  returnValue: unknown,
  finalMessage = "The temporary notification was displayed with two choices and then dismissed cleanly."
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
      { id: "final", kind: "message", senderId: "agent", complete: true, content: finalMessage },
    ],
  } as TestExecutionResult;
}

const actionsTest = notificationTests.find((test) => test.name === "show-with-actions")!;
const actionsCode = `
const id = await notifications.show({
  title: "Action system test",
  message: "notification-actions-marker",
  actions: [
    { id: "accept", label: "Accept" },
    { id: "decline", label: "Decline" },
  ],
});
await notifications.dismiss(id);
return { shown: typeof id === "string" && id.length > 0, actions: 2, dismissed: true };
`;

describe("notification system test validators", () => {
  it("accepts one exact two-action show/cleanup round trip", () => {
    expect(
      actionsTest.validate(execution(actionsCode, { shown: true, actions: 2, dismissed: true }))
    ).toEqual({ passed: true });
  });

  it("rejects marker-only notification claims", () => {
    expect(actionsTest.validate(execution("return true;", true))).toMatchObject({
      passed: false,
      reason: "Expected exactly one successful eval showing and dismissing the notification",
    });
  });

  it("rejects the wrong number of authored actions", () => {
    expect(
      actionsTest.validate(
        execution(actionsCode.replace('{ id: "decline", label: "Decline" },', ""), {
          shown: true,
          actions: 2,
          dismissed: true,
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Notification eval authored 1 actions, expected 2",
    });
  });

  it("rejects fabricated user action reports", () => {
    expect(
      actionsTest.validate(
        execution(`${actionsCode}\nawait rpc.call("main", "notification.reportAction", []);`, {
          shown: true,
          actions: 2,
          dismissed: true,
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Notification display probe fabricated a user action",
    });
  });

  it("rejects raw or extra notification return data", () => {
    expect(
      actionsTest.validate(
        execution(actionsCode, {
          shown: true,
          actions: 2,
          dismissed: true,
          notificationId: "notification:secret",
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Notification eval did not return the exact bounded proof",
    });
  });
});
