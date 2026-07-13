import type { TestCase } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  finalMessageHasMarkerCount,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const agentCapabilityTests: TestCase[] = [
  {
    name: "multi-turn",
    description: "Agent stores something in scope and retrieves it later",
    category: "agent-capabilities",
    prompt: "Exercise persistent tool scope across steps. Finish with AGENT_SCOPE_OK and marker-match.",
    validate: (result) => checked(result, ["AGENT_SCOPE_OK", "marker-match"]),
  },
  {
    name: "error-recovery",
    description: "Agent recovers from a thrown error and retries successfully",
    category: "agent-capabilities",
    prompt: "Exercise recovery after a tool failure. Finish with AGENT_ERROR_RECOVERY_OK and recovered.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "INTENTIONAL_RECOVERY_TEST_FAILURE" }],
    validate: (result) => checked(result, ["AGENT_ERROR_RECOVERY_OK", "recovered"]),
  },
  {
    name: "large-output",
    description: "Agent generates a large data structure and reports on it",
    category: "agent-capabilities",
    prompt: "Exercise summarizing large generated data. Finish with AGENT_LARGE_SUMMARY_OK and count.",
    validate: (result) => {
      const marker = finalMessageHasMarkerCount(result, "AGENT_LARGE_SUMMARY_OK");
      return marker.passed ? noIncompleteInvocations(result) : marker;
    },
  },
  {
    name: "dynamic-import",
    description: "Dynamically import an external package and use it",
    category: "agent-capabilities",
    prompt: "Exercise dynamic import. Finish with AGENT_DYNAMIC_IMPORT_OK or AGENT_DYNAMIC_IMPORT_MISMATCH.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["AGENT_DYNAMIC_IMPORT_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["AGENT_DYNAMIC_IMPORT_MISMATCH"]);
    },
  },
  {
    name: "console-streaming",
    description: "Console output is captured and reported",
    category: "agent-capabilities",
    prompt: "Exercise console capture. Finish with AGENT_CONSOLE_OK and lines:3.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) return { passed: false, reason: "Expected a completed eval call for console streaming" };
      return checked(result, ["AGENT_CONSOLE_OK", "lines:3"]);
    },
  },
  {
    name: "concurrent-scope",
    description: "Multiple scope assignments persist independently",
    category: "agent-capabilities",
    prompt: "Exercise multiple independent persistent scope values. Finish with AGENT_SCOPE_MULTI_OK and values:3.",
    validate: (result) => checked(result, ["AGENT_SCOPE_MULTI_OK", "values:3"]),
  },
];
