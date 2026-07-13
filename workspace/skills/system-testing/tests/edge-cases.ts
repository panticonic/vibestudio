import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-extra-argument",
    description: "Reject unsupported eval arguments clearly",
    category: "edge-cases",
    prompt:
      "Exercise recovery from invalid eval arguments. Finish with EDGE_EVAL_ARGS_OK and retry-succeeded.",
    expectedToolFailures: [
      { name: "eval", errorIncludes: "Invalid args" },
      { name: "eval", errorIncludes: "eval code must be a string" },
    ],
    validate: (result) => checked(result, ["EDGE_EVAL_ARGS_OK", "retry-succeeded"]),
  },
  {
    name: "invalid-import",
    description: "Graceful error for importing something that doesn't exist",
    category: "edge-cases",
    prompt:
      "Exercise recovery from an invalid import. Finish with EDGE_IMPORT_ERROR_OK and final-visible.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "Unknown build unit" }],
    validate: (result) => checked(result, ["EDGE_IMPORT_ERROR_OK", "final-visible"]),
  },
  {
    name: "fs-not-found",
    description: "Graceful error for reading a nonexistent file",
    category: "edge-cases",
    prompt:
      "Exercise recovery from a missing file read. Finish with EDGE_FS_NOT_FOUND_OK and final-visible.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "not found" }],
    validate: (result) => checked(result, ["EDGE_FS_NOT_FOUND_OK", "final-visible"]),
  },
];
