import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  finalMessageHasAll,
  finalMessageHasAny,
  getToolCalls,
  noIncompleteInvocations,
  requireAnyEvalEvidence,
  successfulEvalCode,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

/** Require a successful path or an explicit, deployment-dependent fallback. */
function checkedOrUnavailable(
  result: Parameters<typeof finalMessageHasAll>[0],
  okTokens: string[],
  unavailableMarker: string,
  evidenceAlternatives: readonly (readonly string[])[]
) {
  const ok = finalMessageHasAll(result, okTokens);
  if (ok.passed) {
    const pending = noIncompleteInvocations(result);
    if (!pending.passed) return pending;
    return requireAnyEvalEvidence(result, evidenceAlternatives);
  }
  return checked(result, [unavailableMarker]);
}

interface ObservedGitImport {
  path: string;
  remoteUrl: string;
  contextId: string;
  eventId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function requireGitImportSemanticEvidence(result: Parameters<typeof finalMessageHasAll>[0]): {
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
      "Find out whether any repos in this workspace track an external Git upstream and report their sync state. Finish with GIT_UPSTREAM_STATUS_OK and tracked:<count>.",
    validate: (result) => checked(result, ["GIT_UPSTREAM_STATUS_OK", "tracked:"]),
  },
  {
    name: "git-publish-local-remote",
    description: "Publish a workspace repo to a disposable external Git remote and push",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Connect a small disposable workspace repo to an external Git remote that you can reach without real credentials (create a throwaway local one if that is the documented way), ship the repo's main there, and verify the remote actually received it. Finish with GIT_PUBLISH_OK and pushed:<commit-count>, or GIT_PUBLISH_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) =>
      checkedOrUnavailable(result, ["GIT_PUBLISH_OK", "pushed:"], "GIT_PUBLISH_UNAVAILABLE", [
        ["git."],
        ["gitInterop"],
        ["@vibestudio/git"],
      ]),
  },
  {
    name: "git-import-project",
    description: "Import an external Git project into the workspace",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Can you bring a small credential-free Git project into this workspace and tell me where it landed and whether it is already published? Finish with GIT_IMPORT_OK.",
    validate: (result) => {
      const base = checked(result, ["GIT_IMPORT_OK"]);
      if (!base.passed) return base;
      return requireGitImportSemanticEvidence(result);
    },
  },
  {
    name: "git-commit-mapping",
    description: "Report the workspace-commit to git-commit mapping for an exported repo",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "For a repo that has been exported to external Git (set one up first if none exists and the environment allows it), report how workspace commits map to git commits. Finish with GIT_MAPPING_OK and mapped:<count>, or GIT_MAPPING_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAny(result, ["GIT_MAPPING_OK", "GIT_MAPPING_UNAVAILABLE"]);
      if (!ok.passed) return ok;
      return noIncompleteInvocations(result);
    },
  },
];
