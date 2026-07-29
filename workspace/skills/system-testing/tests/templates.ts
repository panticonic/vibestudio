import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  invocationConsoleOutput,
  walkArrays,
  walkRecords,
  type ScenarioEvidence,
} from "./_scenario-evidence.js";
import { findLastAgentMessage } from "./_helpers.js";

function exactCount(message: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message);
}

function nonNegativeInteger(
  record: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  }
  return undefined;
}

function invokedComposerOperation(code: string, operation: string): boolean {
  if (!code.includes("@workspace-extensions/template-composer")) return false;
  const quoted = `(["'])${operation}\\1`;
  const convenienceCall = new RegExp(
    `(?:\\bextensions|\\([^)]*\\bextensions\\b[^)]*\\))\\.invoke\\s*\\([^,]+,\\s*${quoted}`,
    "u"
  ).test(code);
  const portableCall =
    /rpc\.call\s*\(\s*(["'])main\1\s*,\s*(["'])extensions\.invoke\2\s*,/u.test(code) &&
    new RegExp(quoted, "u").test(code);
  const indirectCall =
    /extensions\.invoke\s*\([^,]+,\s*[A-Za-z_$][\w$]*/u.test(code) &&
    new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\(\\s*${quoted}`, "u").test(code);
  return convenienceCall || portableCall || indirectCall;
}

function consoleStructuredValues(calls: ScenarioEvidence["calls"]): unknown[] {
  const values: unknown[] = [];
  for (const call of calls) {
    const output = invocationConsoleOutput(call);
    if (!output) continue;
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ] as const) {
      const start = output.indexOf(open);
      const end = output.lastIndexOf(close);
      if (start < 0 || end <= start) continue;
      try {
        values.push(JSON.parse(output.slice(start, end + 1)));
      } catch {
        // Console evidence is optional; exact eval return values remain preferred.
      }
    }
  }
  return values;
}

function consoleStatusCount(output: string): number | undefined {
  const match = /(?:^|\n)status(?:\s+ok)?\s+(\[[^\n]*\])/iu.exec(output);
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function templateOverviewChecked(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (
    !invokedComposerOperation(base.evidence.evalCode, "status") ||
    !invokedComposerOperation(base.evidence.evalCode, "catalog")
  ) {
    return {
      passed: false,
      reason: "Completed eval did not invoke template composer status and catalog",
    };
  }

  const records = walkRecords([
    ...base.evidence.evalValues,
    ...consoleStructuredValues(base.evidence.calls),
  ]);
  const overview = records.find(
    (record) =>
      nonNegativeInteger(record, ["statusCount", "connectedTemplatesCount"]) !== undefined &&
      (nonNegativeInteger(record, ["catalogCount", "catalogEntriesCount"]) !== undefined ||
        record["catalogUnavailable"] === true)
  );
  const arrays = walkArrays(base.evidence.evalValues);
  const status = arrays.find((items) =>
    items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>)["alias"] === "string" &&
        typeof (item as Record<string, unknown>)["state"] === "string"
    )
  );
  const catalog = arrays.find((items) =>
    items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>)["id"] === "string" &&
        typeof (item as Record<string, unknown>)["name"] === "string"
    )
  );
  const statusCount = overview
    ? nonNegativeInteger(overview, ["statusCount", "connectedTemplatesCount"])
    : undefined;
  const catalogCount = overview
    ? nonNegativeInteger(overview, ["catalogCount", "catalogEntriesCount"])
    : undefined;
  const catalogUnavailable = overview?.["catalogUnavailable"] === true;
  const hasStatusRow = records.some(
    (record) => typeof record["alias"] === "string" && typeof record["state"] === "string"
  );
  const hasCatalogRow = records.some(
    (record) => typeof record["id"] === "string" && typeof record["name"] === "string"
  );
  const consoleOutput = base.evidence.calls
    .map(invocationConsoleOutput)
    .filter((output): output is string => output !== null)
    .join("\n");
  const observedConsoleStatusCount = consoleStatusCount(consoleOutput);
  const consoleCatalogUnavailable = /no verified template registry is cached/iu.test(
    consoleOutput
  );
  const countsAreSupported =
    statusCount !== undefined &&
    (catalogCount !== undefined || catalogUnavailable) &&
    (statusCount === 0 || hasStatusRow) &&
    (catalogUnavailable || catalogCount === 0 || hasCatalogRow);
  const consoleEvidenceIsSupported =
    observedConsoleStatusCount !== undefined && consoleCatalogUnavailable;
  if ((!status || !catalog) && !countsAreSupported && !consoleEvidenceIsSupported) {
    return {
      passed: false,
      reason: "Template status and catalog calls did not both return canonical row sets",
    };
  }
  const observedStatusCount = statusCount ?? status?.length ?? observedConsoleStatusCount!;
  const observedCatalogCount = catalogCount ?? catalog?.length;
  const observedCatalogUnavailable = catalogUnavailable || consoleCatalogUnavailable;
  const final = findLastAgentMessage(result);
  const catalogReported =
    !observedCatalogUnavailable && observedCatalogCount !== undefined
      ? exactCount(final, observedCatalogCount)
      : /\b(?:cache\w*|catalog|registry)\b[\s\S]*?\b(?:absent|empty|missing|unavailable|not cached)\b/iu.test(
          final
        );
  return exactCount(final, observedStatusCount) && catalogReported
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Final response did not report the observed template and catalog counts",
      };
}

function templateAuthoringPrepared(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (
    !invokedComposerOperation(base.evidence.evalCode, "authoringParts") ||
    !invokedComposerOperation(base.evidence.evalCode, "inspectAuthoring")
  ) {
    return {
      passed: false,
      reason: "Completed eval did not discover parts and inspect an authoring plan",
    };
  }
  if (invokedComposerOperation(base.evidence.evalCode, "publishAuthoring")) {
    return { passed: false, reason: "Preparation-only scenario unexpectedly published a template" };
  }
  const records = walkRecords([
    ...base.evidence.evalValues,
    ...consoleStructuredValues(base.evidence.calls),
  ]);
  const receipts = new Map<
    string,
    { mainEventId?: string; manifest?: string; requestedParts: Set<string> }
  >();
  for (const record of records) {
    const fingerprint = record["fingerprint"];
    if (
      typeof fingerprint !== "string" ||
      !/^v1-sha256:[0-9a-f]{64}$/u.test(fingerprint)
    ) {
      continue;
    }
    const receipt = receipts.get(fingerprint) ?? { requestedParts: new Set<string>() };
    if (typeof record["mainEventId"] === "string") {
      receipt.mainEventId = record["mainEventId"];
    }
    if (typeof record["manifest"] === "string") receipt.manifest = record["manifest"];
    const requested = Array.isArray(record["requestedParts"])
      ? record["requestedParts"]
      : Array.isArray(record["requested"])
        ? record["requested"]
        : Array.isArray(record["selectedParts"])
          ? record["selectedParts"]
          : [];
    for (const repoPath of requested) {
      if (typeof repoPath === "string") receipt.requestedParts.add(repoPath);
    }
    receipts.set(fingerprint, receipt);
  }
  const exactReceipts = [...receipts].filter(
    ([, receipt]) =>
      receipt.manifest !== undefined && receipt.requestedParts.size > 0
  );
  if (!exactReceipts.length) {
    return {
      passed: false,
      reason: "Authoring inspection did not return an exact non-empty plan",
    };
  }
  const composerReceipts = exactReceipts.filter(([, receipt]) =>
    receipt.requestedParts.has("packages/template-composer")
  );
  if (!composerReceipts.length) {
    return {
      passed: false,
      reason: "Authoring plan did not select the requested template composer package",
    };
  }
  const final = findLastAgentMessage(result);
  const reportedExactPlan = composerReceipts.some(([fingerprint]) => final.includes(fingerprint));
  return (
    reportedExactPlan &&
    /not publish|not published|nothing (?:was )?published|without publishing|prepared/iu.test(final)
  )
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Final response did not report the exact fingerprint and preparation-only state",
      };
}

export const templateTests: TestCase[] = [
  {
    name: "templates-status-catalog",
    description: "Inspect exact template relationships and the verified registry cache",
    category: "templates",
    prompt:
      "Use the workspace templates skill and userland template composer to inspect connected templates and the cached verified registry. Do not refresh, fetch, or change anything. Keep the status observation even when the cache-only catalog read reports that no verified registry is cached. Report the exact number of connected templates and, when cached, catalog entries; otherwise report that the catalog cache is unavailable. Include one concrete status or catalog name when available.",
    validate: templateOverviewChecked,
  },
  {
    name: "templates-authoring-prepare",
    description: "Discover authorable parts and prepare an exact template publication plan",
    category: "templates",
    prompt:
      "Use the workspace templates skill to prepare, but do not publish, a reusable template containing the workspace library package whose discovered packageName is @workspace/template-composer (not the extension package). Discover the available authoring parts through the composer and select the matching inventory row instead of guessing its repository path. Give it a concise name and description, inspect the exact plan, and report the selected part, any automatically required or inherited parts, and the complete plan fingerprint. Explicitly say that nothing was published.",
    validate: templateAuthoringPrepared,
  },
];
