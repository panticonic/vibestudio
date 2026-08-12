import type { TestCase } from "../types.js";
import {
  failedToolCalls,
  finalMessageHasAll,
  findLastAgentMessage,
  getToolCalls,
  hasSuccessfulImageRead,
  noIncompleteInvocations,
} from "./_helpers.js";
import {
  classifyBuiltInToolFailure,
  isUnexpectedToolFailure,
} from "../tool-failure-classification.js";
import {
  panelControlAuthorityPolicy,
  PANEL_AUTOMATION_RESOURCE,
  PANEL_RUNTIME_SUPERVISION_AUTHORITY,
} from "../panel-authority.js";
import { orchestratePanelGoal } from "./_panel-tree-invariant.js";

const WORKSPACE_RELOAD_PROFILE_PROMPT =
  "Profile a real reload of a small disposable workspace panel. I want a bounded report that makes clear the reload actually happened and separates overall latency, loading, network activity, and page responsiveness costs.";

const BROWSER_CLICK_PROFILE_PROMPT =
  "Profile one click on a tiny disposable browser page whose visible state changes when clicked. Give me a bounded latency report covering the overall action, runtime work, network activity, page responsiveness, and the final visible state without collecting unrelated data that would distort the measurement.";

const BROWSER_AUTOMATION_PROMPT =
  "On a tiny disposable browser page, click an element, capture and inspect what the page actually rendered, and evaluate a value from it. Report the exact visible status after the click and what succeeded.";

const BROWSER_CONSOLE_PROMPT =
  "Inspect a tiny disposable browser page. Check both its live and retained console evidence along with its visible document state, then report what you observe.";

const PANEL_STATE_PROMPT =
  "Open a workspace panel with a small initial launch state, change that state, and inspect what the panel exposes immediately afterward. Tell me whether the change is visible.";

interface ToolFailureLike {
  name: string;
  status?: string;
  terminalOutcome?: string;
  error?: string;
  resultSummary?: string;
  source?: string;
}

const IMPOSSIBLE_SUCCESS_PHRASES = [
  "not reachable",
  "unreachable",
  "unable to",
  "failed to",
  "could not",
  "ok:false",
  "ok false",
  "no cdp-capable",
  "does not expose dom",
];

const GAD_INTEGRITY_CLAIMS = [
  /storage/iu,
  /publication/iu,
  /turn/iu,
  /invocation/iu,
  /hash/iu,
  /integrity/iu,
];

function checked(
  result: Parameters<typeof finalMessageHasAll>[0],
  finalClaims: RegExp[],
  evidenceClaims: RegExp[],
  options: { allowInFlightHealthOkFalse?: boolean } = {}
) {
  const final = findLastAgentMessage(result);
  if (!finalClaims.every((pattern) => pattern.test(final))) {
    return {
      passed: false,
      reason: "Final response did not semantically report every requested diagnostic outcome",
    };
  }

  const incomplete = noIncompleteInvocations(result);
  if (!incomplete.passed) return incomplete;

  const failed = unexpectedToolFailures(result);
  if (failed.length > 0) {
    return {
      passed: false,
      reason: `Expected no failed tool calls, got ${failed.map(formatToolFailure).join(", ")}`,
    };
  }

  const evalEvidence = getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .map(
      (call) =>
        `${JSON.stringify(call.arguments ?? {})}\n${JSON.stringify(call.execution?.result ?? null)}`
    )
    .join("\n");
  if (!evalEvidence || !evidenceClaims.every((pattern) => pattern.test(evalEvidence))) {
    return {
      passed: false,
      reason: "Canonical eval arguments/results omitted requested diagnostic evidence",
    };
  }

  const okFalsePath = firstOkFalsePath(result);
  if (okFalsePath) {
    return {
      passed: false,
      reason: `Final success claim conflicts with ok:false diagnostic result at ${okFalsePath}`,
    };
  }

  const impossible = impossibleSuccessPhrase(result);
  if (impossible) {
    if (
      impossible === "ok:false" &&
      options.allowInFlightHealthOkFalse &&
      hasExpectedInFlightHealthEvidence(result)
    ) {
      return { passed: true };
    }
    return {
      passed: false,
      reason: `Final success claim conflicts with failure wording "${impossible}"`,
    };
  }

  return { passed: true };
}

function checkedGadIntegrity(result: Parameters<typeof finalMessageHasAll>[0]) {
  const final = findLastAgentMessage(result);
  if (
    !GAD_INTEGRITY_CLAIMS.every((pattern) => pattern.test(final)) &&
    !expectedLiveGadHealthOutcome(result)
  ) {
    return { passed: false, reason: "Final response omitted part of the GAD health assessment" };
  }
  const incomplete = noIncompleteInvocations(result);
  if (!incomplete.passed) return incomplete;
  const failed = unexpectedToolFailures(result);
  if (failed.length > 0) {
    return {
      passed: false,
      reason: `Expected no failed tool calls, got ${failed.map(formatToolFailure).join(", ")}`,
    };
  }
  const evidence = collectInvocationResultText(result);
  if (
    !evidence ||
    ![/storage/iu, /publication/iu, /turn/iu, /invocation/iu, /hash/iu, /integrity/iu].every(
      (pattern) => pattern.test(evidence)
    )
  ) {
    return {
      passed: false,
      reason: "Canonical eval results omitted a complete GAD health assessment",
    };
  }
  // This test validates the diagnostic surface, not that the live trajectory
  // being diagnosed is perfectly quiescent. `ok:false` is legitimate data for
  // an open turn/current invocation or a discovered integrity finding; it is
  // not a tool failure and must not contradict successful diagnostic execution.
  return { passed: true };
}

function unexpectedToolFailures(
  result: Parameters<typeof finalMessageHasAll>[0]
): ToolFailureLike[] {
  const fromMessages = failedToolCalls(result)
    .filter(isUnexpectedInvocation)
    .map((call) => ({
      name: call.name,
      status: call.execution?.status,
      terminalOutcome: call.execution?.terminalOutcome,
      error: invocationErrorText(call.execution?.result),
      source: "message",
    }));
  const fromRunner = (result.toolFailures ?? []).filter(isUnexpectedToolFailure).map((failure) => ({
    name: failure.name,
    status: failure.status,
    terminalOutcome: failure.terminalOutcome,
    error: failure.error,
    resultSummary: failure.resultSummary,
    source: failure.source,
  }));
  const fromTerminalOutcomes = getToolCalls(result)
    .filter(
      (call) =>
        /error|fail/i.test(call.execution?.terminalOutcome ?? "") && isUnexpectedInvocation(call)
    )
    .map((call) => ({
      name: call.name,
      status: call.execution?.status,
      terminalOutcome: call.execution?.terminalOutcome,
      error: invocationErrorText(call.execution?.result),
      source: "message",
    }));
  return dedupeFailures([...fromMessages, ...fromRunner, ...fromTerminalOutcomes]);
}

function isUnexpectedInvocation(call: {
  name: string;
  error?: unknown;
  description?: string;
  result?: unknown;
  failureKind?: string;
  failureCode?: string;
  terminalReasonCode?: string;
  execution?: {
    error?: unknown;
    description?: string;
    result?: unknown;
    failureKind?: string;
    failureCode?: string;
    terminalReasonCode?: string;
  };
}): boolean {
  const execution = call.execution;
  const result = execution?.result ?? call.result;
  const details =
    result && typeof result === "object" && !Array.isArray(result) && "details" in result
      ? (result as Record<string, unknown>)["details"]
      : undefined;
  const nestedFailure =
    details && typeof details === "object" && !Array.isArray(details) && "failure" in details
      ? (details as Record<string, unknown>)["failure"]
      : undefined;
  const failureDetails =
    nestedFailure && typeof nestedFailure === "object" && !Array.isArray(nestedFailure)
      ? (nestedFailure as Record<string, unknown>)
      : undefined;
  const stringField = (record: Record<string, unknown> | undefined, key: string) => {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
  };
  return (
    classifyBuiltInToolFailure({
      name: call.name,
      terminalReasonCode: execution?.terminalReasonCode ?? call.terminalReasonCode,
      failureCode:
        execution?.failureCode ??
        call.failureCode ??
        stringField(
          details && typeof details === "object" && !Array.isArray(details)
            ? (details as Record<string, unknown>)
            : undefined,
          "failureCode"
        ) ??
        stringField(failureDetails, "failureCode"),
      failureKind:
        execution?.failureKind ??
        call.failureKind ??
        stringField(
          details && typeof details === "object" && !Array.isArray(details)
            ? (details as Record<string, unknown>)
            : undefined,
          "failureKind"
        ) ??
        stringField(failureDetails, "failureKind"),
      error: execution?.error ?? call.error,
      result,
      description: execution?.description ?? call.description,
    }) === null
  );
}

function firstOkFalsePath(result: Parameters<typeof finalMessageHasAll>[0]): string | undefined {
  // A contradiction must come from executed diagnostic evidence. Source/document
  // reads routinely contain examples and implementation branches with `ok:false`;
  // treating those bytes as the test's runtime outcome makes successful CDP
  // probes fail merely because the agent inspected the implementation first.
  const calls = getToolCalls(result).filter((call) => call.name === "eval");
  for (const [index, call] of calls.entries()) {
    const path = findOkFalse(
      call.execution?.result,
      `messages[${index}].${call.name}.execution.result`
    );
    if (path) return path;
  }

  for (const [index, invocation] of (result.snapshot?.invocations ?? []).entries()) {
    if (invocation.name !== "eval") continue;
    for (const [suffix, value] of invocationResultCandidates(invocation)) {
      const path = findOkFalse(value, `snapshot.invocations[${index}].${suffix}`);
      if (path) return path;
    }
  }
  return undefined;
}

function invocationResultCandidates(invocation: unknown): Array<[string, unknown]> {
  if (!invocation || typeof invocation !== "object") return [];
  const record = invocation as Record<string, unknown>;
  const execution =
    record["execution"] && typeof record["execution"] === "object"
      ? (record["execution"] as Record<string, unknown>)
      : undefined;
  return [
    ["execution.result", execution?.["result"]],
    ["result", record["result"]],
  ].filter((candidate): candidate is [string, unknown] => candidate[1] !== undefined);
}

function findOkFalse(value: unknown, path: string, seen = new Set<unknown>()): string | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonish(value);
    if (parsed !== undefined) return findOkFalse(parsed, path, seen);
    if (/"?ok"?\s*[:=]\s*false|ok false/i.test(value)) {
      if (looksLikeControlledOkFalseText(value) || looksLikeExpectedInFlightHealthText(value)) {
        return undefined;
      }
      return path;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (
    !Array.isArray(value) &&
    (isExpectedControlledRejectionRecord(value as Record<string, unknown>, path) ||
      isExpectedInFlightHealthRecord(value as Record<string, unknown>))
  ) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findOkFalse(item, `${path}[${index}]`, seen);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key === "ok" && item === false) return childPath;
    const found = findOkFalse(item, childPath, seen);
    if (found) return found;
  }
  return undefined;
}

function isExpectedInFlightHealthRecord(record: Record<string, unknown>): boolean {
  if (record["ok"] !== false) return false;
  const openTurns = Number(record["openTurns"] ?? 0);
  const openInvocations = Number(
    record["nonterminalInvocations"] ?? record["openProjectedInvocations"] ?? 0
  );
  if (openTurns <= 0 && openInvocations <= 0) return false;

  const issueFields = [
    "publicationIssues",
    "storageIssues",
    "missingMappings",
    "orphanMappings",
    "sequenceMismatches",
    "hashIssues",
    "integrityIssues",
  ];
  const present = issueFields.filter((field) => record[field] !== undefined);
  return present.length > 0 && present.every((field) => Number(record[field]) === 0);
}

function parseJsonish(value: string): unknown {
  let text = value.trim();
  const marker = "[eval] Return value:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length).trim();
  const scopeIndex = text.indexOf("\n[scope]");
  if (scopeIndex >= 0) text = text.slice(0, scopeIndex).trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isExpectedControlledRejectionRecord(
  record: Record<string, unknown>,
  path: string
): boolean {
  if (record["ok"] !== false) return false;
  if (record["expected"] === true || record["rejected"] === true) return true;

  const pathLower = path.toLowerCase();
  const text = [record["name"], record["error"], record["reason"], record["message"]]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return (
    pathLower.includes("controllederror") &&
    /rawsql writes are disabled|unknown worktree state|not-a-real|rejected|expected/.test(text)
  );
}

function looksLikeControlledOkFalseText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("controllederror") &&
    lower.includes("ok") &&
    /rawsql writes are disabled|unknown worktree state|not-a-real|rejected|expected/.test(lower)
  );
}

function looksLikeExpectedInFlightHealthText(value: string): boolean {
  if (!/"?ok"?\s*[:=]\s*false|ok false/i.test(value)) return false;
  const hasOpenWork = hasPositiveMetric(value, [
    "openTurns",
    "nonterminalInvocations",
    "openProjectedInvocations",
  ]);
  if (!hasOpenWork) return false;
  const issueFields = [
    "publicationIssues",
    "storageIssues",
    "missingMappings",
    "orphanMappings",
    "sequenceMismatches",
    "hashIssues",
    "integrityIssues",
  ];
  const namesAnIssueMetric = issueFields.some((field) =>
    new RegExp(`(?:"${field}"|\\b${field}\\b)\\s*[:=]`, "i").test(value)
  );
  return namesAnIssueMetric && !hasPositiveMetric(value, issueFields);
}

function hasExpectedInFlightHealthEvidence(
  result: Parameters<typeof finalMessageHasAll>[0]
): boolean {
  const evidence = collectInvocationResultText(result);
  return looksLikeExpectedInFlightHealthText(evidence);
}

function expectedLiveGadHealthOutcome(result: Parameters<typeof finalMessageHasAll>[0]): boolean {
  if (!GAD_INTEGRITY_CLAIMS.every((pattern) => pattern.test(findLastAgentMessage(result))))
    return false;
  if (!noIncompleteInvocations(result).passed) return false;
  if (unexpectedToolFailures(result).length > 0) return false;

  const toolEvidence = collectInvocationResultText(result);
  if (!toolEvidence.trim()) return false;
  const evidence = `${findLastAgentMessage(result)}\n${toolEvidence}`;
  const lower = evidence.toLowerCase();
  const hasLiveTurn =
    hasPositiveMetric(evidence, ["openTurns"]) || /\b(current|active|open)\s+turn\b/.test(lower);
  const hasLiveInvocation =
    hasPositiveMetric(evidence, ["nonterminalInvocations", "openProjectedInvocations"]) ||
    /\b(nonterminal|open)\s+invocation\b/.test(lower);
  if (!hasLiveTurn && !hasLiveInvocation) return false;

  if (
    hasPositiveMetric(evidence, [
      "publicationIssues",
      "storageIssues",
      "missingMappings",
      "orphanMappings",
      "sequenceMismatches",
      "hashIssues",
      "integrityIssues",
    ])
  ) {
    return false;
  }

  if (/(validateGadHashes|checkGadIntegrity)[\s\S]{0,300}"?ok"?\s*[:=]\s*false/i.test(evidence)) {
    return false;
  }
  return true;
}

function collectInvocationResultText(result: Parameters<typeof finalMessageHasAll>[0]): string {
  const parts: string[] = [];
  for (const call of getToolCalls(result)) {
    collectStringLeaves(call.execution?.result, parts);
  }
  for (const invocation of result.snapshot?.invocations ?? []) {
    for (const [, value] of invocationResultCandidates(invocation)) {
      collectStringLeaves(value, parts);
    }
  }
  return parts.join("\n");
}

function collectStringLeaves(value: unknown, parts: string[], seen = new Set<unknown>()) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    parts.push(JSON.stringify(value));
  } catch {
    // Cyclic diagnostic payloads are still covered by recursive string leaves below.
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, parts, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStringLeaves(item, parts, seen);
  }
}

function hasPositiveMetric(value: string, names: string[]): boolean {
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:"${escaped}"|\\b${escaped}\\b)\\s*[:=]\\s*(\\d+)`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      if (Number(match[1]) > 0) return true;
    }
    return false;
  });
}

function impossibleSuccessPhrase(
  result: Parameters<typeof finalMessageHasAll>[0]
): string | undefined {
  const lower = findLastAgentMessage(result).toLowerCase();
  if (/\bok\s*[:=]\s*false\b/.test(lower)) return "ok:false";
  return IMPOSSIBLE_SUCCESS_PHRASES.find((phrase) => lower.includes(phrase));
}

function dedupeFailures(failures: ToolFailureLike[]): ToolFailureLike[] {
  const seen = new Set<string>();
  const unique: ToolFailureLike[] = [];
  for (const failure of failures) {
    const key = [
      failure.name,
      failure.status,
      failure.terminalOutcome,
      failure.error,
      failure.resultSummary,
      failure.source,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

function invocationErrorText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error?: unknown }).error);
  }
  return String(value);
}

function formatToolFailure(failure: ToolFailureLike): string {
  const detail =
    failure.error ??
    failure.resultSummary ??
    failure.terminalOutcome ??
    failure.status ??
    "unknown";
  return `${failure.name}:${detail.slice(0, 160)}`;
}

export const cdpGadDiagnosticTests: TestCase[] = [
  {
    name: "workspace-panel-reload-performance-profile",
    description: "Profile a real workspace-panel reload without replacing its CDP lease",
    category: "cdp-gad-diagnostics",
    authorityPolicy: panelControlAuthorityPolicy("inspect-cdp-performance-panel-reload", [
      PANEL_RUNTIME_SUPERVISION_AUTHORITY,
    ]),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: WORKSPACE_RELOAD_PROFILE_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(
        context,
        WORKSPACE_RELOAD_PROFILE_PROMPT,
        "profile a workspace-panel reload"
      ),
    validate: (result) =>
      checked(
        result,
        [/reload/iu, /profil/iu, /network|request/iu],
        [
          /openPanel\s*\(/u,
          /\.cdp\.page\s*\(/u,
          /\.profile\s*\(/u,
          /\.reload\s*\(/u,
          /beforeAttemptId/u,
          /afterAttemptId/u,
          /navigation/u,
          /requestCount/u,
          /longTasks(?:\?\.)?\.count|"longTasks"\s*:\s*\{\s*"count"/u,
        ]
      ),
  },
  {
    name: "cdp-page-performance-profile",
    description: "Profile a browser interaction with the canonical bounded CDP report",
    category: "cdp-gad-diagnostics",
    authorityPolicy: panelControlAuthorityPolicy("inspect-cdp-performance-page"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: BROWSER_CLICK_PROFILE_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(
        context,
        BROWSER_CLICK_PROFILE_PROMPT,
        "profile one visible browser interaction"
      ),
    validate: (result) =>
      checked(
        result,
        [/profil/iu, /elapsed/iu, /runtime|task/iu, /network/iu, /state:\s*clicked/iu],
        [
          /\.profile\s*\(/u,
          /elapsedMs/u,
          /taskDurationMs/u,
          /requestCount/u,
          /longTasks(?:\?\.)?\.count|"longTasks"\s*:\s*\{\s*"count"/u,
          /state:\s*clicked/iu,
        ]
      ),
  },
  {
    name: "cdp-page-click-type-evaluate",
    description: "Automate a browser page with the canonical CDP client",
    category: "cdp-gad-diagnostics",
    authorityPolicy: panelControlAuthorityPolicy("inspect-cdp-click-page"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: BROWSER_AUTOMATION_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(
        context,
        BROWSER_AUTOMATION_PROMPT,
        "inspect an interactive browser page"
      ),
    validate: (result) => {
      const base = checked(
        result,
        [/click/iu, /evaluat/iu, /screenshot/iu, /state:\s*clicked/iu],
        [/click/iu, /evaluat/iu, /screenshot/iu]
      );
      if (!base.passed) return base;
      return hasSuccessfulImageRead(result)
        ? base
        : {
            passed: false,
            reason: "The agent captured a screenshot but did not read it as image content",
          };
    },
  },
  {
    name: "cdp-page-console-dom-inspection",
    description: "Exercise canonical CDP page inspection and host historical console APIs",
    category: "cdp-gad-diagnostics",
    authorityPolicy: panelControlAuthorityPolicy("inspect-cdp-console-page"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: BROWSER_CONSOLE_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(
        context,
        BROWSER_CONSOLE_PROMPT,
        "inspect browser console and document evidence"
      ),
    validate: (result) =>
      checked(
        result,
        [/console/iu, /histor/iu, /error/iu, /dom/iu, /visible/iu],
        [/console/iu, /histor/iu, /error/iu, /dom/iu, /visible/iu]
      ),
  },
  {
    name: "panel-stateargs-cdp-roundtrip",
    description: "Inspect panel state after a change",
    category: "cdp-gad-diagnostics",
    authorityPolicy: panelControlAuthorityPolicy("inspect-stateargs-page"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: PANEL_STATE_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(context, PANEL_STATE_PROMPT, "inspect a panel state change"),
    validate: (result) =>
      checked(
        result,
        [/panel/iu, /state/iu, /snapshot/iu, /visible|observed/iu],
        [/stateArgs/iu, /snapshot/iu]
      ),
  },
  {
    name: "gad-integrity-diagnostics",
    description: "Run a GAD health check",
    category: "cdp-gad-diagnostics",
    prompt:
      "Run a quick health assessment of the graph-and-data store, covering storage, publication, the current turn and invocation, hashes, and integrity. Report findings honestly, including healthy in-flight work.",
    validate: checkedGadIntegrity,
  },
  {
    name: "gad-branch-file-diff-probe",
    description: "Probe GAD branch and state inspection",
    category: "cdp-gad-diagnostics",
    prompt:
      "Probe graph-and-data branch files and state inspection, including a couple of harmless invalid requests so controlled rejection behavior is observable. Summarize successes and expected errors.",
    validate: (result) =>
      checked(
        result,
        [/branch/iu, /state/iu, /controlled|expected|reject/iu],
        [
          /branch.?files/iu,
          /state.?probe/iu,
          /controlled.?errors|rejected|rawSql writes are disabled/iu,
        ],
        { allowInFlightHealthOkFalse: true }
      ),
  },
];
