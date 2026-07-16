import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  finalMessageHasAll,
  getToolCalls,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stateKey(value: unknown): string | null {
  const state = record(value);
  if (state?.["kind"] === "event" && typeof state["eventId"] === "string") {
    return `event:${state["eventId"]}`;
  }
  if (state?.["kind"] === "application" && typeof state["applicationId"] === "string") {
    return `application:${state["applicationId"]}`;
  }
  return null;
}

/** Return a stable identity only for a complete public semantic root. */
function rootKey(value: unknown): string | null {
  const root = record(value);
  if (!root || typeof root["kind"] !== "string") return null;
  const one = (field: string) =>
    typeof root[field] === "string" ? `${root["kind"]}:${root[field]}` : null;
  switch (root["kind"]) {
    case "event":
      return one("eventId");
    case "application":
      return one("applicationId");
    case "work-unit":
      return one("workUnitId");
    case "change":
      return one("changeId");
    case "decision":
      return one("decisionId");
    case "command":
      return one("commandId");
    case "trajectory":
      return typeof root["logId"] === "string" && typeof root["head"] === "string"
        ? `trajectory:${root["logId"]}:${root["head"]}`
        : null;
    case "trajectory-invocation":
    case "trajectory-turn":
    case "trajectory-message": {
      const identityField =
        root["kind"] === "trajectory-invocation"
          ? "invocationId"
          : root["kind"] === "trajectory-turn"
            ? "turnId"
            : "messageId";
      return typeof root["logId"] === "string" &&
        typeof root["head"] === "string" &&
        typeof root[identityField] === "string"
        ? `${root["kind"]}:${root["logId"]}:${root["head"]}:${root[identityField]}`
        : null;
    }
    case "file":
    case "repository": {
      const state = stateKey(root["state"]);
      if (!state || typeof root["repositoryId"] !== "string") return null;
      if (root["kind"] === "repository") {
        return `repository:${state}:${root["repositoryId"]}`;
      }
      return typeof root["fileId"] === "string"
        ? `file:${state}:${root["repositoryId"]}:${root["fileId"]}`
        : null;
    }
    default:
      return null;
  }
}

function requireProvenanceRoots(result: Parameters<typeof finalMessageHasAll>[0]) {
  const roots = new Set<string>();
  let edgeCount = 0;
  for (const call of getToolCalls(result)) {
    if (
      call.name !== "provenance" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      continue;
    }
    const details = record(record(call.execution.result)?.["details"]);
    const returnedRoot = rootKey(details?.["root"]);
    if (!returnedRoot) continue;
    roots.add(returnedRoot);
    const adjacency = details?.["adjacency"];
    if (!Array.isArray(adjacency)) continue;
    for (const rawEdge of adjacency) {
      const edge = record(rawEdge);
      const from = rootKey(edge?.["from"]);
      const to = rootKey(edge?.["to"]);
      if (!from || !to || typeof edge?.["kind"] !== "string") continue;
      roots.add(from);
      roots.add(to);
      edgeCount++;
    }
  }
  if (edgeCount === 0) {
    return {
      passed: false,
      reason: "Completed provenance results contained no actual typed edge endpoints",
    };
  }
  const reported = /\broots\s*[:=]\s*(\d+)\b/i.exec(findLastAgentMessage(result));
  const reportedCount = reported ? Number(reported[1]) : NaN;
  return {
    passed: reportedCount === roots.size,
    reason:
      reportedCount === roots.size
        ? undefined
        : `Agent reported roots:${Number.isFinite(reportedCount) ? reportedCount : "missing"}; completed provenance evidence contained ${roots.size} unique complete roots`,
  };
}

export const harnessToolTests: TestCase[] = [
  {
    name: "provenance-orientation",
    description: "Orient in the session using the provenance surface",
    category: "harness-tools",
    prompt:
      "Orient yourself: find out where this session came from and what context it carries, using the workspace's provenance guidance. Report the reusable typed roots and immediate edges you actually observed. Count each unique complete root in the provenance result itself—its returned root and both endpoints of its observed edges—once. Finish with PROVENANCE_OK and roots:<count>.",
    validate: (result) => {
      const base = checked(result, ["PROVENANCE_OK", "roots:"]);
      if (!base.passed) return base;
      return requireProvenanceRoots(result);
    },
  },
  {
    name: "memory-search",
    description: "Search workspace memory with provenance before re-deriving knowledge",
    category: "harness-tools",
    prompt:
      "A user asks whether this workspace has dealt with build failures before. Search the workspace's memory of past conversations and knowledge instead of re-deriving from scratch, and report what you found with provenance (finding nothing is a valid, reportable outcome). Finish with MEMORY_SEARCH_OK and results:<count>.",
    validate: (result) => checked(result, ["MEMORY_SEARCH_OK", "results:"]),
  },
];
