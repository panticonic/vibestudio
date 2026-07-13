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

export const unitDiagnosticsTests: TestCase[] = [
  {
    name: "unit-list-inspect",
    description: "List running workspace units and inspect one of them",
    category: "unit-diagnostics",
    prompt:
      "Find out which workspace units are currently running and inspect one of them in more detail. Finish with UNIT_LIST_OK, UNIT_INSPECT_OK, and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["UNIT_LIST_OK", "UNIT_INSPECT_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
  {
    name: "unit-diagnostics-error-buffer",
    description: "Read a unit's persisted logs and its separate error buffer",
    category: "unit-diagnostics",
    prompt:
      "Pick a running workspace unit and pull its persisted diagnostics: its recent logs and its separate error buffer, keeping the evidence bounded. Finish with UNIT_DIAG_OK, logs:<count>, and errors:<count>.",
    validate: (result) => checked(result, ["UNIT_DIAG_OK", "logs:", "errors:"]),
  },
  {
    name: "unit-versions",
    description: "Report the version history of a workspace unit",
    category: "unit-diagnostics",
    prompt:
      "Pick a workspace unit and report its version history — how many versions exist and which one is active. Finish with UNIT_VERSIONS_OK and versions:<count>.",
    validate: (result) => checked(result, ["UNIT_VERSIONS_OK", "versions:"]),
  },
  {
    name: "schedule-surfaces-readonly",
    description: "Inspect recurring jobs and agent heartbeats without mutating them",
    category: "unit-diagnostics",
    prompt:
      "Report what scheduled work this workspace has configured: recurring jobs and agent heartbeats, without pausing, resuming, or running any of them. Finish with SCHEDULE_LIST_OK, recurring:<count>, and heartbeats:<count>.",
    validate: (result) =>
      checked(result, ["SCHEDULE_LIST_OK", "recurring:", "heartbeats:"]),
  },
];
