import type { TestCase, TestExecutionResult } from "../types.js";
import { completedScenarioEvidence, invocationReturnValue } from "./_scenario-evidence.js";
import { savedPermissionGrantSchema } from "@vibestudio/service-schemas/permissions";
const PERMISSION_LIST_CALL =
  /\bservices\.permissions\.list\s*\(\s*\)|\brpc\.call\s*\(\s*["']main["']\s*,\s*["']permissions\.list["']\s*,\s*\[\s*\]\s*\)/u;
const PERMISSION_MUTATION_CALL =
  /\bservices\.permissions\.(?:revoke|updateAgentProfile|setWorkspaceAuthorityLock)\s*\(|\brpc\.call\s*\(\s*["']main["']\s*,\s*["']permissions\.(?:revoke|updateAgentProfile|setWorkspaceAuthorityLock)["']/u;

function validatePermissionList(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (
    base.evidence.calls.some((call) => {
      const code = String(call.arguments?.["code"] ?? "");
      return call.name === "eval" && PERMISSION_MUTATION_CALL.test(code);
    })
  ) {
    return {
      passed: false,
      reason: "The permission inventory task invoked a mutating permission API",
    };
  }
  const listed = base.evidence.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      PERMISSION_LIST_CALL.test(code)
    );
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  return returned.present &&
    Array.isArray(returned.value) &&
    returned.value.every((grant) => savedPermissionGrantSchema.safeParse(grant).success)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The read-only permission listing returned an invalid grant inventory",
      };
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
