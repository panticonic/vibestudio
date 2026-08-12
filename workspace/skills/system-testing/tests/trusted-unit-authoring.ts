import {
  BUILDABLE_APP_WORKSPACE_REPO_FIXTURE,
  BUILDABLE_EXTENSION_WORKSPACE_REPO_FIXTURE,
  type TestAuthorityPolicy,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import {
  getToolCalls,
  noIncompleteInvocations,
  type InvocationCardPayloadLike,
} from "./_helpers.js";

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

function successfulDetails(
  call: InvocationCardPayloadLike,
  name: string
): Record<string, unknown> | null {
  if (
    call.name !== name ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true
  ) {
    return null;
  }
  const envelope = record(call.execution.result);
  return envelope ? (record(envelope["details"]) ?? envelope) : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function workspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function unitForPath(value: unknown, section: "apps" | "extensions"): string | null {
  const path = workspacePath(value);
  if (!path) return null;
  const segments = path.split("/");
  return segments[0] === section && segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
}

interface ManagedMutationEvidence {
  index: number;
  contextId: string;
  applicationId: string;
  unit: string;
}

function managedMutation(
  call: InvocationCardPayloadLike,
  index: number,
  section: "apps" | "extensions"
): ManagedMutationEvidence | null {
  const details = successfulDetails(call, call.name);
  if (!details) return null;
  const paths =
    call.name === "apply_patch"
      ? details["status"] === "applied" && stringArray(details["paths"])
        ? details["paths"]
        : null
      : call.name === "edit" || call.name === "write"
        ? [call.arguments?.["path"] ?? details["path"]]
        : null;
  if (!paths || paths.length === 0) return null;

  const vcsResult = record(details["vcsResult"]);
  const contextId = vcsResult?.["contextId"];
  const applicationId = vcsResult?.["applicationId"];
  const workingHead = record(vcsResult?.["workingHead"]);
  const units = new Set(paths.map((path) => unitForPath(path, section)));
  if (
    typeof contextId !== "string" ||
    typeof applicationId !== "string" ||
    workingHead?.["kind"] !== "application" ||
    workingHead["applicationId"] !== applicationId ||
    typeof vcsResult?.["changeCount"] !== "number" ||
    vcsResult["changeCount"] < 1 ||
    units.size !== 1 ||
    units.has(null)
  ) {
    return null;
  }
  return { index, contextId, applicationId, unit: [...units][0]! };
}

function verificationMatches(
  call: InvocationCardPayloadLike,
  operation: "test" | "build",
  unit: string,
  contextId: string
): boolean {
  if (
    call.arguments?.["operation"] !== operation ||
    workspacePath(call.arguments?.["target"]) !== unit
  ) {
    return false;
  }
  const details = successfulDetails(call, "verify");
  if (
    details?.["operation"] !== operation ||
    workspacePath(details["target"]) !== unit ||
    details["status"] !== (operation === "test" ? "passed" : "ok")
  ) {
    return false;
  }
  if (operation === "test") {
    const report = record(details["report"]);
    return (
      report?.["contextId"] === contextId &&
      workspacePath(report["target"]) === unit &&
      typeof report["total"] === "number" &&
      report["total"] > 0 &&
      report["failed"] === 0
    );
  }
  const receipt = record(details["receipt"]);
  const receiptUnit = record(receipt?.["unit"]);
  return (
    receipt?.["protocol"] === "build-verification-receipt.v1" &&
    receipt["contextId"] === contextId &&
    receipt["ref"] === `ctx:${contextId}` &&
    workspacePath(receipt["target"]) === unit &&
    receipt["status"] === "ok" &&
    workspacePath(receiptUnit?.["repoPath"]) === unit
  );
}

function eventRef(value: unknown, eventId: string): boolean {
  const ref = record(value);
  return ref?.["kind"] === "event" && ref["eventId"] === eventId;
}

function zeroWorkingCounts(value: unknown): boolean {
  const counts = record(value);
  return counts?.["applications"] === 0 && counts["workUnits"] === 0 && counts["changes"] === 0;
}

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
    const details = successfulDetails(commitCall, "vcs");
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
