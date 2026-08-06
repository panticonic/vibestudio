import type { TestCase } from "../types.js";
import { PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import { findLastAgentMessage, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

function semanticEval(
  result: Parameters<typeof noIncompleteInvocations>[0],
  codePatterns: RegExp[],
  finalPatterns: RegExp[],
  evidencePatterns: RegExp[] = []
) {
  const calls = getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  const code = calls.map((call) => String(call.arguments?.["code"] ?? "")).join("\n");
  if (calls.length === 0 || !codePatterns.every((pattern) => pattern.test(code))) {
    return {
      passed: false,
      reason: "Canonical eval arguments did not exercise the required runtime capability",
    };
  }
  const evidence = calls.map((call) => JSON.stringify(call.execution?.result ?? null)).join("\n");
  if (!evidencePatterns.every((pattern) => pattern.test(evidence))) {
    return {
      passed: false,
      reason: "Canonical eval results omitted the required runtime observation",
    };
  }
  const final = findLastAgentMessage(result);
  if (!finalPatterns.every((pattern) => pattern.test(final))) {
    return {
      passed: false,
      reason: "Final response did not semantically report the observed runtime outcome",
    };
  }
  return noIncompleteInvocations(result);
}

function channelInspectionIsBounded(result: Parameters<typeof findLastAgentMessage>[0]) {
  const message = findLastAgentMessage(result);
  const boundedCall = getToolCalls(result).some((call) => {
    if (call.name !== "eval" || call.execution?.status !== "complete" || call.execution.isError) {
      return false;
    }
    const code = typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : "";
    const boundedChannelInspector =
      /inspectChannelEnvelopes/.test(code) || /inspectAgentHealth/.test(code);
    const positiveLimit = /\b(?:envelopeLimit|limit)\s*:\s*[1-9]\d*\b/.test(code);
    return boundedChannelInspector && positiveLimit;
  });
  if (!boundedCall) {
    return {
      passed: false,
      reason: "Canonical eval arguments did not contain a positive channel-inspection limit",
    };
  }
  if (
    !/channel/iu.test(message) ||
    !/(envelope|histor|message|none|empty|found|result)/iu.test(message)
  ) {
    return {
      passed: false,
      reason: "Final response did not report the bounded channel-inspection outcome",
    };
  }
  return noIncompleteInvocations(result);
}

function runtimeVcsIsUsable(result: Parameters<typeof findLastAgentMessage>[0]) {
  const directVcsCall = getToolCalls(result).some(
    (call) =>
      call.name === "vcs" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  if (!directVcsCall) {
    return semanticEval(
      result,
      [/\bvcs\b/iu],
      [/version.control|\bvcs\b/iu, /available|usable|present|exposed/iu]
    );
  }
  const final = findLastAgentMessage(result);
  if (
    !/version.control|\bvcs\b/iu.test(final) ||
    !/available|usable|present|exposed/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "Final response did not semantically report the observed VCS capability",
    };
  }
  return noIncompleteInvocations(result);
}

export const agenticRuntimeTests: TestCase[] = [
  {
    name: "state-args-immediate-snapshot",
    description: "Panel state changes are immediately observable",
    category: "agentic-runtime",
    resources: [PANEL_AUTOMATION_RESOURCE],
    authorityPolicy: {
      authority: [
        {
          ruleId: "manage-panel-state",
          capability: { kind: "exact", key: "workspace.runtime-state.manage" },
          resource: { kind: "exact", key: "workspace.runtime-state.manage" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Use the top-level openPanel API (not runtime.openPanel) to open a disposable about/new root with focus:false, then open panels/spectrolite as its child with stateArgs { tiny: 'start' } and focus:false. On that returned handle, call stateArgs.get, stateArgs.set({ tiny: 'updated', seq: 1 }), and stateArgs.get again. Close the child and root, then report the observed before/set/after values.",
    validate: (result) =>
      semanticEval(
        result,
        [/stateArgs/iu, /(?:set|update|change)/iu],
        [/state/iu, /immediate|visible|observed/iu]
      ),
  },
  {
    name: "runtime-vcs-client-helper",
    description: "Workspace VCS operations are usable from the runtime context",
    category: "agentic-runtime",
    prompt:
      "Is the workspace version-control client available in this runtime context? Check and report what you observe.",
    validate: runtimeVcsIsUsable,
  },
  {
    name: "gad-status-summary",
    description: "GAD status metrics are readable through the typed runtime client",
    category: "agentic-runtime",
    prompt:
      "Read the graph-and-data store's compact status metrics through its typed runtime client and summarize one returned metric.",
    validate: (result) =>
      semanticEval(
        result,
        [/gad\.status/iu],
        [/status|metric/iu, /result|value|returned/iu],
        [/metric/iu, /value/iu]
      ),
  },
  {
    name: "channel-envelope-inspection-bounded",
    description: "Channel history inspection stays usable",
    category: "agentic-runtime",
    prompt:
      "Check a harmless nonexistent channel's history without making an unbounded request, and tell me what is there.",
    validate: channelInspectionIsBounded,
  },
  {
    name: "large-eval-result-terminal",
    description:
      "Large eval results complete visibly without leaving an invocation spinner pending",
    category: "agentic-runtime",
    prompt:
      "Create a temporary value containing two thousand items, but report only a concise summary rather than dumping the value.",
    validate: (result) =>
      semanticEval(
        result,
        [/2000|2_000/u],
        [/(?:2000|2[,\s]000|two thousand)/iu, /summar|items?|entries|values/iu]
      ),
  },
  {
    name: "agent-debug-state-method",
    description: "Agent debug state is inspectable",
    category: "agentic-runtime",
    prompt:
      "Check whether this chat agent exposes debug state and report either what is available or that the capability is unavailable.",
    validate: (result) =>
      semanticEval(
        result,
        [/(?:debugState|getDebugState|debug state|agent\.describe)/iu],
        [/debug/iu, /available|unavailable|exposed|not exposed/iu]
      ),
  },
  {
    name: "turn-no-silent-stall-after-tool",
    description:
      "A normal tool-using turn ends with a visible assistant response and no pending invocation",
    category: "agentic-runtime",
    prompt:
      "Use an appropriate read-only tool for a trivial check, then give me a visible final response.",
    validate: (result) => {
      const completed = getToolCalls(result).some(
        (call) => call.execution?.status === "complete" && call.execution.isError !== true
      );
      if (!completed)
        return {
          passed: false,
          reason: "No successful tool invocation preceded the final response",
        };
      if (findLastAgentMessage(result).trim().length < 8)
        return { passed: false, reason: "No substantive visible final response" };
      return noIncompleteInvocations(result);
    },
  },
  {
    name: "workspace-test-runner-extension",
    description: "Agent runs workspace unit tests through the scoped test-runner extension",
    category: "agentic-runtime",
    authorityPolicy: {
      authority: [
        {
          ruleId: "workspace-test-runner-execution",
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
    prompt:
      "Run extensions/test-runner/index.test.ts using the workspace's supported scoped test-running capability, without shelling out. Summarize how many tests passed and failed and identify the execution context.",
    validate: (result) =>
      semanticEval(
        result,
        [
          /@workspace-extensions\/test-runner/u,
          /\btarget\s*:\s*["']extensions\/test-runner["']/u,
          /\bfileFilter\s*:\s*["']index\.test\.ts["']/u,
        ],
        [/pass/iu, /fail/iu, /context/iu],
        [
          /"passed"\s*:\s*[1-9]\d*/u,
          /"failed"\s*:\s*0/u,
          /"total"\s*:\s*[1-9]\d*/u,
          /"contextId"\s*:\s*"[^"]+"/u,
        ]
      ),
  },
];
