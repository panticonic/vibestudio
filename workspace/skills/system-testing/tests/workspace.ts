import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";

function workspaceEvidence(
  result: TestExecutionResult,
  alternatives: readonly (readonly string[])[]
) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const exercised = requireCodeOperations(base.evidence.evalCode, alternatives);
  return exercised.passed ? { passed: true as const, evidence: base.evidence } : exercised;
}

export const workspaceTests: TestCase[] = [
  {
    name: "list-workspace-units",
    description: "Inspect the current workspace source or unit catalog",
    category: "workspace",
    prompt:
      "Use the live runtime workspace API to inspect this workspace's source or registered unit catalog, then summarize what is visible.",
    validate: (result) => {
      const base = workspaceEvidence(result, [["workspace.sourceTree"], ["build.listUnits"]]);
      if (!base.passed) return base;
      return walkArrays(base.evidence.evalValues).length > 0 ||
        walkRecords(base.evidence.evalValues).length > 0
        ? { passed: true, reason: undefined }
        : {
            passed: false,
            reason: "The completed workspace catalog call returned no structured catalog",
          };
    },
  },
  {
    name: "get-active",
    description: "Get the current workspace info",
    category: "workspace",
    prompt:
      "Use the live runtime workspace API to tell me which workspace is active in this runtime context.",
    validate: (result) => {
      const base = workspaceEvidence(result, [["workspace.getActive"]]);
      if (!base.passed) return base;
      return base.evidence.evalValues.some((value) => typeof value === "string" && value.length > 0)
        ? { passed: true, reason: undefined }
        : { passed: false, reason: "The active-workspace call returned no workspace identity" };
    },
  },
  {
    name: "get-config",
    description: "Get workspace configuration",
    category: "workspace",
    prompt:
      "Use the live runtime workspace API to inspect the active workspace configuration and summarize a couple of concrete facts.",
    validate: (result) => {
      const base = workspaceEvidence(result, [["workspace.getInfo"]]);
      if (!base.passed) return base;
      return walkRecords(base.evidence.evalValues).some((record) => Object.keys(record).length >= 2)
        ? { passed: true, reason: undefined }
        : {
            passed: false,
            reason: "The configuration call returned fewer than two concrete fields",
          };
    },
  },
];
