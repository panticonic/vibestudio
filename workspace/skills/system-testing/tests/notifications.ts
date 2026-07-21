import type { TestCase, TestExecutionResult } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function notificationChecked(
  result: TestExecutionResult,
  expectedReturn: Record<string, unknown>,
  options: { actionCount?: number; actionLabels?: string[] } = {}
) {
  const final = findLastAgentMessage(result);
  if (
    !/notification/iu.test(final) ||
    !/(shown|displayed|created)/iu.test(final) ||
    !/(dismissed|removed|cleaned|closed)/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "Final response did not semantically report notification display and cleanup",
    };
  }

  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const code = successfulEvalCode(result);
  if (
    evalCalls.length !== 1 ||
    !code.includes("notifications.show") ||
    !code.includes("notifications.dismiss")
  ) {
    return {
      passed: false,
      reason: "Expected exactly one successful eval showing and dismissing the notification",
    };
  }
  if (options.actionCount !== undefined) {
    const actionArray = /actions\s*:\s*\[([\s\S]*?)\]/u.exec(code)?.[1] ?? "";
    const authoredActions = actionArray.match(/\blabel\s*:/gu)?.length ?? 0;
    if (authoredActions !== options.actionCount) {
      return {
        passed: false,
        reason: `Notification eval authored ${authoredActions} actions, expected ${options.actionCount}`,
      };
    }
  }
  if (
    options.actionLabels &&
    !options.actionLabels.every((label) =>
      new RegExp(`\\blabel\\s*:\\s*["']${label}["']`, "iu").test(code)
    )
  ) {
    return { passed: false, reason: "Notification eval omitted a requested action label" };
  }
  if (/notification\.reportAction|notifications\.reportAction/u.test(code)) {
    return { passed: false, reason: "Notification display probe fabricated a user action" };
  }

  const values = successfulEvalReturnValues(result);
  if (values.length !== 1 || !exactRecord(values[0], expectedReturn)) {
    return { passed: false, reason: "Notification eval did not return the exact bounded proof" };
  }
  return noIncompleteInvocations(result);
}

function exactRecord(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(expected).sort();
  return (
    Object.keys(record).sort().join(",") === keys.join(",") &&
    keys.every((key) => record[key] === expected[key])
  );
}

export const notificationTests: TestCase[] = [
  {
    name: "show-notification",
    description: "Show and clean up one host notification",
    category: "notifications",
    prompt:
      "Show a harmless temporary informational notification, confirm it was created, then dismiss it so nothing is left behind.",
    validate: (result) => notificationChecked(result, { shown: true, dismissed: true }),
  },
  {
    name: "show-with-actions",
    description: "Show and clean up a notification with exactly two action buttons",
    category: "notifications",
    prompt:
      "Show a temporary notification offering exactly two choices, Accept and Decline. Confirm it was displayed and clean it up afterward; do not claim that the user clicked either choice.",
    validate: (result) =>
      notificationChecked(
        result,
        { shown: true, actions: 2, dismissed: true },
        { actionCount: 2, actionLabels: ["Accept", "Decline"] }
      ),
  },
];
