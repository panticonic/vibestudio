import type { TestCase } from "../types.js";
import { findLastAgentMessage, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

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

function requireProvenanceRoots(result: Parameters<typeof noIncompleteInvocations>[0]) {
  let returnedRootCount = 0;
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
    returnedRootCount++;
    const adjacency = details?.["adjacency"];
    if (!Array.isArray(adjacency)) continue;
    for (const rawEdge of adjacency) {
      const edge = record(rawEdge);
      const from = rootKey(edge?.["from"]);
      const to = rootKey(edge?.["to"]);
      if (!from || !to || typeof edge?.["kind"] !== "string") continue;
      edgeCount++;
    }
  }
  if (edgeCount === 0) {
    return {
      passed: false,
      reason: "Completed provenance results contained no actual typed edge endpoints",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/(root|trajectory|turn|message|invocation)/iu.test(final) ||
    !/(edge|caus|trigger|origin|context)/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "Final response did not explain the observed provenance roots and relationships",
    };
  }
  return {
    passed: returnedRootCount > 0,
    reason:
      returnedRootCount > 0
        ? undefined
        : "Completed provenance results contained no reusable typed root",
  };
}

function requireMemoryRecall(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const calls = getToolCalls(result).filter(
    (call) =>
      call.name === "memory_recall" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  if (calls.length === 0) {
    return {
      passed: false,
      reason: "No completed workspace memory recall supplied canonical evidence",
    };
  }
  if (
    calls.some((call) => {
      const limit = call.arguments?.["limit"];
      return (
        limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
      );
    })
  ) {
    return { passed: false, reason: "Workspace memory recall was not bounded" };
  }
  const final = findLastAgentMessage(result);
  if (!/(build|failure)/iu.test(final) || !/(found|result|nothing|no prior|memory)/iu.test(final)) {
    return {
      passed: false,
      reason: "Final response did not semantically report the memory-search outcome",
    };
  }
  return noIncompleteInvocations(result);
}

export const harnessToolTests: TestCase[] = [
  {
    name: "provenance-orientation",
    description: "Orient in the session using the provenance surface",
    category: "harness-tools",
    prompt:
      "Orient me to this session: where did it come from, what context does it carry, and which reusable provenance roots support that explanation?",
    validate: requireProvenanceRoots,
  },
  {
    name: "memory-search",
    description: "Search workspace memory with provenance before re-deriving knowledge",
    category: "harness-tools",
    prompt:
      "Has this workspace dealt with build failures before? Check its memory of prior conversations and committed knowledge, and tell me what you find with provenance. Finding nothing is a valid outcome.",
    validate: requireMemoryRecall,
  },
];
