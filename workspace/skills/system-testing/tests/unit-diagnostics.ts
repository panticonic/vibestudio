import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function semanticUnitInspection(
  result: Parameters<typeof noIncompleteInvocations>[0],
  requiredCode: RegExp[],
  finalClaims: RegExp[]
) {
  const code = successfulEvalCode(result);
  if (!requiredCode.every((pattern) => pattern.test(code))) {
    return {
      passed: false,
      reason: "Successful eval evidence omitted a required unit diagnostic surface",
    };
  }
  const final = findLastAgentMessage(result);
  if (!finalClaims.every((pattern) => pattern.test(final))) {
    return {
      passed: false,
      reason: "Final response did not report the observed unit diagnostics semantically",
    };
  }
  return noIncompleteInvocations(result);
}

function scheduleInspectionChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const code = successfulEvalCode(result);
  if (
    evalCalls.length !== 1 ||
    !code.includes("workspace.recurring.list") ||
    !code.includes("workspace.heartbeats.list")
  ) {
    return {
      passed: false,
      reason: "Expected exactly one successful eval inspecting recurring jobs and heartbeats",
    };
  }
  const allEvalCode = getToolCalls(result)
    .filter((call) => call.name === "eval")
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
  if (/heartbeats\.(?:runNow|pause|resume)|recurring\.(?:runNow|pause|resume)/u.test(allEvalCode)) {
    return { passed: false, reason: "Schedule inspection probe attempted a mutating operation" };
  }
  if (!successfulEvalReturnValues(result).some(isExactScheduleCounts)) {
    return {
      passed: false,
      reason:
        "Schedule inspection eval did not return exact nonnegative recurring/heartbeat counts",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/recurring/iu.test(final) || !/heartbeat/iu.test(final) || !/\d/u.test(final)) {
    return { passed: false, reason: "Final response did not report both observed schedule counts" };
  }
  return noIncompleteInvocations(result);
}

function isExactScheduleCounts(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "heartbeats,recurring" &&
    Number.isSafeInteger(record["recurring"]) &&
    (record["recurring"] as number) >= 0 &&
    Number.isSafeInteger(record["heartbeats"]) &&
    (record["heartbeats"] as number) >= 0
  );
}

export const unitDiagnosticsTests: TestCase[] = [
  {
    name: "unit-list-inspect",
    description: "List running workspace units and inspect one of them",
    category: "unit-diagnostics",
    prompt:
      "Which workspace units are currently running? Inspect one representative unit in more detail and summarize what you observed.",
    validate: (result) =>
      semanticUnitInspection(
        result,
        [/workspace\.units\.list/iu, /workspace\.units\.(?:diagnostics|inspector)/iu],
        [/unit/iu, /running|available|status/iu, /\d/u]
      ),
  },
  {
    name: "unit-diagnostics-error-buffer",
    description: "Read a unit's persisted logs and its separate error buffer",
    category: "unit-diagnostics",
    prompt:
      "For one running workspace unit, summarize a bounded slice of its recent persisted logs and its separate error buffer.",
    validate: (result) =>
      semanticUnitInspection(
        result,
        [/workspace\.units\.diagnostics/iu, /\b(?:limit|errorLimit)\s*:/u],
        [/log/iu, /error/iu, /\d/u]
      ),
  },
  {
    name: "unit-versions",
    description: "Report the version history of a workspace unit",
    category: "unit-diagnostics",
    prompt:
      "Pick a workspace unit and tell me how many recorded versions it has and which version is currently active.",
    validate: (result) =>
      semanticUnitInspection(
        result,
        [/workspace\.units\.versions/iu],
        [/version/iu, /active|current/iu, /\d/u]
      ),
  },
  {
    name: "schedule-surfaces-readonly",
    description: "Inspect recurring jobs and agent heartbeats without mutating them",
    category: "unit-diagnostics",
    prompt:
      "What recurring jobs and agent heartbeats are configured in this workspace? Report only their counts and do not pause, resume, or run anything.",
    validate: scheduleInspectionChecked,
  },
];
