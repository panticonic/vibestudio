import type { TestCase } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function checkedWithAnyTool(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  toolNames: readonly string[]
) {
  const base = checked(result, tokens);
  if (!base.passed) return base;
  const completed = completedToolNames(result);
  const found = toolNames.some((name) => completed.has(name));
  if (!found) {
    return {
      passed: false,
      reason: `Expected a completed ${toolNames.join(" or ")} tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
    };
  }
  return { passed: true };
}

export const harnessToolTests: TestCase[] = [
  {
    name: "provenance-orientation",
    description: "Orient in the session using the provenance surface",
    category: "harness-tools",
    prompt:
      "Orient yourself: find out where this session came from and what context it carries, using the workspace's provenance surface, and report what you learned with any follow-on handles it gave you. Finish with PROVENANCE_OK and handles:<count>.",
    validate: (result) => checked(result, ["PROVENANCE_OK", "handles:"]),
  },
  {
    name: "claims-lifecycle",
    description: "Record, revise, and retract a knowledge claim",
    category: "harness-tools",
    prompt:
      "Exercise the workspace knowledge-claim lifecycle with a clearly-marked disposable test claim: record it, revise it once, then retract it so it does not pollute the claim base. Finish with CLAIM_LIFECYCLE_OK and retracted:yes, or CLAIM_LIFECYCLE_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["CLAIM_LIFECYCLE_OK", "retracted:yes"]);
      if (ok.passed) {
        return checkedWithAnyTool(result, ["CLAIM_LIFECYCLE_OK"], [
          "record_claim",
          "revise_claim",
          "retract_claim",
        ]);
      }
      return checked(result, ["CLAIM_LIFECYCLE_UNAVAILABLE"]);
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
