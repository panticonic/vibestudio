import type { TestResult } from "./types.js";

interface TestkitSummary {
  total: number;
  failed: number;
  errored: number;
}

/** Validate the final fenced testkit summary without parsing invocation JSON. */
export function validateDeterministicSummary(
  messages: Array<{ content?: unknown }>
): TestResult {
  const finalText = [...messages]
    .reverse()
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .find((content) => /```(?:json)?\s*[\s\S]*?```/i.test(content));
  const match = finalText?.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match?.[1]) {
    return { passed: false, reason: "no testkit summary JSON found in agent reply" };
  }
  try {
    const summary = JSON.parse(match[1].trim()) as TestkitSummary;
    const clean = summary.failed === 0 && summary.errored === 0 && summary.total > 0;
    return {
      passed: clean,
      reason: clean
        ? undefined
        : `${summary.failed} failed / ${summary.errored} errored of ${summary.total}`,
      details: { summary },
    };
  } catch {
    return { passed: false, reason: "testkit summary JSON did not parse" };
  }
}
