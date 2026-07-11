import type { TestCase } from "../types.js";
import {
  failedToolCalls,
  finalMessageHasAll,
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
} from "./_helpers.js";

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

const GAD_INTEGRITY_MARKERS = [
  "GAD_DIAGNOSTICS_OK",
  "storage",
  "publication",
  "turn",
  "invocation",
  "hashes",
  "integrity",
];

function checked(result: Parameters<typeof finalMessageHasAll>[0], markers: string[]) {
  const msg = finalMessageHasAll(result, markers);
  if (!msg.passed) return msg;

  const incomplete = noIncompleteInvocations(result);
  if (!incomplete.passed) return incomplete;

  const failed = unexpectedToolFailures(result);
  if (failed.length > 0) {
    return {
      passed: false,
      reason: `Expected no failed tool calls, got ${failed.map(formatToolFailure).join(", ")}`,
    };
  }

  const okFalsePath = firstOkFalsePath(result);
  if (okFalsePath) {
    return {
      passed: false,
      reason: `Final success marker conflicts with ok:false diagnostic result at ${okFalsePath}`,
    };
  }

  const impossible = impossibleSuccessPhrase(result);
  if (impossible) {
    return {
      passed: false,
      reason: `Final success marker conflicts with failure wording "${impossible}"`,
    };
  }

  return { passed: true };
}

function checkedGadIntegrity(result: Parameters<typeof finalMessageHasAll>[0]) {
  const strict = checked(result, GAD_INTEGRITY_MARKERS);
  if (strict.passed) return strict;
  if (expectedLiveGadHealthOutcome(result)) return { passed: true };
  return strict;
}

function unexpectedToolFailures(
  result: Parameters<typeof finalMessageHasAll>[0]
): ToolFailureLike[] {
  const fromMessages = failedToolCalls(result).map((call) => ({
    name: call.name,
    status: call.execution?.status,
    terminalOutcome: call.execution?.terminalOutcome,
    error: invocationErrorText(call.execution?.result),
    source: "message",
  }));
  const fromRunner = (result.toolFailures ?? []).map((failure) => ({
    name: failure.name,
    status: failure.status,
    terminalOutcome: failure.terminalOutcome,
    error: failure.error,
    resultSummary: failure.resultSummary,
    source: failure.source,
  }));
  const fromTerminalOutcomes = getToolCalls(result)
    .filter((call) => /error|fail/i.test(call.execution?.terminalOutcome ?? ""))
    .map((call) => ({
      name: call.name,
      status: call.execution?.status,
      terminalOutcome: call.execution?.terminalOutcome,
      error: invocationErrorText(call.execution?.result),
      source: "message",
    }));
  return dedupeFailures([...fromMessages, ...fromRunner, ...fromTerminalOutcomes]);
}

function firstOkFalsePath(result: Parameters<typeof finalMessageHasAll>[0]): string | undefined {
  const calls = getToolCalls(result);
  for (const [index, call] of calls.entries()) {
    const path = findOkFalse(
      call.execution?.result,
      `messages[${index}].${call.name}.execution.result`
    );
    if (path) return path;
  }

  for (const [index, invocation] of (result.snapshot?.invocations ?? []).entries()) {
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
      if (looksLikeControlledOkFalseText(value)) return undefined;
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

function expectedLiveGadHealthOutcome(
  result: Parameters<typeof finalMessageHasAll>[0]
): boolean {
  const nonOkMarkers = GAD_INTEGRITY_MARKERS.filter((marker) => marker !== "GAD_DIAGNOSTICS_OK");
  if (!finalMessageHasAll(result, nonOkMarkers).passed) return false;
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
    name: "cdp-lightweight-click-type-evaluate",
    description: "Automate a browser page with the lightweight CDP client",
    category: "cdp-gad-diagnostics",
    prompt:
      "Automate a tiny disposable browser page with the lightweight CDP client. Finish with CDP_LIGHTWEIGHT_INTERACTION_OK, clicked, evaluated, and screenshot.",
    validate: (result) =>
      checked(result, ["CDP_LIGHTWEIGHT_INTERACTION_OK", "clicked", "evaluated", "screenshot"]),
  },
  {
    name: "cdp-lightweight-console-dom-inspection",
    description: "Exercise explicit lightweight CDP inspection and host historical console APIs",
    category: "cdp-gad-diagnostics",
    prompt:
      "Exercise lightweight CDP console and DOM inspection on a tiny disposable browser page. Finish with CDP_LIGHTWEIGHT_OK, console-events, console-history, console-errors, dom-inspect, visible, and lightweightPage.",
    validate: (result) =>
      checked(result, [
        "CDP_LIGHTWEIGHT_OK",
        "console-events",
        "console-history",
        "console-errors",
        "dom-inspect",
        "visible",
        "lightweightPage",
      ]),
  },
  {
    name: "panel-stateargs-cdp-roundtrip",
    description: "Inspect panel state after a change",
    category: "cdp-gad-diagnostics",
    prompt:
      "Open a workspace panel, change its state, and inspect it through the panel automation surface. Finish with STATEARGS_CDP_OK, STATEARGS_CDP_OK_2, snapshot, and stateArgs.",
    validate: (result) =>
      checked(result, ["STATEARGS_CDP_OK", "STATEARGS_CDP_OK_2", "snapshot", "stateArgs"]),
  },
  {
    name: "gad-integrity-diagnostics",
    description: "Run a GAD health check",
    category: "cdp-gad-diagnostics",
    prompt:
      "Run a quick GAD health check. Finish with GAD_DIAGNOSTICS_OK, storage, publication, turn, invocation, hashes, and integrity.",
    validate: checkedGadIntegrity,
  },
  {
    name: "gad-branch-file-diff-probe",
    description: "Probe GAD branch and state inspection",
    category: "cdp-gad-diagnostics",
    prompt:
      "Probe GAD branch and state inspection. Finish with GAD_BRANCH_OK, branch-files, state-probe, and controlled-errors.",
    validate: (result) =>
      checked(result, ["GAD_BRANCH_OK", "branch-files", "state-probe", "controlled-errors"]),
  },
];
