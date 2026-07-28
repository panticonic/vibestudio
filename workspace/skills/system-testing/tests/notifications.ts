import type { TestCase, TestExecutionResult } from "../types.js";
import {
  findLastAgentMessage,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function notificationChecked(
  result: TestExecutionResult,
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

  const code = successfulEvalCode(result);
  if (
    !/(?:notifications\.show|["']notification\.show["'])/u.test(code) ||
    !/(?:notifications\.dismiss|["']notification\.dismiss["'])/u.test(code)
  ) {
    return {
      passed: false,
      reason: "Expected a successful eval showing and dismissing the notification",
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
  const records = values.flatMap((value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? [value as Record<string, unknown>]
      : []
  );
  const hasCreatedProof = records.some((record) => {
    if (record["shown"] === true || record["created"] === true) return true;
    return Object.entries(record).some(
      ([key, value]) =>
        /^(?:id|notification.*id|shown.*id)$/iu.test(key) &&
        typeof value === "string" &&
        value.length > 0
    );
  });
  if (!hasCreatedProof) {
    return { passed: false, reason: "Notification eval returned no display-and-cleanup proof" };
  }
  return noIncompleteInvocations(result);
}

export const notificationTests: TestCase[] = [
  {
    name: "show-notification",
    description: "Show and clean up one host notification",
    category: "notifications",
    prompt:
      "Show a harmless temporary informational notification, confirm it was created, then dismiss it so nothing is left behind.",
    validate: (result) => notificationChecked(result),
  },
  {
    name: "show-with-actions",
    description: "Show and clean up a notification with exactly two action buttons",
    category: "notifications",
    prompt:
      "Show a temporary notification offering exactly two choices, Accept and Decline. Confirm it was displayed and clean it up afterward; do not claim that the user clicked either choice.",
    validate: (result) =>
      notificationChecked(result, { actionCount: 2, actionLabels: ["Accept", "Decline"] }),
  },
];
