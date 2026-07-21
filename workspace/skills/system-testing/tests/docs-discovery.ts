import type { TestCase } from "../types.js";
import { findLastAgentMessage, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function details(value: unknown): unknown {
  return record(value)?.["details"] ?? value;
}

function concreteLabel(hit: Record<string, unknown>): string | null {
  for (const field of ["qualifiedName", "title", "id"] as const) {
    const value = hit[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function completed(result: Parameters<typeof noIncompleteInvocations>[0], name: string) {
  return getToolCalls(result).filter(
    (call) =>
      call.name === name && call.execution?.status === "complete" && call.execution.isError !== true
  );
}

function boundedSearches(result: Parameters<typeof noIncompleteInvocations>[0]) {
  return completed(result, "docs_search").filter((call) => {
    const limit = call.arguments?.["limit"];
    return (
      limit === undefined || (Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 100)
    );
  });
}

function docsSearchChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const calls = boundedSearches(result);
  const hits = calls.flatMap((call) => {
    const value = details(call.execution?.result);
    return Array.isArray(value) ? value.filter((item) => record(item)) : [];
  }) as Record<string, unknown>[];
  const blobHits = hits.filter((hit) =>
    /blob|content.address/iu.test(`${hit["qualifiedName"] ?? ""} ${hit["description"] ?? ""}`)
  );
  if (blobHits.length === 0) {
    return {
      passed: false,
      reason: "Bounded docs search returned no canonical blobstore capability hit",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/content.address|blob/iu.test(final) ||
    !blobHits.some((hit) => {
      const label = concreteLabel(hit);
      return label !== null && final.includes(label);
    })
  ) {
    return {
      passed: false,
      reason: "Final response did not cite an observed blobstore documentation hit",
    };
  }
  return noIncompleteInvocations(result);
}

function docsDescribeChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const hits = boundedSearches(result).flatMap((call) => {
    const value = details(call.execution?.result);
    return Array.isArray(value) ? value.filter((item) => record(item)) : [];
  }) as Record<string, unknown>[];
  const hitIds = new Set(
    hits.map((hit) => hit["id"]).filter((id): id is string => typeof id === "string")
  );
  const opened = completed(result, "docs_open").flatMap((call) => {
    const id = call.arguments?.["id"];
    const value = record(details(call.execution?.result));
    return typeof id === "string" && hitIds.has(id) && value?.["id"] === id ? [value] : [];
  });
  if (opened.length === 0) {
    return {
      passed: false,
      reason: "Docs open result was not identity-joined to a bounded search hit",
    };
  }
  const entry = opened[0]!;
  const members = Array.isArray(entry["members"]) ? entry["members"] : [];
  if (members.length === 0) {
    return {
      passed: false,
      reason: "Opened service documentation exposed no canonical method members",
    };
  }
  const final = findLastAgentMessage(result);
  const entryLabel = concreteLabel(entry);
  if (
    !entryLabel ||
    !final.includes(entryLabel) ||
    !members.some((member) => typeof member === "string" && final.includes(member))
  ) {
    return {
      passed: false,
      reason: "Final response did not describe the opened service and an observed method",
    };
  }
  return noIncompleteInvocations(result);
}

function docsServicesChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const calls = boundedSearches(result).filter((call) => call.arguments?.["surface"] === "service");
  const hits = calls.flatMap((call) => {
    const value = details(call.execution?.result);
    return Array.isArray(value) ? value.filter((item) => record(item)) : [];
  }) as Record<string, unknown>[];
  if (hits.length === 0)
    return { passed: false, reason: "No bounded service-catalog result was observed" };
  const final = findLastAgentMessage(result);
  const count = new RegExp(`(?:^|\\D)${hits.length}(?:\\D|$)`, "u");
  if (
    !count.test(final) ||
    !hits.some((hit) => {
      const label = concreteLabel(hit);
      return label !== null && final.includes(label);
    })
  ) {
    return {
      passed: false,
      reason: "Final response did not report the bounded service count and an observed service",
    };
  }
  return noIncompleteInvocations(result);
}

export const docsDiscoveryTests: TestCase[] = [
  {
    name: "docs-search-capability",
    description: "Search the runtime documentation for a capability and cite hits",
    category: "docs-discovery",
    prompt:
      "Can this workspace store content-addressable blobs? Check the live runtime documentation rather than source files or guesses, and cite the relevant capability you find.",
    validate: docsSearchChecked,
  },
  {
    name: "docs-describe-service",
    description: "Describe one runtime service and its methods from the docs surface",
    category: "docs-discovery",
    prompt:
      "Choose one runtime service from the live documentation catalog and briefly explain what it does and some methods it actually exposes.",
    validate: docsDescribeChecked,
  },
  {
    name: "docs-list-services-bounded",
    description: "Enumerate available services in a bounded way",
    category: "docs-discovery",
    prompt:
      "Using the live documentation catalog, give me a bounded overview of the runtime's service surface: how many entries you observed and a few representative services.",
    validate: docsServicesChecked,
  },
];
