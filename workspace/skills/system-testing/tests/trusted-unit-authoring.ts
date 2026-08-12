import {
  BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
  BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
  type TestAuthorityPolicy,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { getToolCalls, noIncompleteInvocations } from "./_helpers.js";

const focusedVerificationAuthority: TestAuthorityPolicy = {
  authority: [
    {
      ruleId: "focused-workspace-test-execution",
      capability: {
        kind: "prefix",
        prefix: "userland:extensions/test-runner/native.tests.execute#",
      },
      resource: {
        kind: "exact",
        key: "native.tests:extension:@workspace-extensions/test-runner",
      },
      tier: "gated",
      decision: "once",
    },
  ],
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireTrustedUnitRepair(result: TestExecutionResult) {
  const calls = getToolCalls(result).filter(
    (call) => call.execution?.status === "complete" && call.execution.isError !== true
  );
  const verified = (operation: "test" | "build", status: string) =>
    calls.some((call) => {
      if (call.name !== "verify" || call.arguments?.["operation"] !== operation) return false;
      const details = record(record(call.execution?.result)?.["details"]);
      return details?.["operation"] === operation && details["status"] === status;
    });
  const committed = calls.some(
    (call) => call.name === "vcs" && call.arguments?.["operation"] === "commit"
  );
  const clean = calls.some((call) => {
    if (call.name !== "vcs" || call.arguments?.["operation"] !== "status") return false;
    const details = record(record(call.execution?.result)?.["details"]);
    return record(details?.["result"])?.["clean"] === true;
  });
  if (!verified("test", "passed") || !verified("build", "ok") || !committed || !clean) {
    return {
      passed: false,
      reason:
        "The trajectory did not prove a passing focused test, successful build, committed repair, and clean final task state",
    };
  }
  return noIncompleteInvocations(result);
}

export const trustedUnitAuthoringTests: TestCase[] = [
  {
    name: "extension-edit-test-build",
    description:
      "Repair a trusted extension through its documented edit, focused-test, and build workflow",
    category: "extensions",
    workspaceRepoFixture: BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: focusedVerificationAuthority,
    prompt:
      'The disposable status extension keeps reporting "waiting" even though it is ready. Please fix it.',
    validation: "agent-evidence",
    validate: requireTrustedUnitRepair,
  },
  {
    name: "app-edit-test-build",
    description:
      "Repair a trusted terminal app through its documented edit, focused-test, and build workflow",
    category: "apps",
    workspaceRepoFixture: BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: focusedVerificationAuthority,
    prompt:
      'The disposable terminal app still prints "booting" after startup has completed. Please fix it.',
    validation: "agent-evidence",
    validate: requireTrustedUnitRepair,
  },
];
