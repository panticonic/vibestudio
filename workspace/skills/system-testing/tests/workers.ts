import { CONTENT_WORKSPACE_REPO_FIXTURE, type TestCase } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  finalMessageHasMarkerCount,
  getToolCalls,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  if (!completedToolNames(result).has("eval")) {
    return { passed: false, reason: `Expected a completed eval call for ${tokens.join(", ")}` };
  }
  return noIncompleteInvocations(result);
}

function successfulEvalCode(result: Parameters<typeof finalMessageHasAll>[0]): string {
  return getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
}

function requireEvalEvidence(
  result: Parameters<typeof finalMessageHasAll>[0],
  required: readonly string[],
  anyPattern?: RegExp
) {
  const code = successfulEvalCode(result);
  const missing = required.filter((token) => !code.includes(token));
  if (missing.length > 0) {
    return { passed: false, reason: `Successful eval did not exercise ${missing.join(", ")}` };
  }
  if (anyPattern && !anyPattern.test(code)) {
    return { passed: false, reason: "Successful eval did not contain worker-side observation" };
  }
  return { passed: true };
}

function requireAnyEvalEvidence(
  result: Parameters<typeof finalMessageHasAll>[0],
  alternatives: readonly (readonly string[])[],
  anyPattern?: RegExp
) {
  const code = successfulEvalCode(result);
  const matched = alternatives.some((required) => required.every((token) => code.includes(token)));
  if (!matched) {
    return {
      passed: false,
      reason: `Successful eval did not exercise any supported path: ${alternatives
        .map((tokens) => tokens.join(" + "))
        .join(" or ")}`,
    };
  }
  if (anyPattern && !anyPattern.test(code)) {
    return { passed: false, reason: "Successful eval did not contain worker-side observation" };
  }
  return { passed: true };
}

function checkedOutcome(
  result: Parameters<typeof finalMessageHasAll>[0],
  okMarker: string,
  failureMarker: string,
  evidence: () => { passed: boolean; reason?: string }
) {
  if (finalMessageHasAll(result, [failureMarker]).passed) {
    return {
      passed: false,
      reason: `Agent reported ${failureMarker}; ${okMarker} was not verified`,
    };
  }
  const base = checked(result, [okMarker]);
  if (!base.passed) return base;
  return evidence();
}

export const workerTests: TestCase[] = [
  {
    name: "list-sources",
    description: "List available worker types",
    category: "workers",
    prompt:
      "Exercise listing worker sources. Finish with WORKER_SOURCES_OK followed by the numeric count.",
    validate: (result) => {
      const msg = finalMessageHasMarkerCount(result, "WORKER_SOURCES_OK");
      if (!msg.passed) return msg;
      const base = checked(result, ["WORKER_SOURCES_OK"]);
      if (!base.passed) return base;
      return requireEvalEvidence(result, ["workers.listSources"]);
    },
  },
  {
    name: "create-worker",
    description: "Create a worker instance",
    category: "workers",
    prompt:
      "Exercise creating and cleaning up a worker. Finish with WORKER_CREATE_OK and destroyed.",
    validate: (result) => {
      const base = checked(result, ["WORKER_CREATE_OK", "destroyed"]);
      if (!base.passed) return base;
      return requireAnyEvalEvidence(result, [
        ["workers.create", "workers.destroy"],
        ["runtime.createEntity", "runtime.retireEntity"],
      ]);
    },
  },
  {
    name: "list-workers",
    description: "List running worker instances",
    category: "workers",
    prompt:
      "Exercise listing running workers. Finish with WORKER_LIST_OK followed by the numeric count.",
    validate: (result) => {
      const msg = finalMessageHasMarkerCount(result, "WORKER_LIST_OK");
      if (!msg.passed) return msg;
      const base = checked(result, ["WORKER_LIST_OK"]);
      if (!base.passed) return base;
      return requireAnyEvalEvidence(result, [
        ["workers.list"],
        ["runtime.listEntities"],
        ["workspace.units.list"],
      ]);
    },
  },
  {
    name: "create-destroy",
    description: "Create a worker and then destroy it",
    category: "workers",
    prompt:
      "Exercise worker destruction. Finish with WORKER_DESTROY_OK or WORKER_DESTROY_MISMATCH.",
    validate: (result) =>
      checkedOutcome(result, "WORKER_DESTROY_OK", "WORKER_DESTROY_MISMATCH", () =>
        requireAnyEvalEvidence(result, [
          ["workers.create", "workers.list", "workers.destroy"],
          ["runtime.createEntity", "runtime.listEntities", "runtime.retireEntity"],
        ])
      ),
  },
  {
    name: "call-do-method",
    description: "Call a method on a Durable Object worker",
    category: "workers",
    prompt:
      "Exercise calling a worker Durable Object. Finish with WORKER_DO_OK or WORKER_DO_UNAVAILABLE.",
    validate: (result) =>
      checkedOutcome(result, "WORKER_DO_OK", "WORKER_DO_UNAVAILABLE", () =>
        requireEvalEvidence(result, ["rpc.call"])
      ),
  },
  {
    name: "worker-do-sql-persistence",
    description: "A Durable Object's own storage persists data across separate calls",
    category: "workers",
    prompt:
      "Demonstrate that a Durable Object app can persist data in its own storage: store a couple of rows through a DO's methods in one call, then read them back through a second, separate call to the same object and confirm they survived. Clean up anything you created. Finish with WORKER_DO_SQL_OK and rows:<count>, or WORKER_DO_SQL_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) =>
      checkedOutcome(result, "WORKER_DO_SQL_OK", "WORKER_DO_SQL_UNAVAILABLE", () => {
        const marker = finalMessageHasAll(result, ["rows:"]);
        if (!marker.passed) return marker;
        return requireEvalEvidence(result, ["rpc.call"]);
      }),
  },
  {
    name: "worker-env",
    description: "Create a worker with environment variables",
    category: "workers",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Exercise worker environment configuration with a disposable worker you author in the harness-owned workspace namespace. Expose and call one fixed method that returns only the named non-secret probe binding, prove the running worker observed the configured value, and retire it. Finish with WORKER_ENV_OK or WORKER_ENV_UNOBSERVABLE.",
    validate: (result) =>
      checkedOutcome(result, "WORKER_ENV_OK", "WORKER_ENV_UNOBSERVABLE", () =>
        requireAnyEvalEvidence(
          result,
          [
            ["workers.create", "env", "workers.destroy"],
            ["runtime.createEntity", "env", "runtime.retireEntity"],
          ],
          /rpc\.call(?:<[^>]*>)?\s*\(\s*[^,\n]*(?:\.targetId|targetId)\s*,|gatewayFetch\s*\(/
        )
      ),
  },
];
