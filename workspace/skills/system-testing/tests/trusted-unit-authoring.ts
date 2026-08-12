import {
  BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
  BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
  type TestAuthorityPolicy,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { getToolCalls, noIncompleteInvocations } from "./_helpers.js";
import {
  eventRef,
  managedMutation,
  record,
  stringArray,
  successfulToolDetails,
  verificationMatches,
  zeroWorkingCounts,
} from "./_managed-unit-evidence.js";

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

function requireTrustedUnitRepair(result: TestExecutionResult, section: "apps" | "extensions") {
  const incomplete = noIncompleteInvocations(result);
  if (!incomplete.passed) return incomplete;

  const calls = getToolCalls(result);
  const mutations = calls.flatMap((call, index) => {
    const evidence = managedMutation(call, index, section);
    return evidence ? [evidence] : [];
  });
  if (mutations.length === 0) {
    return { passed: false, reason: `No completed managed ${section} mutation was observed` };
  }
  const contexts = new Set(mutations.map(({ contextId }) => contextId));
  const units = new Set(mutations.map(({ unit }) => unit));
  const applicationIds = mutations.map(({ applicationId }) => applicationId);
  if (
    contexts.size !== 1 ||
    units.size !== 1 ||
    new Set(applicationIds).size !== applicationIds.length
  ) {
    return {
      passed: false,
      reason:
        "Managed repair mutations did not form one context-local application chain for one unit",
    };
  }
  const contextId = [...contexts][0]!;
  const unit = [...units][0]!;
  const lastMutationIndex = mutations.at(-1)!.index;

  for (let commitIndex = lastMutationIndex + 1; commitIndex < calls.length; commitIndex++) {
    const commitCall = calls[commitIndex]!;
    if (commitCall.name !== "vcs" || commitCall.arguments?.["operation"] !== "commit") continue;
    const details = successfulToolDetails(commitCall, "vcs");
    const commit = details && record(details["result"]);
    const event = commit && record(commit["event"]);
    const eventId = event?.["kind"] === "event" ? event["eventId"] : null;
    const committedApplicationIds = commit?.["committedApplicationIds"];
    if (
      commit?.["contextId"] !== contextId ||
      typeof eventId !== "string" ||
      !stringArray(committedApplicationIds) ||
      committedApplicationIds.length !== applicationIds.length ||
      !committedApplicationIds.every((id, index) => id === applicationIds[index])
    ) {
      continue;
    }

    // Verify receipts bind the exact context and unit but do not yet carry the
    // observed working-head application. Keep them inside the final-mutation →
    // whole-chain-commit window: this is the strongest causal observation the
    // current receipt schema can prove without reconstructing semantic state.
    const verificationWindow = calls.slice(lastMutationIndex + 1, commitIndex);
    const tested = verificationWindow.some((call) =>
      verificationMatches(call, "test", unit, contextId)
    );
    const built = verificationWindow.some((call) =>
      verificationMatches(call, "build", unit, contextId)
    );
    const status = record(details?.["status"]);
    if (
      tested &&
      built &&
      status?.["contextId"] === contextId &&
      status["clean"] === true &&
      eventRef(status["committed"], eventId) &&
      eventRef(status["workingHead"], eventId) &&
      zeroWorkingCounts(status["workingCounts"])
    ) {
      return { passed: true, reason: undefined };
    }
  }
  return {
    passed: false,
    reason:
      "No causal repair episode joined post-mutation test and build evidence for one unit to its complete application-chain commit and exact clean event",
  };
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
    validate: (result) => requireTrustedUnitRepair(result, "extensions"),
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
    validate: (result) => requireTrustedUnitRepair(result, "apps"),
  },
];
