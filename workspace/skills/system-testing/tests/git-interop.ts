import {
  findLastAgentMessage,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalObservedValues,
} from "./_helpers.js";
import type { TestCase } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrays(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    found.push(value);
    for (const item of value) arrays(item, found);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) arrays(child, found);
  }
  return found;
}

function exactNumber(message: string, value: number): boolean {
  if (new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message)) return true;
  const word = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ][value];
  return word ? new RegExp(`\\b${word}\\b`, "iu").test(message) : false;
}

function upstreamStatusChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  if (!successfulEvalCode(result).includes("git.upstreamStatus")) {
    return {
      passed: false,
      reason: "No successful canonical Git upstream-status call was observed",
    };
  }
  const rows = successfulEvalObservedValues(result)
    .flatMap((value) => arrays(value))
    .find((items) =>
      items.every(
        (item) =>
          isRecord(item) &&
          (typeof item["repoPath"] === "string" || typeof item["repo"] === "string") &&
          typeof item["state"] === "string"
      )
    );
  if (!rows) return { passed: false, reason: "Git status result contained no canonical row set" };
  const final = findLastAgentMessage(result);
  if (!exactNumber(final, rows.length)) {
    return { passed: false, reason: "Final response did not report the observed upstream count" };
  }
  if (rows.length === 0) {
    return /no|none|zero|not track/iu.test(final)
      ? invocations
      : { passed: false, reason: "Final response did not explain the empty upstream set" };
  }
  return rows.some(
    (item) =>
      isRecord(item) &&
      final.includes(String(item["repoPath"] ?? item["repo"])) &&
      final.toLowerCase().includes(String(item["state"]).toLowerCase())
  )
    ? invocations
    : { passed: false, reason: "Final response did not cite an observed repository and state" };
}

export const gitInteropTests: TestCase[] = [
  {
    name: "git-upstream-status",
    description: "Inspect external Git upstream tracking across workspace repos",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Do any repositories in this workspace track an external Git upstream? Give me a bounded summary of what is tracked and its synchronization state.",
    validate: upstreamStatusChecked,
  },
];
