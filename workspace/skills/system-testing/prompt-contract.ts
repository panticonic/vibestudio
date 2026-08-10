import type { TestCase } from "./types.js";

const AGENT_TOOL_NAME =
  /\b(?:spawn_subagent|inspect_subagent|read_subagent|merge_subagent|close_subagent|cancel_subagent|suspend_turn)\b/u;
const API_CALL =
  /\b(?:extensions\.invoke|services\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|stateArgs\.(?:get|set)|openPanel)\s*\(/u;
const RUNTIME_CONFIG = /\b(?:agentKind|thinkingLevel|launchConfig|preauthorize|timeoutMs)\s*:/u;
const EXACT_CHOREOGRAPHY =
  /\b(?:using exactly one eval call|do not make any other tool call|return exactly\s*\{|call [A-Za-z_][A-Za-z0-9_]* once with)\b/iu;

/**
 * Find answer-bearing implementation detail in a prompt that is supposed to
 * describe a normal user goal. Harness/protocol probes are deliberately
 * outside this contract.
 */
export function agentGoalPromptFindings(prompt: string): string[] {
  const findings: string[] = [];
  if (AGENT_TOOL_NAME.test(prompt)) findings.push("internal agent tool name");
  if (API_CALL.test(prompt)) findings.push("API call expression");
  if (RUNTIME_CONFIG.test(prompt)) findings.push("runtime configuration shape");
  if (EXACT_CHOREOGRAPHY.test(prompt)) findings.push("exact call choreography");
  return findings;
}

/** Fail before provisioning effects when a test declaration crosses layers. */
export function assertSystemTestDeclaration(test: TestCase): void {
  if (test.validation === "harness") {
    if (!test.validate) {
      throw new Error(`Harness system test "${test.name}" has no deterministic validator`);
    }
    return;
  }

  const findings = agentGoalPromptFindings(test.prompt);
  if (findings.length > 0) {
    throw new Error(
      `Agent-goal system test "${test.name}" prescribes ${findings.join(
        ", "
      )}. State the user outcome instead, or make the case an explicit harness/protocol probe.`
    );
  }
}
