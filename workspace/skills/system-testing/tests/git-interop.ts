import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalObservedValues,
  successfulEvalReturnValues,
} from "./_helpers.js";

interface ObservedGitImport {
  path: string;
  remoteUrl: string;
  contextId: string;
  eventId: string;
  semanticEvidence?: {
    applicationId: string;
    workUnitId: string;
    externalSnapshot: Record<string, unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) records(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  found.push(value);
  for (const child of Object.values(value)) records(child, found);
  return found;
}

function arrays(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    found.push(value);
    for (const item of value) arrays(item, found);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) arrays(child, found);
  }
  return found;
}

function exactNumber(message: string, value: number): boolean {
  if (new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message)) return true;
  const word =
    [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ][value] ?? null;
  return word ? new RegExp(`\\b${word}\\b`, "iu").test(message) : false;
}

function canonicalGitMethodMentioned(code: string, method: string): boolean {
  return (
    code.includes(`git.${method}`) ||
    new RegExp(`["']gitInterop\\.${method}["']`, "u").test(code)
  );
}

function isManagedCommitCall(call: ReturnType<typeof getToolCalls>[number]): boolean {
  return (
    call.name === "commit" ||
    (call.name === "vcs" &&
      (call.arguments?.["operation"] === "commit" ||
        (call.arguments?.["operation"] === undefined &&
          typeof call.arguments?.["message"] === "string" &&
          call.arguments["message"].trim().length > 0)))
  );
}

function unavailableGitResult(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const failed = getToolCalls(result).some(
    (call) =>
      call.name === "eval" &&
      call.execution?.isError === true &&
      /\bgit\./iu.test(String(call.arguments?.["code"] ?? ""))
  );
  const final = findLastAgentMessage(result);
  return failed &&
    /(unavailable|blocked|unsupported|cannot|could not|failed)/iu.test(final) &&
    final.trim().length > 20
    ? noIncompleteInvocations(result)
    : {
        passed: false,
        reason: "Git unavailability was not backed by a failed canonical invocation",
      };
}

function upstreamStatusChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  if (!canonicalGitMethodMentioned(successfulEvalCode(result), "upstreamStatus")) {
    return {
      passed: false,
      reason: "No successful canonical Git upstream-status call was observed",
    };
  }
  const observedStatuses = successfulEvalObservedValues(result)
    .flatMap((value) => arrays(value))
    .find((items) =>
      items.every(
        (item) =>
          isRecord(item) &&
          (typeof item["repoPath"] === "string" || typeof item["repo"] === "string") &&
          typeof item["state"] === "string" &&
          ((typeof item["autoPush"] === "boolean" &&
            Number.isInteger(item["aheadBy"]) &&
            Number.isInteger(item["behindBy"])) ||
            (typeof item["remote"] === "string" && typeof item["branch"] === "string"))
      )
    );
  if (!observedStatuses)
    return { passed: false, reason: "Git status result contained no canonical row set" };
  const statuses = observedStatuses.map((item) => {
    const status = item as Record<string, unknown>;
    return {
      repoPath: String(status["repoPath"] ?? status["repo"]),
      state: String(status["state"]),
    };
  });
  const final = findLastAgentMessage(result);
  if (!exactNumber(final, statuses.length)) {
    return { passed: false, reason: "Final response did not report the observed upstream count" };
  }
  if (statuses.length === 0) {
    return /no|none|zero|not track/iu.test(final)
      ? noIncompleteInvocations(result)
      : { passed: false, reason: "Final response did not explain the empty upstream set" };
  }
  const cited = statuses.some(
    (item) =>
      isRecord(item) &&
      final.includes(String(item["repoPath"])) &&
      final.toLowerCase().includes(String(item["state"]).toLowerCase())
  );
  return cited
    ? noIncompleteInvocations(result)
    : { passed: false, reason: "Final response did not cite an observed repository and state" };
}

function disposableFollowUpPushChecked(result: TestExecutionResult) {
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  const code = successfulEvalCode(result);
  const required = [
    "createDisposableRemote",
    "setSharedRemote",
    "setUpstream",
    "pushUpstream",
    "inspectDisposableRemote",
    "detachUpstream",
    "removeDisposableRemote",
  ];
  if (
    !required.every((method) => canonicalGitMethodMentioned(code, method))
  ) {
    return {
      passed: false,
      reason: "The two-phase scenario did not use the complete canonical Git upstream lifecycle",
    };
  }
  const pushCount =
    (code.match(/git\.pushUpstream/gu)?.length ?? 0) +
    (code.match(/["']gitInterop\.pushUpstream["']/gu)?.length ?? 0);
  if (pushCount < 2) {
    return {
      passed: false,
      reason: "The initial publication and follow-up managed edit were not pushed separately",
    };
  }

  const calls = getToolCalls(result);
  const managedMutations = calls.filter((call) => call.name === "edit" || call.name === "write");
  const commits = calls.filter(isManagedCommitCall);
  const publications = calls.filter(
    (call) =>
      (call.name === "vcs" && call.arguments?.["operation"] === "push") ||
      (call.name === "push" && call.arguments?.["operation"] === undefined)
  );
  if (managedMutations.length < 2 || commits.length < 2 || publications.length < 2) {
    return {
      passed: false,
      reason:
        "The scenario did not make, commit, and publish both managed GAD edits before their Git pushes",
    };
  }

  const all = records(successfulEvalReturnValues(result));
  const remote = all.find(
    (item) =>
      typeof item["id"] === "string" &&
      typeof item["url"] === "string" &&
      typeof item["branch"] === "string" &&
      Number.isInteger(item["expiresAt"])
  );
  const inspections = remote
    ? all.filter(
        (item) =>
          item["id"] === remote["id"] &&
          item["url"] === remote["url"] &&
          Number.isInteger(item["commitCount"]) &&
          typeof item["headCommit"] === "string"
      )
    : [];
  const first = inspections[0];
  const last = inspections.at(-1);
  const final = findLastAgentMessage(result);
  const removed =
    all.some((item) => item["removed"] === true) ||
    canonicalGitMethodMentioned(code, "removeDisposableRemote");
  if (
    !remote ||
    !first ||
    !last ||
    inspections.length < 2 ||
    Number(last["commitCount"]) <= Number(first["commitCount"]) ||
    last["headCommit"] === first["headCommit"] ||
    !removed
  ) {
    return {
      passed: false,
      reason: "Remote inspection did not prove a later head with more commits followed by cleanup",
    };
  }
  return (
    final.includes(String(last["headCommit"])) &&
    /after|advanced|follow-up|progression|second|later|again/iu.test(final)
  )
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The final response did not identify the verified follow-up remote head",
      };
}

async function orchestrateDisposableFollowUpPush(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const repoName = context.runner.workspaceRepoName;
  if (!repoName) throw new Error("Git follow-up scenario requires a seeded repository fixture");
  const repoPath = `packages/${repoName}`;
  let session: HeadlessSession | undefined;
  let snapshot: SessionSnapshot | undefined;
  let error: string | undefined;
  const cleanupErrors: string[] = [];

  try {
    session = await context.runner.spawn({ context: "task" });
    await context.sendAndWait(
      session,
      `Work only in ${repoPath}. Make one distinctive managed source edit, commit it, and publish that exact clean GAD milestone to protected main. Stop after the GAD publication and report its exact event identity; I will give you the Git publication destination separately.`,
      "publish the initial managed milestone through GAD"
    );
    await context.sendAndWait(
      session,
      `Create a credential-free disposable Git remote that will survive my next follow-up. Declare that exact remote as ${repoPath}'s manual upstream, call pushUpstream for the already-published protected-main milestone, and inspect the same remote. Do not use publishToDisposableRemote because it creates and deletes a separate one-call remote. Keep the created remote and tracking configuration; report the exact remote URL, head, and commit count.`,
      "push the initial protected-main milestone to a persistent disposable upstream"
    );
    await context.sendAndWait(
      session,
      `Now make a second distinctive managed source edit in the same ${repoPath}, commit and publish it through GAD VCS, then use the configured Git Bridge to push that later protected-main snapshot upstream. Inspect the same disposable remote again and prove its head and commit count advanced. Finally call detachUpstream for this repo with { forgetRemote: true }, remove that disposable remote, and stop using the deleted URL. Report both observed Git heads and counts.`,
      "edit through GAD and push the follow-up milestone upstream"
    );
    snapshot = session.snapshot();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    try {
      snapshot = session?.snapshot();
    } catch {
      // The primary orchestration error remains the useful failure.
    }
  }

  const messages = session ? ([...session.messages] as ChatMessage[]) : [];
  if (session) {
    try {
      await session.close();
      cleanupErrors.push(
        ...session.snapshot().cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`)
      );
    } catch (cause) {
      cleanupErrors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return {
    messages,
    duration: Date.now() - startedAt,
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error } : {}),
    ...(cleanupErrors.length > 0
      ? {
          cleanupErrors,
          error: error ?? `Headless cleanup failed: ${cleanupErrors.join("; ")}`,
        }
      : {}),
    diagnostics: { orchestrated: true, repoPath, phases: 3 },
  };
}

function commitMappingChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  const code = successfulEvalCode(result);
  if (
    !canonicalGitMethodMentioned(code, "publishToDisposableRemote") ||
    !canonicalGitMethodMentioned(code, "commitMapping")
  ) {
    return {
      passed: false,
      reason: "The mapping scenario did not export and inspect the supplied repository",
    };
  }
  const calls = getToolCalls(result);
  if (
    !calls.some((call) => call.name === "edit" || call.name === "write") ||
    !calls.some(isManagedCommitCall) ||
    !calls.some(
      (call) =>
        (call.name === "vcs" && call.arguments?.["operation"] === "push") ||
        (call.name === "push" && call.arguments?.["operation"] === undefined)
    )
  ) {
    return {
      passed: false,
      reason: "The exported mapping was not produced from a managed edit, commit, and publication",
    };
  }
  const values = successfulEvalObservedValues(result);
  const published = records(values).find(
    (item) =>
      typeof item["repoPath"] === "string" &&
      item["pushed"] === true &&
      Number.isInteger(item["commitCount"]) &&
      Number(item["commitCount"]) > 0 &&
      typeof item["headCommit"] === "string"
  );
  if (!published) {
    return {
      passed: false,
      reason: "Disposable Git export did not return a verified remote head",
    };
  }
  const isMappingRow = (item: unknown): item is Record<string, unknown> =>
    isRecord(item) &&
    typeof item["gitSha"] === "string" &&
    typeof item["eventId"] === "string" &&
    typeof item["summary"] === "string";
  const completeMappings = values
    .flatMap((value) => arrays(value))
    .find((items) => items.length > 0 && items.every(isMappingRow));
  const projectedMappings = records(values)
    .map((item) => {
      const count = item["mappingCount"] ?? item["count"];
      const first = item["firstMapping"] ?? item["first"] ?? item["head"];
      return Number.isInteger(count) && Number(count) > 0 && isMappingRow(first)
        ? { count: Number(count), first }
        : null;
    })
    .find((item) => item !== null);
  const mappingCount = completeMappings?.length ?? projectedMappings?.count ?? 0;
  const observedMappings =
    completeMappings ?? (projectedMappings ? [projectedMappings.first] : []);
  if (mappingCount === 0 || observedMappings.length === 0)
    return { passed: false, reason: "Git commit mapping result had no canonical rows" };
  const final = findLastAgentMessage(result);
  const cited = observedMappings.some(
    (item) =>
      isRecord(item) &&
      final.includes(String(item["gitSha"])) &&
      final.includes(String(item["eventId"]))
  );
  return cited && exactNumber(final, mappingCount)
    ? noIncompleteInvocations(result)
    : {
        passed: false,
        reason: "Final response did not cite an observed Git/event mapping and count",
      };
}

async function orchestrateCommitMapping(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const repoName = context.runner.workspaceRepoName;
  if (!repoName) throw new Error("Git commit-mapping scenario requires a seeded repository fixture");
  const repoPath = `packages/${repoName}`;
  let session: HeadlessSession | undefined;
  let snapshot: SessionSnapshot | undefined;
  let error: string | undefined;
  const cleanupErrors: string[] = [];

  try {
    session = await context.runner.spawn({ context: "task" });
    await context.sendAndWait(
      session,
      `Work only in ${repoPath}. Make one distinctive managed source edit, commit it, and publish that exact clean GAD milestone to protected main. Report the published event identity and wait for the external Git verification step.`,
      "publish the managed milestone through GAD"
    );
    await context.sendAndWait(
      session,
      `Export the published ${repoPath} milestone to a fresh credential-free disposable Git remote using the self-cleaning verification operation. Then inspect ${repoPath}'s canonical Git commit mapping and report the exact mapping count plus at least one observed workspace event identity and Git SHA.`,
      "export the milestone and inspect its Git mapping"
    );
    snapshot = session.snapshot();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    try {
      snapshot = session?.snapshot();
    } catch {
      // The primary orchestration error remains the useful failure.
    }
  }

  const messages = session ? ([...session.messages] as ChatMessage[]) : [];
  if (session) {
    try {
      await session.close();
      cleanupErrors.push(
        ...session.snapshot().cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`)
      );
    } catch (cause) {
      cleanupErrors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return {
    messages,
    duration: Date.now() - startedAt,
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error } : {}),
    ...(cleanupErrors.length > 0
      ? {
          cleanupErrors,
          error: error ?? `Headless cleanup failed: ${cleanupErrors.join("; ")}`,
        }
      : {}),
    diagnostics: { orchestrated: true, repoPath, phases: 2 },
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalGitSourceUri(remote: string): string | null {
  const value = remote.trim();
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    return `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(value);
    if (["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    // A local-only remote is represented by an opaque digest, not its path.
  }
  return null;
}

function collectGitImports(
  value: unknown,
  imports: ObservedGitImport[],
  seen = new Set<object>()
): void {
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (isRecord(value) && hasExactKeys(value, ["path", "remote", "candidate"])) {
    const remote = value["remote"];
    const candidate = value["candidate"];
    if (
      typeof value["path"] === "string" &&
      value["path"].length > 0 &&
      isRecord(remote) &&
      (hasExactKeys(remote, ["name", "url"]) || hasExactKeys(remote, ["name", "url", "branch"])) &&
      typeof remote["name"] === "string" &&
      remote["name"].length > 0 &&
      typeof remote["url"] === "string" &&
      remote["url"].length > 0 &&
      (remote["branch"] === undefined || typeof remote["branch"] === "string") &&
      isRecord(candidate) &&
      (hasExactKeys(candidate, ["contextId", "eventId", "changed"]) ||
        hasExactKeys(candidate, ["contextId", "eventId", "changed", "semanticEvidence"])) &&
      typeof candidate["contextId"] === "string" &&
      candidate["contextId"].length > 0 &&
      typeof candidate["eventId"] === "string" &&
      candidate["eventId"].length > 0 &&
      candidate["changed"] === true
    ) {
      const evidence = candidate["semanticEvidence"];
      imports.push({
        path: value["path"],
        remoteUrl: remote["url"],
        contextId: candidate["contextId"],
        eventId: candidate["eventId"],
        ...(isRecord(evidence) &&
        typeof evidence["applicationId"] === "string" &&
        typeof evidence["workUnitId"] === "string" &&
        isRecord(evidence["externalSnapshot"])
          ? {
              semanticEvidence: {
                applicationId: evidence["applicationId"],
                workUnitId: evidence["workUnitId"],
                externalSnapshot: evidence["externalSnapshot"],
              },
            }
          : {}),
      });
    }
  }
  for (const child of Object.values(value)) collectGitImports(child, imports, seen);
}

function statusProvesUnpublishedCandidate(value: unknown, imported: ObservedGitImport): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (isRecord(value)) {
    const candidate = value["candidate"];
    if (
      value["repoPath"] === imported.path &&
      value["state"] === "integration-required" &&
      typeof value["autoPush"] === "boolean" &&
      Number.isInteger(value["aheadBy"]) &&
      Number(value["aheadBy"]) >= 0 &&
      Number.isInteger(value["behindBy"]) &&
      Number(value["behindBy"]) >= 0 &&
      isRecord(candidate) &&
      hasExactKeys(candidate, ["contextId", "eventId"]) &&
      candidate["contextId"] === imported.contextId &&
      candidate["eventId"] === imported.eventId
    ) {
      return true;
    }
  }
  return Object.values(value).some((child) => statusProvesUnpublishedCandidate(child, imported));
}

function importEvidenceIsCanonical(imported: ObservedGitImport): boolean {
  const evidence = imported.semanticEvidence;
  if (!evidence) return false;
  const snapshot = evidence.externalSnapshot;
  const expectedSourceUri = canonicalGitSourceUri(imported.remoteUrl);
  return (
    evidence.applicationId.length > 0 &&
    evidence.workUnitId.length > 0 &&
    snapshot["sourceKind"] === "git" &&
    typeof snapshot["sourceUri"] === "string" &&
    (expectedSourceUri
      ? snapshot["sourceUri"] === expectedSourceUri
      : snapshot["sourceUri"].startsWith("git-local://sha256/")) &&
    typeof snapshot["snapshotRevision"] === "string" &&
    snapshot["snapshotRevision"].length > 0 &&
    typeof snapshot["snapshotDigest"] === "string" &&
    /^snapshot:[0-9a-f]{64}$/u.test(snapshot["snapshotDigest"]) &&
    Array.isArray(snapshot["targetRepositoryIds"]) &&
    snapshot["targetRepositoryIds"].length > 0
  );
}

function finalReportsImport(finalMessage: string, imported: ObservedGitImport): boolean {
  const plainMessage = finalMessage.replace(/[*_`]/gu, "");
  return (
    finalMessage.includes(imported.path) &&
    finalMessage.includes(imported.eventId) &&
    (/\b(?:unpublished|not (?:yet )?published|not published)\b/iu.test(plainMessage) ||
      /\bpublished\s*(?:[?:=]\s*)?(?:no|false)\b/iu.test(plainMessage))
  );
}

function requireGitImportSemanticEvidence(result: Parameters<typeof noIncompleteInvocations>[0]): {
  passed: boolean;
  reason?: string;
} {
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  const evalCalls = getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  const code = successfulEvalCode(result);
  if (
    !canonicalGitMethodMentioned(code, "createDisposableRemote") ||
    !canonicalGitMethodMentioned(code, "pushDisposableRemote") ||
    !canonicalGitMethodMentioned(code, "inspectDisposableRemote") ||
    !canonicalGitMethodMentioned(code, "importProject") ||
    !canonicalGitMethodMentioned(code, "upstreamStatus") ||
    !canonicalGitMethodMentioned(code, "detachUpstream") ||
    !canonicalGitMethodMentioned(code, "removeDisposableRemote")
  ) {
    return {
      passed: false,
      reason:
        "The import scenario did not create, seed, inspect, import, detach, and remove one disposable Git remote",
    };
  }

  const calls = getToolCalls(result);
  if (
    !calls.some((call) => call.name === "edit" || call.name === "write") ||
    !calls.some(isManagedCommitCall) ||
    !calls.some(
      (call) =>
        (call.name === "vcs" && call.arguments?.["operation"] === "push") ||
        (call.name === "push" && call.arguments?.["operation"] === undefined)
    )
  ) {
    return {
      passed: false,
      reason: "The imported Git source was not generated from a managed edit and GAD publication",
    };
  }

  const values = successfulEvalReturnValues(result);
  const generatedSourceVerified = values.some((value) => {
    const observation = records(value);
    const remotes = observation.filter(
      (item) =>
        typeof item["id"] === "string" &&
        typeof item["url"] === "string" &&
        typeof item["branch"] === "string" &&
        Number.isInteger(item["expiresAt"])
    );
    return remotes.some(
      (remote) =>
        observation.some(
          (item) =>
            item["id"] === remote["id"] &&
            item["url"] === remote["url"] &&
            typeof item["headCommit"] === "string" &&
            Number.isInteger(item["commitCount"]) &&
            Number(item["commitCount"]) > 0
        ) && observation.some((item) => item["removed"] === true)
    );
  });
  if (!generatedSourceVerified) {
    return {
      passed: false,
      reason: "The generated disposable source was not populated, inspected, and removed",
    };
  }

  const imports: ObservedGitImport[] = [];
  for (const call of evalCalls) collectGitImports(call.execution?.result, imports);
  if (imports.length === 0) {
    return {
      passed: false,
      reason:
        "Successful eval results did not contain a complete host-shaped Git import result with a changed semantic candidate",
    };
  }

  const inspectedEvents = new Map<string, Record<string, unknown>>();
  const inspectedApplications = new Map<string, Record<string, unknown>>();
  const inspectedWorkUnits = new Map<string, Record<string, unknown>>();
  const visitInspection = (value: unknown, seen = new Set<object>()): void => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isRecord(value) && isRecord(value["node"])) {
      const node = value["node"];
      const inspected = node["value"];
      if (!isRecord(inspected)) {
        for (const child of Object.values(value)) visitInspection(child, seen);
        return;
      }
      if (node["kind"] === "event" && typeof inspected["eventId"] === "string") {
        inspectedEvents.set(inspected["eventId"], inspected);
      } else if (node["kind"] === "application" && typeof inspected["applicationId"] === "string") {
        inspectedApplications.set(inspected["applicationId"], inspected);
      } else if (node["kind"] === "work-unit" && typeof inspected["workUnitId"] === "string") {
        inspectedWorkUnits.set(inspected["workUnitId"], inspected);
      }
    }
    for (const child of Object.values(value)) visitInspection(child, seen);
  };
  for (const call of getToolCalls(result)) {
    if (
      call.name === "provenance" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
    ) {
      visitInspection(call.execution.result);
    }
  }

  const finalMessage = findLastAgentMessage(result);
  for (const imported of imports) {
    if (
      !evalCalls.some((call) => statusProvesUnpublishedCandidate(call.execution?.result, imported))
    ) {
      continue;
    }
    if (
      importEvidenceIsCanonical(imported) &&
      finalReportsImport(finalMessage, imported)
    ) {
      return { passed: true, reason: undefined };
    }
    const event = inspectedEvents.get(imported.eventId);
    if (
      !event ||
      event["kind"] !== "commit" ||
      !Array.isArray(event["applicationIds"]) ||
      event["applicationIds"].length === 0 ||
      typeof event["commandId"] !== "string"
    ) {
      continue;
    }
    for (const applicationId of event["applicationIds"]) {
      if (typeof applicationId !== "string") continue;
      const application = inspectedApplications.get(applicationId);
      if (
        !application ||
        application["applicationId"] !== applicationId ||
        typeof application["workUnitId"] !== "string"
      ) {
        continue;
      }
      const workUnit = inspectedWorkUnits.get(application["workUnitId"]);
      const snapshot = workUnit?.["externalSnapshot"];
      const expectedSourceUri = canonicalGitSourceUri(imported.remoteUrl);
      if (
        !workUnit ||
        workUnit["kind"] !== "import" ||
        workUnit["commandId"] !== event["commandId"] ||
        typeof workUnit["intentSummary"] !== "string" ||
        workUnit["intentSummary"].trim().length === 0 ||
        !isRecord(snapshot) ||
        snapshot["sourceKind"] !== "git" ||
        typeof snapshot["sourceUri"] !== "string" ||
        (expectedSourceUri
          ? snapshot["sourceUri"] !== expectedSourceUri
          : !snapshot["sourceUri"].startsWith("git-local://sha256/")) ||
        typeof snapshot["snapshotRevision"] !== "string" ||
        snapshot["snapshotRevision"].length === 0 ||
        typeof snapshot["snapshotDigest"] !== "string" ||
        !/^snapshot:[0-9a-f]{64}$/u.test(snapshot["snapshotDigest"]) ||
        !Array.isArray(snapshot["targetRepositoryIds"]) ||
        snapshot["targetRepositoryIds"].length < 1
      ) {
        continue;
      }
      if (finalReportsImport(finalMessage, imported)) {
        return { passed: true, reason: undefined };
      }
    }
  }

  return {
    passed: false,
    reason:
      "Completed results did not identity-join one exact Git import result and integration-required status to canonical event/application/work-unit external-snapshot evidence; the final answer must report that same path, candidate event ID, and unpublished state",
  };
}

async function orchestrateDisposableImport(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const repoName = context.runner.workspaceRepoName;
  if (!repoName) throw new Error("Git import scenario requires a seeded repository fixture");
  const sourcePath = `packages/${repoName}`;
  const importedPath = `projects/${repoName}-imported`;
  let session: HeadlessSession | undefined;
  let snapshot: SessionSnapshot | undefined;
  let error: string | undefined;
  const cleanupErrors: string[] = [];

  try {
    session = await context.runner.spawn({ context: "task" });
    await context.sendAndWait(
      session,
      `Work only in ${sourcePath}. Make one distinctive managed source edit, commit it, and publish that exact clean GAD milestone to protected main. Report its exact event identity and stop; this repository will become the generated Git import fixture.`,
      "publish the generated source fixture through GAD"
    );
    await context.sendAndWait(
      session,
      `Exercise the complete credential-free Git import lifecycle in one bounded operation. Create one disposable remote, push ${sourcePath}'s published protected-main snapshot to that exact URL with pushDisposableRemote, and inspect it. Import that same URL and branch anonymously into ${importedPath}, then call upstreamStatus for only ${importedPath} with fetch disabled. Retain the exact import result and status as your proof. Finally detach ${importedPath}'s upstream with { forgetRemote: true } and remove the disposable remote. Report the imported path, candidate event ID, whether it is published, the verified Git head and commit count, and that cleanup succeeded.`,
      "generate, import, verify, and clean up the disposable Git fixture"
    );
    snapshot = session.snapshot();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    try {
      snapshot = session?.snapshot();
    } catch {
      // The primary orchestration error remains the useful failure.
    }
  }

  const messages = session ? ([...session.messages] as ChatMessage[]) : [];
  if (session) {
    try {
      await session.close();
      cleanupErrors.push(
        ...session.snapshot().cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`)
      );
    } catch (cause) {
      cleanupErrors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return {
    messages,
    duration: Date.now() - startedAt,
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error } : {}),
    ...(cleanupErrors.length > 0
      ? {
          cleanupErrors,
          error: error ?? `Headless cleanup failed: ${cleanupErrors.join("; ")}`,
        }
      : {}),
    diagnostics: { orchestrated: true, sourcePath, importedPath, phases: 2 },
  };
}

export const gitInteropTests: TestCase[] = [
  {
    name: "git-upstream-status",
    description: "Inspect external Git upstream tracking across workspace repos",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Do any repositories in this workspace track an external Git upstream? Give me a bounded summary of what is tracked and its synchronization state.",
    validate: upstreamStatusChecked,
  },
  {
    name: "git-publish-local-remote",
    description: "Publish a managed repo, edit it through GAD, and push the follow-up upstream",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "git-remotes",
          capability: "git.remotes.manage",
          resource: { kind: "exact", key: "git.remotes.manage" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "git-publish",
          capability: "git.publish",
          resource: { kind: "exact", key: "git.publish" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "publish-git-config",
          capability: { kind: "exact", key: "workspace-main-advance" },
          resource: {
            kind: "exact",
            key: "workspace-source-change:meta:main",
          },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    prompt: "Harness-orchestrated managed edit and two-phase disposable Git publication.",
    orchestrate: orchestrateDisposableFollowUpPush,
    validate: disposableFollowUpPushChecked,
  },
  {
    name: "git-import-project",
    description: "Generate and import a disposable Git project into the workspace",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "git-remotes",
          capability: "git.remotes.manage",
          resource: { kind: "exact", key: "git.remotes.manage" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "git-import",
          capability: "git.project.import",
          resource: { kind: "exact", key: "git.project.import" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "git-publish",
          capability: "git.publish",
          resource: { kind: "exact", key: "git.publish" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "publish-git-config",
          capability: { kind: "exact", key: "workspace-main-advance" },
          resource: {
            kind: "exact",
            key: "workspace-source-change:meta:main",
          },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    prompt: "Harness-orchestrated generated Git fixture import and semantic evidence check.",
    orchestrate: orchestrateDisposableImport,
    validate: requireGitImportSemanticEvidence,
  },
  {
    name: "git-commit-mapping",
    description: "Report the workspace-commit to git-commit mapping for an exported repo",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "git-publish",
          capability: "git.publish",
          resource: { kind: "exact", key: "git.publish" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    prompt: "Harness-orchestrated managed publication, disposable Git export, and commit mapping.",
    orchestrate: orchestrateCommitMapping,
    validate: commitMappingChecked,
  },
];
