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

function automationInspectionChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const code = successfulEvalCode(result);
  if (
    evalCalls.length !== 1 ||
    !code.includes("vibestudio.missions.v1") ||
    !/\boverview\b/u.test(code)
  ) {
    return {
      passed: false,
      reason: "Expected exactly one successful eval reading the automation overview",
    };
  }
  const allEvalCode = getToolCalls(result)
    .filter((call) => call.name === "eval")
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
  if (
    /\b(?:runNow|pause|resume|retire|requestReview|createDraft|proposeDraft|edit)\b/u.test(
      allEvalCode
    )
  ) {
    return { passed: false, reason: "Automation inspection probe attempted a mutating operation" };
  }
  if (!successfulEvalReturnValues(result).some(isExactAutomationCounts)) {
    return {
      passed: false,
      reason: "Automation inspection eval did not return the exact bounded overview counts",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/automation/iu.test(final) ||
    !/active/iu.test(final) ||
    !/fail/iu.test(final) ||
    !/\d/u.test(final)
  ) {
    return {
      passed: false,
      reason: "Final response did not report the observed automation counts",
    };
  }
  return noIncompleteInvocations(result);
}

function isExactAutomationCounts(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "active,automations,failedLast24Hours,running" &&
    ["active", "automations", "failedLast24Hours", "running"].every(
      (key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0
    )
  );
}

function automationInlineEvalDraftChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const draft = successfulEvalReturnValues(result).find(isDailyProjectPulseDraft);
  if (!draft) {
    return {
      passed: false,
      reason: "No successful eval returned the requested inert inline-eval automation draft",
    };
  }
  const code = successfulEvalCode(result);
  if (/\b(?:requestReview|runNow)\b/u.test(code)) {
    return {
      passed: false,
      reason: "The automation draft scenario attempted to activate or run the automation",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/review/iu.test(final) || !/(?:draft|inert|waiting)/iu.test(final)) {
    return {
      passed: false,
      reason: "Final response did not explain that the automation remains inert pending review",
    };
  }
  return noIncompleteInvocations(result);
}

function isDailyProjectPulseDraft(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const charter = record["charter"];
  if (!charter || typeof charter !== "object" || Array.isArray(charter)) return false;
  const charterRecord = charter as Record<string, unknown>;
  const trigger = charterRecord["trigger"] as Record<string, unknown> | undefined;
  const execution = charterRecord["execution"] as Record<string, unknown> | undefined;
  const target = execution?.["target"] as Record<string, unknown> | undefined;
  const action = execution?.["action"] as Record<string, unknown> | undefined;
  const conversation = execution?.["conversation"] as Record<string, unknown> | undefined;
  const exposure = execution?.["toolExposure"] as Record<string, unknown> | undefined;
  const source = action?.["code"];
  return (
    record["name"] === "Daily project pulse" &&
    record["state"] === "draft" &&
    trigger?.["kind"] === "schedule" &&
    trigger["everyMs"] === 86_400_000 &&
    execution?.["kind"] === "agent" &&
    target?.["source"] === "workers/agent-worker" &&
    target["className"] === "AiChatWorker" &&
    action?.["kind"] === "eval" &&
    typeof source === "string" &&
    /services\.vcs\.status/u.test(source) &&
    /chat\.publish/u.test(source) &&
    conversation?.["mode"] === "fresh" &&
    exposure?.["evalNetwork"] === "none" &&
    Array.isArray(exposure["services"]) &&
    exposure["services"].includes("vcs.status") &&
    Array.isArray(record["permissions"]) &&
    record["permissions"].length === 0
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
        [/runtime\.supervision\.list/iu, /runtime\.supervision\.(?:describe|health)/iu],
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
        [/runtime\.supervision\.health/iu, /\b(?:limit|errorLimit)\s*:/u],
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
        [/build\.listUnits/iu, /runtime\.supervision\.versions/iu],
        [/version/iu, /active|current/iu, /\d/u]
      ),
  },
  {
    name: "automation-overview-readonly",
    description: "Inspect the canonical automation ledger without mutating it",
    category: "unit-diagnostics",
    prompt:
      "How many automations are configured, active, running, or failed in the last 24 hours? Inspect the automation overview, report only those counts, and do not change or run anything.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "read-automation-overview",
          capability: { kind: "exact", key: "workspace-service:missions" },
          resource: {
            kind: "prefix",
            prefix: "do:vibestudio/internal:MissionsDO:",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    validate: automationInspectionChecked,
  },
  {
    name: "automation-inline-eval-draft",
    description: "Agent proposes a reviewed recurring inline eval without publishing a worker",
    category: "unit-diagnostics",
    prompt:
      "Please set up a daily automation named ‘Daily project pulse’. It should use a lightweight inline script—not a new code project or a model call—to inspect current project status and publish a concise status event into that run's conversation. Keep it offline, isolate each run in a fresh conversation, and leave it waiting for me to review rather than activating or running it.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "propose-automation-draft",
          capability: { kind: "exact", key: "workspace-service:missions" },
          resource: {
            kind: "prefix",
            prefix: "do:vibestudio/internal:MissionsDO:",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    validation: "agent-evidence",
    validate: automationInlineEvalDraftChecked,
  },
];
