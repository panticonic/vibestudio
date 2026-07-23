import {
  BUILDABLE_REGULAR_WORKER_WORKSPACE_REPO_FIXTURE,
  BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationConsoleOutput,
  invocationReturnValue,
  requireCodeOperations,
  type ScenarioEvidence,
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

type CleanupObservation = "absent" | "proved" | "contradicted" | "inconclusive";

function explicitCleanupProof(values: readonly unknown[]): CleanupObservation {
  let present = false;
  let contradicted = false;

  const inventoryIdentity = (entry: unknown): string | undefined => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const id = (entry as Record<string, unknown>)["id"];
    return typeof id === "string" && id.length > 0 ? id : undefined;
  };

  const inventoriesMatch = (before: readonly unknown[], after: readonly unknown[]): boolean => {
    if (before.length !== after.length) return false;
    const beforeIds = before.map(inventoryIdentity);
    const afterIds = after.map(inventoryIdentity);
    if (beforeIds.every((id) => id !== undefined) && afterIds.every((id) => id !== undefined)) {
      return [...beforeIds].sort().every((id, index) => id === [...afterIds].sort()[index]);
    }
    return before.every((entry, index) => Object.is(entry, after[index]));
  };

  const proved = walkRecords(values).some((record) => {
    if (
      "createdId" in record ||
      "retiredId" in record ||
      "destroyedId" in record ||
      "before" in record ||
      "after" in record ||
      "beforeCount" in record ||
      "afterCreateCount" in record ||
      "afterDestroyCount" in record ||
      "existsAfterCreate" in record ||
      "existsAfterDestroy" in record
    ) {
      present = true;
    }
    const createdId = record["createdId"];
    const retiredId = record["retiredId"] ?? record["destroyedId"];
    const identityMatched =
      typeof createdId === "string" && createdId.length > 0 && retiredId === createdId;
    if (
      typeof createdId === "string" &&
      createdId.length > 0 &&
      typeof retiredId === "string" &&
      retiredId.length > 0 &&
      retiredId !== createdId
    ) {
      contradicted = true;
    }
    const before = record["before"];
    const after = record["after"];
    const inventoryRestored =
      Array.isArray(before) &&
      Array.isArray(after) &&
      inventoriesMatch(before, after);
    if (Array.isArray(before) && Array.isArray(after) && !inventoryRestored) {
      contradicted = true;
    }
    const observedLifecycle =
      record["existsAfterCreate"] === true && record["existsAfterDestroy"] === false;
    if (record["existsAfterDestroy"] === true) contradicted = true;
    const beforeCount = record["beforeCount"];
    const afterCreateCount = record["afterCreateCount"];
    const afterDestroyCount = record["afterDestroyCount"];
    const countRestored =
      typeof beforeCount === "number" &&
      Number.isSafeInteger(beforeCount) &&
      typeof afterCreateCount === "number" &&
      Number.isSafeInteger(afterCreateCount) &&
      typeof afterDestroyCount === "number" &&
      Number.isSafeInteger(afterDestroyCount) &&
      afterCreateCount > beforeCount &&
      afterDestroyCount === beforeCount;
    if (
      typeof beforeCount === "number" &&
      Number.isSafeInteger(beforeCount) &&
      typeof afterCreateCount === "number" &&
      Number.isSafeInteger(afterCreateCount) &&
      typeof afterDestroyCount === "number" &&
      Number.isSafeInteger(afterDestroyCount) &&
      (!countRestored || afterCreateCount <= beforeCount)
    ) {
      contradicted = true;
    }
    return identityMatched || inventoryRestored || observedLifecycle || countRestored;
  });
  if (contradicted) return "contradicted";
  if (proved) return "proved";
  return present ? "inconclusive" : "absent";
}

function completedLifecycleCodeProvesCleanup(evidence: ScenarioEvidence): boolean {
  return evidence.calls.some((call) => {
    if (
      call.name !== "eval" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const code = String(call.arguments?.["code"] ?? "");
    const directCreates = [
      ...code.matchAll(
        /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+workers\.create\s*\(/gu
      ),
    ];
    const rpcCreates = [
      ...code.matchAll(
        /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+rpc\.call\s*\(\s*["']main["']\s*,\s*["']runtime\.createEntity["']/gu
      ),
    ];
    const directResolutions = [
      ...code.matchAll(
        /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+workers\.resolveDurableObject\s*\(/gu
      ),
    ];
    const boundLifecycle = [...directCreates, ...rpcCreates, ...directResolutions].some((match) => {
      const handle = match[1]!;
      const suffix = code.slice((match.index ?? 0) + match[0].length);
      const escaped = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return (
        new RegExp(
          `\\bawait\\s+workers\\.destroy\\s*\\(\\s*${escaped}(?:\\.(?:id|targetId))?\\s*\\)`,
          "u"
        ).test(suffix) ||
        new RegExp(
          `\\bawait\\s+rpc\\.call\\s*\\(\\s*["']main["']\\s*,\\s*["']runtime\\.retireEntity["'][\\s\\S]*?\\b${escaped}\\.(?:id|targetId)\\b`,
          "u"
        ).test(suffix)
      );
    });
    if (boundLifecycle) return true;

    // Resolution is often wrapped in a small helper so the scenario can prove
    // that a later resolve reaches the same object. In that form there is no
    // direct syntactic binding between `resolveDurableObject` and the target
    // variable. A completed eval still proves cleanup when resolution occurs
    // before an awaited canonical retirement in the same invocation.
    const resolvedAt = code.indexOf("workers.resolveDurableObject");
    if (resolvedAt === -1) return false;
    const suffix = code.slice(resolvedAt);
    return (
      /\bawait\s+workers\.destroy\s*\(/u.test(suffix) ||
      /\bawait\s+rpc\.call\s*\(\s*["']main["']\s*,\s*["']runtime\.retireEntity["']/u.test(
        suffix
      )
    );
  });
}

function requireCleanup(evidence: ScenarioEvidence) {
  const explicit = explicitCleanupProof(evidence.evalValues);
  const proved =
    explicit === "proved" ||
    (explicit !== "contradicted" && completedLifecycleCodeProvesCleanup(evidence));
  return proved
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Completed lifecycle results did not prove the created runtime entity was retired",
      };
}

function requireSqlPersistenceEvidence(result: TestExecutionResult) {
  const base = lifecycleEvidence(result, [
    ["workers.create", "workers.destroy"],
    ["workers.resolveDurableObject", "workers.destroy"],
    ["runtime.createEntity", "runtime.retireEntity"],
  ]);
  if (!base.passed) return base;
  const code = base.evidence.evalCode;
  const objectCalls =
    code.match(/rpc\.call(?:<[^>]*>)?\s*\(\s*[^,\n]*(?:\.targetId|\btargetId\b)/gu)?.length ?? 0;
  if (objectCalls < 2) {
    return { passed: false, reason: "Completed eval did not make two separate object calls" };
  }

  const authoredImplementation = base.evidence.calls
    .filter(
      (call) =>
        call.execution?.status === "complete" &&
        call.execution.isError !== true &&
        ["write", "edit", "apply_patch", "vcs"].includes(call.name) &&
        /\.[cm]?[jt]sx?\b/u.test(String(call.arguments?.["path"] ?? ""))
    )
    .map((call) => JSON.stringify(call.arguments ?? {}))
    .join("\n");
  const implementationEvidence = `${code}\n${authoredImplementation}`;
  if (
    !/(?:this\.)?sql\.exec/u.test(implementationEvidence) ||
    !/\bINSERT\b/iu.test(implementationEvidence) ||
    !/\bSELECT\b/iu.test(implementationEvidence)
  ) {
    return { passed: false, reason: "Authored worker code did not persist and retrieve SQL rows" };
  }

  const structuredRows = walkRecords(base.evidence.evalValues).some((record) => {
    const rowCollections = Object.values(record).filter(
      (value): value is unknown[] =>
        Array.isArray(value) &&
        value.length >= 2 &&
        value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))
    );
    // `rows` is the compact documented shape. Natural implementations usually
    // name the two observations after their role (`afterWrite`, `afterReopen`,
    // `first`, `reopened`, …), so an explicit equality result is equally strong
    // evidence and avoids coupling the test to one return-property spelling.
    return (
      (Array.isArray(record["rows"]) && record["rows"].length >= 2) ||
      (record["persisted"] === true && rowCollections.length >= 1)
    );
  });
  const loggedRows = base.evidence.calls.some((call) => {
    if (call.name !== "eval" || call.execution?.status !== "complete") return false;
    const output = invocationConsoleOutput(call) ?? "";
    return [...output.matchAll(/\[[^\[\]]*\]/gsu)].some((match) => {
      try {
        const value: unknown = JSON.parse(match[0]);
        return Array.isArray(value) && value.length >= 2;
      } catch {
        return false;
      }
    });
  });
  if (!structuredRows && !loggedRows) {
    return { passed: false, reason: "The second object call did not return the persisted rows" };
  }
  return requireCleanup(base.evidence);
}

function requireDynamicWorkspaceServiceEvidence(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;

  const discovered = base.evidence.calls.some((call) => {
    if (call.name === "docs_search" || call.name === "docs_open") {
      return call.execution?.status === "complete" && call.execution.isError !== true;
    }
    if (call.name !== "eval" || call.execution?.status !== "complete") return false;
    return /docs\.(?:search|describe)\s*\(/u.test(String(call.arguments?.["code"] ?? ""));
  });
  if (!discovered) {
    return {
      passed: false,
      reason: "The agent did not consult the live caller-context service documentation",
    };
  }

  const evalCalls = base.evidence.calls.filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  const invoked = evalCalls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return /workers\.resolveService\s*\(/u.test(code) && /rpc\.call\s*\(/u.test(code);
  });
  const returned = invoked ? invocationReturnValue(invoked) : { present: false as const };
  if (!returned.present || !hasNonEmptyStructuredResult([returned.value])) {
    return {
      passed: false,
      reason: "No completed eval dynamically resolved and invoked the authored service",
    };
  }

  const authored = base.evidence.calls.some((call) => {
    if (call.name === "workspace_service") {
      return (
        call.execution?.status === "complete" &&
        call.execution.isError !== true &&
        call.arguments?.["operation"] === "upsert"
      );
    }
    const serialized = JSON.stringify(call.arguments ?? {});
    return (
      /meta\/vibestudio\.yml/u.test(serialized) &&
      /services\s*:|singletonObjects\s*:/u.test(serialized)
    );
  });
  if (!authored) {
    return {
      passed: false,
      reason: "The trajectory did not author a service declaration in meta/vibestudio.yml",
    };
  }

  const staticCatalogWorkaround = base.evidence.calls.some((call) =>
    /(?:generated|AuthorityGrantCatalog|productAuthorityGrantCatalog|capability-catalog)/iu.test(
      JSON.stringify(call.arguments ?? {})
    )
  );
  return staticCatalogWorkaround
    ? {
        passed: false,
        reason: "The agent attempted to make workspace authority work through a static catalog",
      }
    : { passed: true, reason: undefined };
}

function requireInstalledWorkspaceServiceConsumerEvidence(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;

  const serializedCalls = base.evidence.calls.map((call) => JSON.stringify(call.arguments ?? {}));
  if (
    !base.evidence.calls.some(
      (call) =>
        (call.name === "docs_search" || call.name === "docs_open") &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    ) &&
    !base.evidence.evalCode.match(/docs\.(?:search|describe)\s*\(/u)
  ) {
    return { passed: false, reason: "The agent did not consult live capability documentation" };
  }

  const manifestEdits = serializedCalls.filter((value) => /package\.json/u.test(value));
  if (!manifestEdits.some((value) => /workspace-service:[A-Za-z0-9._/-]+/u.test(value))) {
    return {
      passed: false,
      reason: "No installed-unit manifest edit declared an exact workspace service request",
    };
  }
  if (manifestEdits.some((value) => /workspace-service:\*/u.test(value))) {
    return {
      passed: false,
      reason: "Installed code requested the eval-only workspace service wildcard",
    };
  }
  if (!serializedCalls.some((value) => /index\.ts/u.test(value) && /resolveService/u.test(value))) {
    return { passed: false, reason: "The installed consumer did not resolve a live service" };
  }

  const createdHandles = [
    ...base.evidence.evalCode.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:workers\.create|runtime\.createEntity)\s*\(/gu
    ),
  ].map((match) => match[1]!);
  const calledCreatedTarget = createdHandles.some((handle) => {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `\\brpc\\.call(?:<[^>]*>)?\\s*\\(\\s*${escaped}\\.(?:id|targetId)\\s*,`,
      "u"
    ).test(base.evidence.evalCode);
  });
  if (createdHandles.length === 0 || !calledCreatedTarget) {
    return {
      passed: false,
      reason: "The proof did not execute and call the context-built installed unit",
    };
  }
  if (!hasNonEmptyStructuredResult(base.evidence.evalValues)) {
    return {
      passed: false,
      reason: "The installed consumer returned no observable service result",
    };
  }
  const cleanup = requireCleanup(base.evidence);
  if (!cleanup.passed) return cleanup;

  if (
    serializedCalls.some((value) =>
      /(?:generated|AuthorityGrantCatalog|productAuthorityGrantCatalog|capability-catalog)/iu.test(
        value
      )
    )
  ) {
    return {
      passed: false,
      reason: "The agent tried to approve dynamic authority through a static catalog",
    };
  }
  return { passed: true, reason: undefined };
}

export const workerTests: TestCase[] = [
  {
    name: "list-sources",
    description: "List available worker types",
    category: "workers",
    prompt: "Which workers can I start here?",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.listSources"],
        ["workspace.units.list"],
      ]);
      if (!base.passed) return base;
      const returnedRows = walkArrays(base.evidence.evalValues).some((value) => value.length > 0);
      const loggedRows = base.evidence.calls.some((call) => {
        if (
          call.name !== "eval" ||
          call.execution?.status !== "complete" ||
          call.execution.isError === true ||
          !String(call.arguments?.["code"] ?? "").includes("workers.listSources")
        ) {
          return false;
        }
        const output = invocationConsoleOutput(call) ?? "";
        return /\bsourcesCount\s+[1-9]\d*\b/u.test(output) || /"source"\s*:\s*"workers\//u.test(output);
      });
      return returnedRows || loggedRows
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
      return base.passed ? requireCleanup(base.evidence) : base;
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
      return base.passed ? requireCleanup(base.evidence) : base;
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
    workspaceRepoFixture: BUILDABLE_REGULAR_WORKER_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Temporarily run a disposable worker with a non-secret probe setting, verify what the worker itself observes, and clean it up.",
    validate: (result) => {
      const base = lifecycleEvidence(result, [
        ["workers.create", "env", "workers.destroy"],
        ["runtime.createEntity", "env", "runtime.retireEntity"],
      ]);
      if (!base.passed) return base;
      const probeInvocation = base.evidence.calls.find((call) => {
        if (
          call.name !== "eval" ||
          call.execution?.status !== "complete" ||
          call.execution.isError === true
        ) {
          return false;
        }
        const code = String(call.arguments?.["code"] ?? "");
        const probes = [
          ...code.matchAll(
            /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+rpc\.call(?:<[^>]*>)?\s*\(\s*[^,\n]*(?:\.targetId|targetId)\s*,/gu
          ),
          ...code.matchAll(
            /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+gatewayFetch\s*\(/gu
          ),
        ];
        return probes.some((match) => {
          const value = match[1]!;
          const suffix = code.slice((match.index ?? 0) + match[0].length);
          const observedValues = new Set([value]);
          const declarations = [
            ...suffix.matchAll(
              /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;]+)?\s*=\s*([\s\S]*?);/gu
            ),
          ];
          let changed = true;
          while (changed) {
            changed = false;
            for (const declaration of declarations) {
              const name = declaration[1]!;
              const expression = declaration[2]!;
              if (observedValues.has(name)) continue;
              const dependsOnObservedValue = [...observedValues].some((candidate) =>
                new RegExp(
                  `\\b${candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`,
                  "u"
                ).test(expression)
              );
              if (dependsOnObservedValue) {
                observedValues.add(name);
                changed = true;
              }
            }
          }
          return [...observedValues].some((candidate) => {
            const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            return (
              new RegExp(`\\breturn\\b[\\s\\S]*?\\b${escaped}\\b`, "u").test(suffix) ||
              new RegExp(`\\bconsole\\.log\\s*\\([^)]*\\b${escaped}\\b`, "u").test(suffix)
            );
          });
        });
      });
      if (!probeInvocation) {
        return { passed: false, reason: "The worker-side probe result was not observed" };
      }
      const returned = invocationReturnValue(probeInvocation);
      const logged = invocationConsoleOutput(probeInvocation)?.trim() ?? "";
      if (
        (!returned.present || !hasNonEmptyStructuredResult([returned.value])) &&
        logged.length === 0
      ) {
        return { passed: false, reason: "The worker-side probe returned no evidence" };
      }
      return requireCleanup(base.evidence);
    },
  },
  {
    name: "dynamic-workspace-service",
    description: "Author and consume a service that exists only in the task context",
    category: "workers",
    workspaceRepoFixture: BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Give the disposable worker in this task a small context-local service that reports a value, discover it the same way another workspace unit would, call it, and tell me what answered. Do not publish anything.",
    validate: requireDynamicWorkspaceServiceEvidence,
  },
  {
    name: "installed-workspace-service-consumer",
    description: "Installed workspace code consumes a context-local userland service",
    category: "workers",
    workspaceRepoFixture: BUILDABLE_REGULAR_WORKER_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Have the disposable worker in this task consume one of the small workspace services already visible in its context through the normal installed-unit path, prove the result, and keep everything local.",
    validate: requireInstalledWorkspaceServiceConsumerEvidence,
  },
];
