import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const docsDiscoveryTests: TestCase[] = [
  {
    name: "docs-search-capability",
    description: "Search the runtime documentation for a capability and cite hits",
    category: "docs-discovery",
    prompt:
      "A user wants to know whether this workspace can store content-addressable blobs. Search the workspace's own runtime documentation surface (not the filesystem) for the answer and cite what you found. Finish with DOCS_SEARCH_OK and results:<count>.",
    validate: (result) => checked(result, ["DOCS_SEARCH_OK", "results:"]),
  },
  {
    name: "docs-describe-service",
    description: "Describe one runtime service and its methods from the docs surface",
    category: "docs-discovery",
    prompt:
      "Pick one runtime service and produce a short description of what it does and which methods it exposes, sourced from the workspace's live service documentation surface rather than guesses. Finish with DOCS_DESCRIBE_OK and methods:<count>.",
    validate: (result) => checked(result, ["DOCS_DESCRIBE_OK", "methods:"]),
  },
  {
    name: "docs-list-services-bounded",
    description: "Enumerate available services in a bounded way",
    category: "docs-discovery",
    prompt:
      "Report how many services this runtime exposes and name a handful of interesting ones, keeping the output bounded rather than dumping everything. Finish with DOCS_SERVICES_OK and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["DOCS_SERVICES_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
];
