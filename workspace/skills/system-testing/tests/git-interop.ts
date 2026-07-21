import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

interface ObservedGitImport {
  path: string;
  remoteUrl: string;
  contextId: string;
  eventId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) records(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  found.push(value);
  for (const child of Object.values(value)) records(child, found);
  return found;
}

function arrays(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    found.push(value);
    for (const item of value) arrays(item, found);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) arrays(child, found);
  }
  return found;
}

function exactNumber(message: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message);
}

function unavailableGitResult(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const failed = getToolCalls(result).some(
    (call) =>
      call.name === "eval" &&
      call.execution?.isError === true &&
      /\bgit\./iu.test(String(call.arguments?.["code"] ?? ""))
  );
  const final = findLastAgentMessage(result);
  return failed &&
    /(unavailable|blocked|unsupported|cannot|could not|failed)/iu.test(final) &&
    final.trim().length > 20
    ? noIncompleteInvocations(result)
    : {
        passed: false,
        reason: "Git unavailability was not backed by a failed canonical invocation",
      };
}

function upstreamStatusChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  if (!/git\.upstreamStatus/iu.test(successfulEvalCode(result))) {
    return {
      passed: false,
      reason: "No successful canonical Git upstream-status call was observed",
    };
  }
  const statuses = successfulEvalReturnValues(result)
    .flatMap((value) => arrays(value))
    .find((items) =>
      items.every(
        (item) =>
          isRecord(item) &&
          typeof item["repoPath"] === "string" &&
          typeof item["state"] === "string" &&
          typeof item["autoPush"] === "boolean" &&
          Number.isInteger(item["aheadBy"]) &&
          Number.isInteger(item["behindBy"])
      )
    );
  if (!statuses)
    return { passed: false, reason: "Git status result contained no canonical row set" };
  const final = findLastAgentMessage(result);
  if (!exactNumber(final, statuses.length)) {
    return { passed: false, reason: "Final response did not report the observed upstream count" };
  }
  if (statuses.length === 0) {
    return /no|none|zero|not track/iu.test(final)
      ? noIncompleteInvocations(result)
      : { passed: false, reason: "Final response did not explain the empty upstream set" };
  }
  const cited = statuses.some(
    (item) =>
      isRecord(item) &&
      final.includes(String(item["repoPath"])) &&
      final.toLowerCase().includes(String(item["state"]).toLowerCase())
  );
  return cited
    ? noIncompleteInvocations(result)
    : { passed: false, reason: "Final response did not cite an observed repository and state" };
}

function disposablePublishChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const code = successfulEvalCode(result);
  const values = successfulEvalReturnValues(result);
  const final = findLastAgentMessage(result);
  if (/git\.publishToDisposableRemote/iu.test(code)) {
    const published = records(values).find(
      (item) =>
        typeof item["repoPath"] === "string" &&
        typeof item["branch"] === "string" &&
        item["pushed"] === true &&
        Number.isInteger(item["commitCount"]) &&
        Number(item["commitCount"]) > 0 &&
        typeof item["headCommit"] === "string"
    );
    if (
      published &&
      final.includes(String(published["repoPath"])) &&
      exactNumber(final, Number(published["commitCount"])) &&
      /push|publish|received/iu.test(final)
    ) {
      return noIncompleteInvocations(result);
    }
    return {
      passed: false,
      reason: "One-call disposable publish result was incomplete or unreported",
    };
  }

  const required = [
    "createDisposableRemote",
    "pushDisposableRemote",
    "inspectDisposableRemote",
    "removeDisposableRemote",
  ];
  if (!required.every((method) => code.includes(`git.${method}`))) {
    return unavailableGitResult(result);
  }
  const all = records(values);
  const remote = all.find(
    (item) =>
      typeof item["id"] === "string" &&
      typeof item["url"] === "string" &&
      typeof item["branch"] === "string" &&
      Number.isInteger(item["expiresAt"])
  );
  const inspected = remote
    ? all.find(
        (item) =>
          item !== remote &&
          item["id"] === remote["id"] &&
          item["url"] === remote["url"] &&
          Number.isInteger(item["commitCount"]) &&
          Number(item["commitCount"]) > 0 &&
          typeof item["headCommit"] === "string"
      )
    : undefined;
  const removed = all.some((item) => item["removed"] === true);
  if (
    !remote ||
    !inspected ||
    !removed ||
    !exactNumber(final, Number(inspected["commitCount"])) ||
    !/push|publish|received/iu.test(final) ||
    !/remove|clean/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "Stepwise disposable publish was not identity-joined and cleaned up",
    };
  }
  return noIncompleteInvocations(result);
}

function commitMappingChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  if (!/git\.commitMapping/iu.test(successfulEvalCode(result))) return unavailableGitResult(result);
  const mappings = successfulEvalReturnValues(result)
    .flatMap((value) => arrays(value))
    .find(
      (items) =>
        items.length > 0 &&
        items.every(
          (item) =>
            isRecord(item) &&
            typeof item["gitSha"] === "string" &&
            typeof item["eventId"] === "string" &&
            typeof item["summary"] === "string"
        )
    );
  if (!mappings)
    return { passed: false, reason: "Git commit mapping result had no canonical rows" };
  const final = findLastAgentMessage(result);
  const cited = mappings.some(
    (item) =>
      isRecord(item) &&
      final.includes(String(item["gitSha"])) &&
      final.includes(String(item["eventId"]))
  );
  return cited && exactNumber(final, mappings.length)
    ? noIncompleteInvocations(result)
    : {
        passed: false,
        reason: "Final response did not cite an observed Git/event mapping and count",
      };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalGitSourceUri(remote: string): string | null {
  const value = remote.trim();
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    return `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(value);
    if (["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    // A local-only remote is represented by an opaque digest, not its path.
  }
  return null;
}

function collectGitImports(
  value: unknown,
  imports: ObservedGitImport[],
  seen = new Set<object>()
): void {
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (isRecord(value) && hasExactKeys(value, ["path", "remote", "candidate"])) {
    const remote = value["remote"];
    const candidate = value["candidate"];
    if (
      typeof value["path"] === "string" &&
      value["path"].length > 0 &&
      isRecord(remote) &&
      (hasExactKeys(remote, ["name", "url"]) || hasExactKeys(remote, ["name", "url", "branch"])) &&
      typeof remote["name"] === "string" &&
      remote["name"].length > 0 &&
      typeof remote["url"] === "string" &&
      remote["url"].length > 0 &&
      (remote["branch"] === undefined || typeof remote["branch"] === "string") &&
      isRecord(candidate) &&
      hasExactKeys(candidate, ["contextId", "eventId", "changed"]) &&
      typeof candidate["contextId"] === "string" &&
      candidate["contextId"].length > 0 &&
      typeof candidate["eventId"] === "string" &&
      candidate["eventId"].length > 0 &&
      candidate["changed"] === true
    ) {
      imports.push({
        path: value["path"],
        remoteUrl: remote["url"],
        contextId: candidate["contextId"],
        eventId: candidate["eventId"],
      });
    }
  }
  for (const child of Object.values(value)) collectGitImports(child, imports, seen);
}

function statusProvesUnpublishedCandidate(value: unknown, imported: ObservedGitImport): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (isRecord(value)) {
    const candidate = value["candidate"];
    if (
      value["repoPath"] === imported.path &&
      value["state"] === "integration-required" &&
      typeof value["autoPush"] === "boolean" &&
      Number.isInteger(value["aheadBy"]) &&
      Number(value["aheadBy"]) >= 0 &&
      Number.isInteger(value["behindBy"]) &&
      Number(value["behindBy"]) >= 0 &&
      isRecord(candidate) &&
      hasExactKeys(candidate, ["contextId", "eventId"]) &&
      candidate["contextId"] === imported.contextId &&
      candidate["eventId"] === imported.eventId
    ) {
      return true;
    }
  }
  return Object.values(value).some((child) => statusProvesUnpublishedCandidate(child, imported));
}

function requireGitImportSemanticEvidence(result: Parameters<typeof noIncompleteInvocations>[0]): {
  passed: boolean;
  reason?: string;
} {
  const evalCalls = getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  const code = successfulEvalCode(result);
  if (!code.includes("git.importProject") || !code.includes("git.upstreamStatus")) {
    return {
      passed: false,
      reason: "Successful eval did not perform both Git import and upstream status observation",
    };
  }

  const imports: ObservedGitImport[] = [];
  for (const call of evalCalls) collectGitImports(call.execution?.result, imports);
  if (imports.length === 0) {
    return {
      passed: false,
      reason:
        "Successful eval results did not contain a complete host-shaped Git import result with a changed semantic candidate",
    };
  }

  const inspectedEvents = new Map<string, Record<string, unknown>>();
  const inspectedApplications = new Map<string, Record<string, unknown>>();
  const inspectedWorkUnits = new Map<string, Record<string, unknown>>();
  const visitInspection = (value: unknown, seen = new Set<object>()): void => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isRecord(value) && isRecord(value["node"])) {
      const node = value["node"];
      const inspected = node["value"];
      if (!isRecord(inspected)) {
        for (const child of Object.values(value)) visitInspection(child, seen);
        return;
      }
      if (node["kind"] === "event" && typeof inspected["eventId"] === "string") {
        inspectedEvents.set(inspected["eventId"], inspected);
      } else if (node["kind"] === "application" && typeof inspected["applicationId"] === "string") {
        inspectedApplications.set(inspected["applicationId"], inspected);
      } else if (node["kind"] === "work-unit" && typeof inspected["workUnitId"] === "string") {
        inspectedWorkUnits.set(inspected["workUnitId"], inspected);
      }
    }
    for (const child of Object.values(value)) visitInspection(child, seen);
  };
  for (const call of getToolCalls(result)) {
    if (
      call.name === "provenance" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
    ) {
      visitInspection(call.execution.result);
    }
  }

  const finalMessage = findLastAgentMessage(result);
  for (const imported of imports) {
    if (
      !evalCalls.some((call) => statusProvesUnpublishedCandidate(call.execution?.result, imported))
    ) {
      continue;
    }
    const event = inspectedEvents.get(imported.eventId);
    if (
      !event ||
      event["kind"] !== "commit" ||
      !Array.isArray(event["applicationIds"]) ||
      event["applicationIds"].length === 0 ||
      typeof event["commandId"] !== "string"
    ) {
      continue;
    }
    for (const applicationId of event["applicationIds"]) {
      if (typeof applicationId !== "string") continue;
      const application = inspectedApplications.get(applicationId);
      if (
        !application ||
        application["applicationId"] !== applicationId ||
        typeof application["workUnitId"] !== "string"
      ) {
        continue;
      }
      const workUnit = inspectedWorkUnits.get(application["workUnitId"]);
      const snapshot = workUnit?.["externalSnapshot"];
      const expectedSourceUri = canonicalGitSourceUri(imported.remoteUrl);
      if (
        !workUnit ||
        workUnit["kind"] !== "import" ||
        workUnit["commandId"] !== event["commandId"] ||
        typeof workUnit["intentSummary"] !== "string" ||
        workUnit["intentSummary"].trim().length === 0 ||
        !isRecord(snapshot) ||
        snapshot["sourceKind"] !== "git" ||
        typeof snapshot["sourceUri"] !== "string" ||
        (expectedSourceUri
          ? snapshot["sourceUri"] !== expectedSourceUri
          : !snapshot["sourceUri"].startsWith("git-local://sha256/")) ||
        typeof snapshot["snapshotRevision"] !== "string" ||
        snapshot["snapshotRevision"].length === 0 ||
        typeof snapshot["snapshotDigest"] !== "string" ||
        !/^snapshot:[0-9a-f]{64}$/u.test(snapshot["snapshotDigest"]) ||
        !Array.isArray(snapshot["targetRepositoryIds"]) ||
        snapshot["targetRepositoryIds"].length < 1
      ) {
        continue;
      }
      if (
        finalMessage.includes(imported.path) &&
        finalMessage.includes(imported.eventId) &&
        /\b(?:unpublished|not (?:yet )?published)\b/iu.test(finalMessage)
      ) {
        return { passed: true, reason: undefined };
      }
    }
  }

  return {
    passed: false,
    reason:
      "Completed results did not identity-join one exact Git import result and integration-required status to its inspected candidate event, application, and import work unit with an external snapshot; the final answer must report that same path, event, and unpublished state",
  };
}

export const gitInteropTests: TestCase[] = [
  {
    name: "git-upstream-status",
    description: "Inspect external Git upstream tracking across workspace repos",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Do any repositories in this workspace track an external Git upstream? Give me a bounded summary of what is tracked and its synchronization state.",
    validate: upstreamStatusChecked,
  },
  {
    name: "git-publish-local-remote",
    description: "Publish a workspace repo to a disposable external Git remote and push",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Publish a small disposable workspace repository to a credential-free throwaway Git remote, verify that the remote received its main history, and clean up the temporary remote afterward. If this deployment cannot do that, report the concrete blocker.",
    validate: disposablePublishChecked,
  },
  {
    name: "git-import-project",
    description: "Import an external Git project into the workspace",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Can you bring a small credential-free Git project into this workspace and tell me where it landed and whether it is already published?",
    validate: requireGitImportSemanticEvidence,
  },
  {
    name: "git-commit-mapping",
    description: "Report the workspace-commit to git-commit mapping for an exported repo",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "For a repository exported to external Git, explain how its workspace commits map to Git commits. If no suitable export can be prepared in this deployment, report the concrete blocker.",
    validate: commitMappingChecked,
  },
];
