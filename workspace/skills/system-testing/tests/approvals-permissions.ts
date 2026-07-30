import type { TestCase, TestExecutionResult } from "../types.js";
import { completedScenarioEvidence, invocationReturnValue } from "./_scenario-evidence.js";

function validatePermissionList(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const listed = base.evidence.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      /permissions\.list|["']permissions\.list["']/u.test(code) &&
      !/permissions\.revoke/u.test(code)
    );
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  const grants =
    returned.present && returned.value && typeof returned.value === "object"
      ? (returned.value as Record<string, unknown>)["grants"]
      : undefined;
  return returned.present && (Array.isArray(returned.value) || Array.isArray(grants))
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The read-only permission listing returned no grant array" };
}

export const approvalPermissionTests: TestCase[] = [
  {
    name: "permissions-list",
    description: "Inspect the canonical capability grant inventory without changing it",
    category: "approvals-permissions",
    prompt: "List the workspace permissions currently granted here. Do not change them.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "list-permissions",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    validate: validatePermissionList,
  },
];
