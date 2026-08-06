import type { TestCase, TestExecutionResult } from "../types.js";
import { BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function isSuccessful(call: ReturnType<typeof getToolCalls>[number]): boolean {
  return call.execution?.status === "complete" && call.execution.isError !== true;
}

function requireCompletedTools(
  result: TestExecutionResult,
  requirements: Readonly<Record<string, number>>
) {
  const calls = getToolCalls(result);
  const missing = Object.entries(requirements).filter(
    ([toolKey, count]) =>
      calls.filter((call) => {
        if (!isSuccessful(call)) return false;
        const [name, operation] = toolKey.split(".", 2);
        return (
          call.name === name &&
          (operation === undefined || call.arguments?.["operation"] === operation)
        );
      }).length < count
  );
  if (missing.length > 0) {
    return {
      passed: false,
      reason: `Missing completed orchestration calls: ${missing
        .map(([name, count]) => `${name}×${count}`)
        .join(", ")}`,
    };
  }
  return noIncompleteInvocations(result);
}

const VERIFICATION_BOOLEAN_KEY =
  /(?:^|_)(?:all|clean|loaded|match|ok|pass(?:ed)?|ready|success|valid|verified)(?:$|_)/iu;
const VERIFICATION_COVERAGE_KEY =
  /(?:^|_)(?:case|cases|count|coverage|fixture|fixtures|total)(?:$|_)/iu;

function hasStructuredVerificationProof(value: unknown): boolean {
  const evidence = records(value);
  let explicitSuccess = false;
  let positiveCheck = false;
  let positiveCoverage = false;

  for (const record of evidence) {
    const status = record["status"];
    if (
      typeof status === "string" &&
      /^(?:error|fail(?:ed|ure)?|invalid|not-ready)$/iu.test(status)
    ) {
      return false;
    }
    if (
      typeof status === "string" &&
      /^(?:ok|pass(?:ed)?|ready|success)$/iu.test(status)
    ) {
      explicitSuccess = true;
    }
    if (typeof record["diagnostics"] === "number" && record["diagnostics"] > 0) {
      return false;
    }

    for (const [key, child] of Object.entries(record)) {
      const semanticKey = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
      if (VERIFICATION_BOOLEAN_KEY.test(semanticKey) && typeof child === "boolean") {
        if (!child) return false;
        positiveCheck = true;
        if (/^(?:ok|passed|success)$/iu.test(semanticKey)) explicitSuccess = true;
      }
      if (
        VERIFICATION_COVERAGE_KEY.test(semanticKey) &&
        typeof child === "number" &&
        Number.isFinite(child) &&
        child > 0
      ) {
        positiveCoverage = true;
      }
    }
  }

  return explicitSuccess || (positiveCheck && positiveCoverage);
}

const FIXTURE_GENERATOR_MODEL = "openai-codex:gpt-5.3-codex-spark";

function validateCheapFixtureFanout(result: TestExecutionResult) {
  const calls = getToolCalls(result);
  const spawns = calls.filter((call) => call.name === "spawn_subagent" && isSuccessful(call));
  if (spawns.length < 3) {
    return { passed: false, reason: "Expected three completed cheap-model subagent runs" };
  }
  const misconfigured = spawns.filter((call) => {
    const config = call.arguments?.["config"];
    const launchConfig = call.subagent?.launchConfig;
    return (
      !config ||
      typeof config !== "object" ||
      (config as Record<string, unknown>)["model"] !== FIXTURE_GENERATOR_MODEL ||
      (config as Record<string, unknown>)["thinkingLevel"] !== "minimal" ||
      !launchConfig ||
      typeof launchConfig !== "object" ||
      (launchConfig as Record<string, unknown>)["model"] !== FIXTURE_GENERATOR_MODEL ||
      (launchConfig as Record<string, unknown>)["thinkingLevel"] !== "minimal" ||
      call.arguments?.["agentKind"] !== "pi" ||
      call.subagent?.agentKind !== "pi"
    );
  });
  if (misconfigured.length > 0) {
    return {
      passed: false,
      reason:
        "Every fixture-generating Pi child must explicitly launch the cheap Spark model at minimal thinking",
    };
  }

  const orchestration = requireCompletedTools(result, {
    inspect_subagent: 3,
    merge_subagent: 1,
    close_subagent: 3,
    provenance: 1,
    eval: 1,
    "vcs.commit": 1,
  });
  if (!orchestration.passed) return orchestration;

  const integratedSourceEventIds = new Set<string>();
  const latestSubagentIntegrationByRun = new Map<string, Record<string, unknown>>();
  for (const call of calls) {
    if (!isSuccessful(call)) continue;
    if (call.name === "merge_subagent") {
      const runId = call.arguments?.["runId"];
      const details = (call.execution?.result as { details?: unknown } | undefined)?.details;
      if (typeof runId === "string" && details && typeof details === "object") {
        latestSubagentIntegrationByRun.set(runId, details as Record<string, unknown>);
      }
      const integration =
        details && typeof details === "object"
          ? (details as Record<string, unknown>)
          : undefined;
      const sourceEventId = integration?.["sourceEventId"];
      if (typeof sourceEventId === "string") integratedSourceEventIds.add(sourceEventId);
      continue;
    }
    if (call.name === "vcs" && call.arguments?.["operation"] === "merge") {
      const source = call.arguments?.["source"];
      const sourceEventId =
        source && typeof source === "object"
          ? (source as Record<string, unknown>)["eventId"]
          : undefined;
      if (typeof sourceEventId === "string") integratedSourceEventIds.add(sourceEventId);
    }
  }
  const incompleteSubagentIntegration = [...latestSubagentIntegrationByRun.values()].some(
    (integration) =>
      integration["status"] !== "working" && integration["status"] !== "unchanged"
  );
  if (
    latestSubagentIntegrationByRun.size < 1 ||
    incompleteSubagentIntegration ||
    integratedSourceEventIds.size < 3
  ) {
    return {
      passed: false,
      reason:
        "Every fixture child must finish with a fully resolved semantic integration before close",
    };
  }

  const committedIntegrationSources = new Set<string>();
  for (const call of calls) {
    if (
      call.name !== "vcs" ||
      call.arguments?.["operation"] !== "commit" ||
      !isSuccessful(call)
    ) {
      continue;
    }
    const details = (call.execution?.result as { details?: unknown } | undefined)?.details;
    const commitResult =
      details && typeof details === "object"
        ? (details as Record<string, unknown>)["result"]
        : undefined;
    const sources =
      commitResult && typeof commitResult === "object"
        ? (commitResult as Record<string, unknown>)["integrationSourceEventIds"]
        : undefined;
    if (Array.isArray(sources)) {
      for (const source of sources) {
        if (typeof source === "string") committedIntegrationSources.add(source);
      }
    }
  }
  if (
    [...integratedSourceEventIds].some((source) => !committedIntegrationSources.has(source))
  ) {
    return {
      passed: false,
      reason: "The final commit did not preserve every integrated child source as causal lineage",
    };
  }

  const hasExecutableVerification = calls.some((call) => {
    if (call.name !== "eval" || !isSuccessful(call)) return false;
    const details = (call.execution?.result as { details?: unknown } | undefined)?.details;
    if (!details || typeof details !== "object") return false;
    const returnValue = (details as Record<string, unknown>)["returnValue"];
    if (!returnValue || typeof returnValue !== "object") return false;
    return hasStructuredVerificationProof(returnValue);
  });
  if (!hasExecutableVerification) {
    return {
      passed: false,
      reason:
        "Focused verification must execute and return structured evidence, not merely load source text",
    };
  }

  const discarded = calls.some(
    (call) =>
      call.name === "close_subagent" &&
      isSuccessful(call) &&
      (call.arguments?.["discard"] === true ||
        ((call.execution?.result as { details?: unknown } | undefined)?.details as
          | Record<string, unknown>
          | undefined)?.["discarded"] === true)
  );
  if (discarded) {
    return {
      passed: false,
      reason: "Fixture-generating child work must be integrated, not discarded",
    };
  }

  const final = findLastAgentMessage(result);
  if (
    !/(three|3)/iu.test(final) ||
    !/provenance|causal|author/iu.test(final) ||
    !/fixture/iu.test(final)
  ) {
    return {
      passed: false,
      reason:
        "Final response must summarize the three fixture corpora and their provenance evidence",
    };
  }
  return orchestration;
}

function validateClaudeSupervision(result: TestExecutionResult) {
  const spawn = getToolCalls(result).find(
    (call) =>
      call.name === "spawn_subagent" &&
      isSuccessful(call) &&
      call.arguments?.["agentKind"] === "claude-code"
  );
  if (!spawn) {
    return {
      passed: false,
      reason: "Expected one completed external claude-code subagent run",
    };
  }
  const config = spawn.arguments?.["config"];
  if (
    !config ||
    typeof config !== "object" ||
    (config as Record<string, unknown>)["model"] !== "haiku" ||
    (config as Record<string, unknown>)["effort"] !== "low"
  ) {
    return {
      passed: false,
      reason: "Expected the bounded Claude diagnostic to use haiku at low effort",
    };
  }
  const supervised = requireCompletedTools(result, {
    read_subagent: 1,
    inspect_subagent: 2,
    close_subagent: 1,
  });
  if (!supervised.passed) return supervised;
  const inspected = getToolCalls(result).filter(
    (call) => call.name === "inspect_subagent" && isSuccessful(call)
  );
  if (
    !inspected.some((call) => call.arguments?.["query"] === "status") ||
    !inspected.some((call) => call.arguments?.["query"] === "runtime")
  ) {
    return {
      passed: false,
      reason: "Expected both semantic status and provider runtime/log inspection",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/finding|risk|mismatch/iu.test(final) ||
    !/status|clean/iu.test(final) ||
    !/runtime|process|exited|exit code/iu.test(final) ||
    !/cleanup|closed/iu.test(final)
  ) {
    return {
      passed: false,
      reason:
        "Final response did not report Claude's finding, semantic status, runtime evidence, and cleanup",
    };
  }
  return supervised;
}

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) records(child, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  found.push(record);
  for (const child of Object.values(record)) records(child, found);
  return found;
}

function validateTerminalRoundtrip(result: TestExecutionResult) {
  const code = successfulEvalCode(result);
  if (
    !/extensions\.(?:invoke|use)/u.test(code) ||
    !/(?:@workspace-extensions\/)?shell/u.test(code) ||
    !/["']exec["']/u.test(code) ||
    !/agentic-terminal-roundtrip/u.test(code)
  ) {
    return {
      passed: false,
      reason: "A successful eval did not execute the shell extension's argv-mode exec method",
    };
  }
  const observed = records(successfulEvalReturnValues(result)).some(
    (record) =>
      record["exitCode"] === 0 &&
      typeof record["stdout"] === "string" &&
      record["stdout"].includes("agentic-terminal-roundtrip") &&
      record["stderr"] === ""
  );
  if (!observed) {
    return {
      passed: false,
      reason: "The terminal command's zero exit, stdout marker, and empty stderr were not observed",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/agentic-terminal-roundtrip/u.test(final) || !/(exit|status).{0,20}0/iu.test(final)) {
    return {
      passed: false,
      reason: "Final response did not report the observed terminal marker and zero exit",
    };
  }
  return noIncompleteInvocations(result);
}

export const agentOrchestrationTests: TestCase[] = [
  {
    name: "cheap-subagent-fixture-fanout",
    description:
      "Three cheap-model children generate isolated fixture corpora that the parent supervises, integrates, verifies, and traces",
    category: "agent-orchestration",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "fixture-verification-test-execution",
          capability: {
            kind: "prefix",
            prefix: "userland:extensions/test-runner/native.tests.execute#",
          },
          resource: {
            kind: "exact",
            key: "native.tests:extension:@workspace-extensions/test-runner",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt: [
      "Build an extensive generated-fixture suite in the disposable package by delegating three independent workstreams to Pi subagents.",
      "Use a deliberately cheap generation model: for every spawn_subagent call, set agentKind:'pi' and the runtime config object exactly to { model:'openai-codex:gpt-5.3-codex-spark', thinkingLevel:'minimal' }; putting the model name in task text does not configure the child. Confirm each spawn result's launchConfig before supervising it. One child should generate Unicode and serialization edge cases, one state-machine transition cases, and one causality/provenance cases. Each corpus must be substantive, deterministic, typed, and committed in its child context.",
      "Supervise all three runs, inspect both their workspace status and useful task-channel progress, integrate every corpus into this parent context, and close the children only after integration.",
      "Add a small typed index or test that proves all corpora load and have meaningful counts, run the package's focused verification, and commit the integrated result.",
      "Finally inspect provenance for at least one generated fixture file and use the causal evidence to explain which delegated run authored it. Report concrete child run IDs, files, counts, verification, and provenance.",
    ].join(" "),
    validate: validateCheapFixtureFanout,
  },
  {
    name: "claude-subagent-readonly-diagnostic",
    description:
      "A Claude Code child performs a bounded read-only audit while the parent inspects its transcript and context diagnostics",
    category: "agent-orchestration",
    prompt: [
      "Launch one fresh external claude-code subagent with config model haiku and effort low for a bounded read-only audit of the subagent runtime and its documentation.",
      "Ask it to compare the Reading Versus Inspecting section in packages/agentic-do/references/subagents.md with inspectSubagent in packages/agentic-do/src/agent-vessel.ts, identify one concrete developer-ergonomics risk, make no source edits, and complete with exact evidence.",
      "While it works, inspect query runtime for bounded provider process/log evidence. If it is still running and the task channel is quiet, suspend instead of closing it. After completion, read its task-channel report and inspect semantic status yourself. Confirm that the context stayed clean, then close the run without claiming integration.",
      "Report the Claude run ID, its finding, the observed semantic status and runtime-log evidence, and whether cleanup completed.",
    ].join(" "),
    validate: validateClaudeSupervision,
  },
  {
    name: "terminal-extension-capability-acquisition",
    description:
      "A real shell-extension command receives a scoped test approval and returns bounded argv-mode diagnostics",
    category: "agent-orchestration",
    authorityPolicy: {
      authority: [
        {
          ruleId: "terminal-native-execution",
          capability: {
            kind: "prefix",
            prefix: "userland:extensions/shell/native.shell.execute#",
          },
          resource: {
            kind: "exact",
            key: "native.shell:extension:@workspace-extensions/shell",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt: [
      "Exercise the installed shell extension's exec method with a harmless bounded argv-mode command, not shell interpretation.",
      "Use the public eval contract extensions.invoke('shell', 'exec', [request]); do not probe workspace.services or private host APIs.",
      "Run /usr/bin/printf with one argument containing exactly agentic-terminal-roundtrip, use a short explicit timeout, and return the structured result through eval.",
      "Report the exact stdout, stderr, exit code, and whether output was truncated or timed out.",
    ].join(" "),
    validate: validateTerminalRoundtrip,
  },
];
