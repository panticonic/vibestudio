import {
  BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";

function lifecycleEvidence(
  result: TestExecutionResult,
  operations: readonly (readonly string[])[]
) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const exercised = requireCodeOperations(base.evidence.evalCode, operations);
  if (!exercised.passed) return exercised;
  return { passed: true as const, evidence: base.evidence };
}

function cleanupProved(values: readonly unknown[]): boolean {
  return walkRecords(values).some((record) => {
    const createdId = record["createdId"];
    const retiredId = record["retiredId"] ?? record["destroyedId"];
    const identityMatched =
      typeof createdId === "string" && createdId.length > 0 && retiredId === createdId;
    const before = record["before"];
    const after = record["after"];
    const inventoryRestored =
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((entry, index) => entry === after[index]);
    return identityMatched || inventoryRestored;
  });
}

function requireCleanup(values: readonly unknown[]) {
  return cleanupProved(values)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Completed lifecycle results did not prove the created worker was retired",
      };
}

function requireSqlPersistenceEvidence(result: TestExecutionResult) {
  const base = lifecycleEvidence(result, [
    ["workers.create", "workers.destroy"],
    ["runtime.createEntity", "runtime.retireEntity"],
  ]);
  if (!base.passed) return base;
  const code = base.evidence.evalCode;
  const objectCalls =
    code.match(/rpc\.call(?:<[^>]*>)?\s*\(\s*[^,\n]*(?:\.targetId|\btargetId\b)/gu)?.length ?? 0;
  if (objectCalls < 2) {
    return { passed: false, reason: "Completed eval did not make two separate object calls" };
  }
  if (
    !/(?:this\.)?sql\.exec/u.test(code) ||
    !/\bINSERT\b/iu.test(code) ||
    !/\bSELECT\b/iu.test(code)
  ) {
    return { passed: false, reason: "Authored worker code did not persist and retrieve SQL rows" };
  }
  if (
    !walkRecords(base.evidence.evalValues).some(
      (record) => Array.isArray(record["rows"]) && record["rows"].length >= 2
    )
  ) {
    return { passed: false, reason: "The second object call did not return the persisted rows" };
  }
  return requireCleanup(base.evidence.evalValues);
}

export const workerTests: TestCase[] = [
  {
    name: "list-sources",
    description: "List available worker types",
    category: "workers",
    prompt: "Tell me which worker sources are available here.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [["workers.listSources"]]);
      if (!base.passed) return base;
      return walkArrays(base.evidence.evalValues).some((value) => value.length > 0)
        ? { passed: true, reason: undefined }
        : { passed: false, reason: "The completed source listing returned no source rows" };
    },
  },
  {
    name: "create-worker",
    description: "Create a worker instance",
    category: "workers",
    prompt: "Temporarily start a worker, confirm that it exists, and leave no instance behind.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.create", "workers.destroy"],
        ["runtime.createEntity", "runtime.retireEntity"],
      ]);
      return base.passed ? requireCleanup(base.evidence.evalValues) : base;
    },
  },
  {
    name: "list-workers",
    description: "List running worker instances",
    category: "workers",
    prompt: "Inspect the worker instances that are currently running and summarize what you found.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.list"],
        ["runtime.listEntities"],
        ["workspace.units.list"],
      ]);
      return base.passed && walkArrays(base.evidence.evalValues).length > 0
        ? { passed: true, reason: undefined }
        : base.passed
          ? { passed: false, reason: "The completed worker listing returned no array" }
          : base;
    },
  },
  {
    name: "create-destroy",
    description: "Create a worker and then destroy it",
    category: "workers",
    prompt: "Verify that a temporary worker can be started and fully retired.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.create", "workers.list", "workers.destroy"],
        ["runtime.createEntity", "runtime.listEntities", "runtime.retireEntity"],
      ]);
      return base.passed ? requireCleanup(base.evidence.evalValues) : base;
    },
  },
  {
    name: "call-do-method",
    description: "Call a method on a Durable Object worker",
    category: "workers",
    prompt: "Call a harmless method on a worker Durable Object and report the observed result.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [["rpc.call"]]);
      if (!base.passed) return base;
      return hasNonEmptyStructuredResult(base.evidence.evalValues)
        ? { passed: true, reason: undefined }
        : { passed: false, reason: "The completed object call returned no observable result" };
    },
  },
  {
    name: "worker-do-sql-persistence",
    description: "A Durable Object's own storage persists data across separate calls",
    category: "workers",
    workspaceRepoFixture: BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create a tiny disposable Durable Object that stores a couple of rows, verify they persist into a later call, and clean up everything you started.",
    validate: requireSqlPersistenceEvidence,
  },
  {
    name: "worker-env",
    description: "Create a worker with environment variables",
    category: "workers",
    workspaceRepoFixture: BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Temporarily run a disposable worker with a non-secret probe setting, verify what the worker itself observes, and clean it up.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.create", "env", "workers.destroy"],
        ["runtime.createEntity", "env", "runtime.retireEntity"],
      ]);
      if (!base.passed) return base;
      if (
        !/rpc\.call(?:<[^>]*>)?\s*\(\s*[^,\n]*(?:\.targetId|targetId)\s*,|gatewayFetch\s*\(/u.test(
          base.evidence.evalCode
        )
      ) {
        return { passed: false, reason: "The worker-side probe was never observed" };
      }
      const observed = walkRecords(base.evidence.evalValues).some((record) => {
        const value = record["observed"] ?? record["workerValue"];
        return value !== undefined && value !== null && value !== "";
      });
      if (!observed) {
        return { passed: false, reason: "The worker-side probe returned no evidence" };
      }
      return requireCleanup(base.evidence.evalValues);
    },
  },
];
