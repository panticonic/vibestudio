import type {
  TestCase,
  TestSuiteResult,
  TestExecutionResult,
  TestResult,
  TestSuiteResultEntry,
  ToolFailureSummary,
} from "./types.js";
import type { HeadlessRunner } from "./runner.js";
import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";

type MaybePromise<T> = T | Promise<T>;
type RunSuiteFilter = { category?: string; name?: string; concurrency?: number };
const DEFAULT_PARALLEL_CONCURRENCY = 4;

export class TestRunner {
  constructor(
    private runner: HeadlessRunner,
    private opts?: {
      onTestStart?: (test: TestCase) => void;
      onTestEnd?: (test: TestCase, result: TestResult, execution: TestExecutionResult) => void;
      onTestResult?: (
        entry: TestSuiteResultEntry,
        aggregate: TestSuiteResult
      ) => MaybePromise<void>;
      concurrency?: number;
      testTimeoutMs?: number;
    }
  ) {
    if (!runner) {
      throw new Error(
        "TestRunner requires a HeadlessRunner instance. Usage: new TestRunner(new HeadlessRunner(contextId))"
      );
    }
  }

  /** Alias for runSuite */
  run = this.runSuite.bind(this);
  /** Alias for runSuite */
  runTests = this.runSuite.bind(this);
  /** Alias for runSuite with an explicit concurrency cap */
  runSuiteParallel = (tests: TestCase[], opts?: RunSuiteFilter): Promise<TestSuiteResult> => {
    return this.runSuite(tests, {
      ...opts,
      concurrency: opts?.concurrency ?? this.opts?.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY,
    });
  };

  async runSuite(tests: TestCase[], filter?: RunSuiteFilter): Promise<TestSuiteResult> {
    const filtered = tests.filter((t) => {
      if (filter?.category && t.category !== filter.category) return false;
      if (filter?.name && !t.name.includes(filter.name)) return false;
      return true;
    });

    const startTime = Date.now();
    const results: Array<TestSuiteResultEntry | undefined> = new Array(filtered.length);
    const concurrency = this.normalizeConcurrency(
      filter?.concurrency ?? this.opts?.concurrency ?? 1,
      filtered.length
    );
    const pending = new Set(filtered.map((_test, index) => index));
    const activeResources = new Set<string>();
    let scheduleWaiters: Array<() => void> = [];

    const resourcesFor = (test: TestCase): string[] => [
      ...new Set([
        ...(test.resources ?? []).filter(Boolean),
        ...(test.workspaceRepoFixture ? ["workspace:repo-fixtures"] : []),
      ]),
    ];
    const wakeSchedulers = (): void => {
      const waiters = scheduleWaiters;
      scheduleWaiters = [];
      for (const wake of waiters) wake();
    };
    const claimRunnable = async (): Promise<{ index: number; resources: string[] } | null> => {
      for (;;) {
        for (const index of pending) {
          const resources = resourcesFor(filtered[index]!);
          if (resources.some((resource) => activeResources.has(resource))) continue;
          pending.delete(index);
          for (const resource of resources) activeResources.add(resource);
          return { index, resources };
        }
        if (pending.size === 0) return null;
        await new Promise<void>((resolve) => scheduleWaiters.push(resolve));
      }
    };

    const runAt = async (index: number): Promise<void> => {
      const test = filtered[index]!;
      this.opts?.onTestStart?.(test);
      const { result, execution } = await this.runOne(test);
      const entry: TestSuiteResultEntry = {
        test: {
          name: test.name,
          category: test.category,
          description: test.description,
          prompt: test.prompt,
        },
        result,
        execution,
      };
      results[index] = entry;
      this.opts?.onTestEnd?.(test, result, execution);
      if (this.opts?.onTestResult) {
        await this.opts.onTestResult(
          entry,
          this.buildSuiteResult(tests.length, filtered.length, results, startTime)
        );
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const claim = await claimRunnable();
        if (!claim) return;
        try {
          await runAt(claim.index);
        } finally {
          for (const resource of claim.resources) activeResources.delete(resource);
          wakeSchedulers();
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return this.buildSuiteResult(tests.length, filtered.length, results, startTime);
  }

  private buildSuiteResult(
    sourceTotal: number,
    filteredTotal: number,
    entries: Array<TestSuiteResultEntry | undefined>,
    startTime: number
  ): TestSuiteResult {
    const results = entries.filter((entry): entry is TestSuiteResultEntry => Boolean(entry));
    let passed = 0,
      failed = 0,
      errored = 0;
    let toolFailureCount = 0,
      testsWithToolFailures = 0;
    for (const entry of results) {
      if (entry.execution.error) errored++;
      else if (entry.result.passed) passed++;
      else failed++;
      const entryToolFailures = unexpectedToolFailures(entry.execution.toolFailures).length;
      toolFailureCount += entryToolFailures;
      if (entryToolFailures > 0) testsWithToolFailures++;
    }
    return {
      total: results.length,
      passed,
      failed,
      errored,
      toolFailureCount,
      testsWithToolFailures,
      skipped: sourceTotal - filteredTotal,
      duration: Date.now() - startTime,
      results,
    };
  }

  private normalizeConcurrency(value: number, total: number): number {
    if (total <= 0) return 1;
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(total, Math.max(1, Math.floor(value)));
  }

  async runOne(test: TestCase): Promise<{ result: TestResult; execution: TestExecutionResult }> {
    const startTime = Date.now();
    const testTimeoutMs = this.opts?.testTimeoutMs;
    const testRunner =
      typeof this.runner.forTest === "function"
        ? this.runner.forTest(test.name, {
            workspaceRepoFixture: test.workspaceRepoFixture === true,
          })
        : this.runner;
    let session: HeadlessSession | undefined;
    let outcome: { result: TestResult; execution: TestExecutionResult } | undefined;
    let workspaceRepoFixtureState:
      | Awaited<ReturnType<HeadlessRunner["prepareWorkspaceRepoFixture"]>>
      | undefined;
    try {
      if (test.workspaceRepoFixture) {
        workspaceRepoFixtureState = await testRunner.prepareWorkspaceRepoFixture();
      }
      const execution = test.orchestrate
        ? await test.orchestrate({
            runner: testRunner,
            testTimeoutMs,
            sendAndWait: async (targetSession, prompt, phase) => {
              if (testTimeoutMs === undefined) {
                await targetSession.sendAndWait(prompt);
              } else {
                const controller = new AbortController();
                await this.withTimeout(
                  targetSession.sendAndWait(prompt, { signal: controller.signal }),
                  testTimeoutMs,
                  `Timed out waiting for agent to finish test "${test.name}" during ${phase}`,
                  controller
                );
              }
              await this.captureAndAssertModelExecution(targetSession, test.name, phase);
            },
          })
        : await (async (): Promise<TestExecutionResult> => {
            session = await testRunner.spawn();

            if (testTimeoutMs === undefined) {
              await session.sendAndWait(test.prompt);
            } else {
              const controller = new AbortController();
              await this.withTimeout(
                session.sendAndWait(test.prompt, { signal: controller.signal }),
                testTimeoutMs,
                `Timed out waiting for agent to finish test "${test.name}"`,
                controller
              );
            }

            const modelExecutionEvidence = await this.captureAndAssertModelExecution(
              session,
              test.name,
              "agent turn"
            );

            const messages = [...session.messages] as ChatMessage[];
            const snapshot = session.snapshot();
            const duration = Date.now() - startTime;
            return {
              messages,
              duration,
              snapshot,
              modelExecutionEvidence,
              provenance: provenanceFromSnapshot(snapshot),
            };
          })();
      execution.duration ||= Date.now() - startTime;
      execution.modelExecutionEvidence ??= execution.snapshot?.modelExecutionEvidence;
      execution.toolFailures = classifyExpectedToolFailures(
        collectToolFailures(execution),
        test.expectedToolFailures
      );
      const result = test.validate(execution);
      outcome = { result, execution };
    } catch (err) {
      const duration = Date.now() - startTime;
      const messages = session ? ([...session.messages] as ChatMessage[]) : [];
      let modelExecutionEvidence: unknown;
      if (session) {
        try {
          modelExecutionEvidence = await session.captureModelExecutionEvidence();
        } catch (evidenceErr) {
          console.warn(
            "[system-testing] Failed to capture model evidence for failed headless session:",
            evidenceErr
          );
        }
      }
      let snapshot: SessionSnapshot | undefined;
      try {
        snapshot = session?.snapshot();
      } catch (snapshotErr) {
        console.warn("[system-testing] Failed to snapshot failed headless session:", snapshotErr);
      }
      const errorMessage = formatExecutionError(err, messages, snapshot);
      const execution: TestExecutionResult = {
        messages,
        duration,
        error: errorMessage,
        snapshot,
        ...(modelExecutionEvidence !== undefined ? { modelExecutionEvidence } : {}),
        ...(snapshot ? { provenance: provenanceFromSnapshot(snapshot) } : {}),
      };
      execution.toolFailures = classifyExpectedToolFailures(
        collectToolFailures(execution),
        test.expectedToolFailures
      );
      try {
        execution.diagnostics = await testRunner.collectDiagnostics({
          channelId: session?.channelId,
          error: new Error(errorMessage),
        });
      } catch (diagnosticErr) {
        execution.diagnostics = {
          generatedAt: new Date().toISOString(),
          diagnosticCollectionError:
            diagnosticErr instanceof Error ? diagnosticErr.message : String(diagnosticErr),
        };
      }
      outcome = {
        result: { passed: false, reason: `Error: ${execution.error}` },
        execution,
      };
    } finally {
      try {
        if (session) {
          // A failed/timed-out test may still own an active eval or model call.
          // Await retirement before releasing its resource lock so subsequent
          // tests cannot race background mutations from the failed trajectory.
          const awaitRemoteCleanup = Boolean(outcome?.execution.error);
          await session.close({
            waitForRemoteCleanup: awaitRemoteCleanup,
          });
          if (outcome) {
            outcome.execution.diagnostics = {
              ...(outcome.execution.diagnostics ?? {}),
              headlessCleanup: {
                mode: awaitRemoteCleanup ? "awaited" : "detached",
                remoteCleanupAwaited: awaitRemoteCleanup,
              },
            };
          }
        }
      } catch (cleanupErr) {
        const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn("[system-testing] Failed to close headless session:", cleanupErr);
        if (outcome) {
          const cleanupMessage = `close: ${message}`;
          outcome.execution.cleanupErrors = [
            ...(outcome.execution.cleanupErrors ?? []),
            cleanupMessage,
          ];
          outcome.execution.error ??= `Headless cleanup failed: ${cleanupMessage}`;
          if (outcome.result.passed) {
            outcome.result = {
              passed: false,
              reason: `Headless cleanup failed: ${cleanupMessage}`,
              details: { cleanupErrors: [cleanupMessage] },
            };
          } else {
            outcome.result = {
              ...outcome.result,
              details: {
                ...(outcome.result.details ?? {}),
                cleanupErrors: [
                  ...((outcome.result.details?.["cleanupErrors"] as string[] | undefined) ?? []),
                  cleanupMessage,
                ],
              },
            };
          }
        }
      }
      let cleanupErrors: NonNullable<SessionSnapshot["cleanupErrors"]> = [];
      try {
        cleanupErrors = session?.snapshot().cleanupErrors ?? [];
      } catch (snapshotErr) {
        console.warn(
          "[system-testing] Failed to snapshot headless cleanup diagnostics:",
          snapshotErr
        );
      }
      if (cleanupErrors.length > 0 && outcome) {
        const messages = cleanupErrors.map((error) => `${error.phase}: ${error.message}`);
        outcome.execution.cleanupErrors = [...(outcome.execution.cleanupErrors ?? []), ...messages];
        outcome.execution.error ??= `Headless cleanup failed: ${messages.join("; ")}`;
        outcome.execution.snapshot = session?.snapshot();
        if (outcome.result.passed) {
          outcome.result = {
            passed: false,
            reason: `Headless cleanup failed: ${messages.join("; ")}`,
            details: { cleanupErrors: messages },
          };
        } else {
          outcome.result = {
            ...outcome.result,
            details: {
              ...(outcome.result.details ?? {}),
              cleanupErrors: messages,
            },
          };
        }
      }
      if (workspaceRepoFixtureState) {
        try {
          const fixtureCleanup =
            await testRunner.cleanupWorkspaceRepoFixture(workspaceRepoFixtureState);
          if (outcome) {
            outcome.execution.diagnostics = {
              ...(outcome.execution.diagnostics ?? {}),
              workspaceRepoFixture: {
                ...workspaceRepoFixtureState,
                ...fixtureCleanup,
              },
            };
          }
          if (fixtureCleanup.escapedRepos.length > 0) {
            recordCleanupFailure(
              outcome,
              `workspace-repo-fixture: test published repo(s) outside its reserved namespace: ${fixtureCleanup.escapedRepos.join(
                ", "
              )}; left intact`
            );
          }
        } catch (fixtureCleanupErr) {
          recordCleanupFailure(
            outcome,
            `workspace-repo-fixture: ${
              fixtureCleanupErr instanceof Error
                ? fixtureCleanupErr.message
                : String(fixtureCleanupErr)
            }`
          );
        }
      }
    }
    if (!outcome) {
      throw new Error("Test runner finished without producing a result");
    }
    return outcome;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    controller?: AbortController
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(message));
            controller?.abort();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async captureAndAssertModelExecution(
    session: HeadlessSession,
    testName: string,
    phase: string
  ): Promise<unknown> {
    const evidence = await session.captureModelExecutionEvidence();
    const record = asRecord(evidence);
    const calls = Array.isArray(record?.["calls"])
      ? (record["calls"] as unknown[]).map(asRecord).filter(Boolean)
      : [];
    if (calls.length === 0) {
      throw new Error(
        `System test "${testName}" has no journaled model execution evidence after ${phase}`
      );
    }
    const policy =
      typeof this.runner.modelPolicySnapshot === "function"
        ? this.runner.modelPolicySnapshot(session)
        : {
            primaryModel: this.runner.modelRef,
            activeModel: this.runner.modelRef,
            fallbackModel: null,
          };
    const allowedRefs = new Set([policy.activeModel]);
    if (policy.activeModel === policy.fallbackModel && policy.primaryModel !== policy.activeModel) {
      allowedRefs.add(policy.primaryModel);
    }
    const mismatches = calls.filter((call) => {
      const ref = String(call?.["ref"] ?? "");
      const separator = ref.indexOf(":");
      return (
        !allowedRefs.has(ref) ||
        call?.["provider"] !== (separator >= 0 ? ref.slice(0, separator) : ref) ||
        call?.["model"] !== (separator >= 0 ? ref.slice(separator + 1) : "")
      );
    });
    if (mismatches.length > 0) {
      const actual = [
        ...new Set(
          mismatches.map(
            (call) =>
              `${String(call?.["ref"] ?? "unknown")} ` +
              `(provider=${String(call?.["provider"] ?? "missing")}, ` +
              `model=${String(call?.["model"] ?? "missing")})`
          )
        ),
      ];
      throw new Error(
        `System test "${testName}" executed ${actual.join(", ")} during ${phase}; expected ${[
          ...allowedRefs,
        ].join(" then ")}`
      );
    }
    if (allowedRefs.size > 1) {
      const refs = calls.map((call) => String(call?.["ref"] ?? ""));
      const fallbackIndex = refs.indexOf(policy.activeModel);
      const invalidTransition =
        fallbackIndex < 0 ||
        calls
          .slice(0, fallbackIndex)
          .some(
            (call) =>
              call?.["ref"] !== policy.primaryModel ||
              call?.["outcome"] !== "failed"
          ) ||
        refs.slice(fallbackIndex).some((ref) => ref !== policy.activeModel);
      if (invalidTransition) {
        throw new Error(
          `System test "${testName}" has an invalid model transition during ${phase}; ` +
            `expected failed ${policy.primaryModel} call(s) followed only by ${policy.activeModel}`
        );
      }
    }
    const metered = calls.some((call) => {
      const usage = asRecord(call?.["usage"]);
      const totalTokens = usage?.["totalTokens"];
      const hasPositiveUsage =
        (typeof totalTokens === "number" && totalTokens > 0) ||
        ["input", "output", "cacheRead", "reasoning"].some(
          (key) => typeof usage?.[key] === "number" && (usage[key] as number) > 0
        );
      return (
        typeof call?.["api"] === "string" &&
        call["api"].length > 0 &&
        typeof call?.["auth"] === "string" &&
        call["auth"].length > 0 &&
        hasPositiveUsage
      );
    });
    if (!metered) {
      throw new Error(
        `System test "${testName}" has model labels for ${policy.activeModel} but no ` +
          `completed API/auth record with positive metered usage after ${phase}`
      );
    }
    return evidence;
  }
}

function recordCleanupFailure(
  outcome: { result: TestResult; execution: TestExecutionResult } | undefined,
  message: string
): void {
  if (!outcome) return;
  outcome.execution.cleanupErrors = [...(outcome.execution.cleanupErrors ?? []), message];
  outcome.execution.error ??= `Headless cleanup failed: ${message}`;
  if (outcome.result.passed) {
    outcome.result = {
      passed: false,
      reason: `Headless cleanup failed: ${message}`,
      details: { cleanupErrors: [message] },
    };
    return;
  }
  outcome.result = {
    ...outcome.result,
    details: {
      ...(outcome.result.details ?? {}),
      cleanupErrors: [
        ...((outcome.result.details?.["cleanupErrors"] as string[] | undefined) ?? []),
        message,
      ],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function provenanceFromSnapshot(
  snapshot: SessionSnapshot
): NonNullable<TestExecutionResult["provenance"]> {
  return {
    channelId: snapshot.channelId,
    branchId: snapshot.channelId ? `branch:channel:${snapshot.channelId}` : null,
    agentEntityId: snapshot.agentEntityId,
    agentTargetId: snapshot.agentTargetId,
    contextId: snapshot.agentContextId,
  };
}

function formatExecutionError(
  err: unknown,
  messages: readonly ChatMessage[],
  snapshot?: SessionSnapshot
): string {
  const base = err instanceof Error ? err.message : String(err);
  if (!/^Timed out waiting for agent to finish test/.test(base)) return base;
  const details = timeoutDiagnosticDetails(messages, snapshot);
  return details.length > 0 ? `${base}. ${details.join(" ")}` : base;
}

function timeoutDiagnosticDetails(
  messages: readonly ChatMessage[],
  snapshot?: SessionSnapshot
): string[] {
  const details: string[] = [];
  const pendingInvocations = (snapshot?.invocations ?? []).filter(
    (invocation) => !isSettledInvocationStatus(invocation.status)
  );
  if (pendingInvocations.length > 0) {
    details.push(
      `Pending invocations: ${pendingInvocations
        .slice(0, 5)
        .map((invocation) => `${invocation.name}:${invocation.status || "unknown"}`)
        .join(
          ", "
        )}${pendingInvocations.length > 5 ? ` (+${pendingInvocations.length - 5} more)` : ""}.`
    );
  }
  const lastLifecycle = [...messages].reverse().find((message) => message.lifecycle);
  if (lastLifecycle?.lifecycle) {
    const reason = lastLifecycle.lifecycle.reason
      ? ` reason=${lastLifecycle.lifecycle.reason}`
      : "";
    details.push(
      `Last lifecycle: ${lastLifecycle.lifecycle.status}${reason} "${lastLifecycle.lifecycle.title}".`
    );
  }
  const lastDiagnostic = [...messages]
    .reverse()
    .find((message) => message.diagnostic || message.error);
  if (lastDiagnostic) {
    const code = lastDiagnostic.diagnostic?.code ? ` code=${lastDiagnostic.diagnostic.code}` : "";
    const title =
      lastDiagnostic.diagnostic?.title ?? lastDiagnostic.error ?? lastDiagnostic.content;
    details.push(`Last diagnostic:${code} "${String(title).slice(0, 200)}".`);
  }
  return details;
}

function isSettledInvocationStatus(status: string): boolean {
  return ["complete", "completed", "error", "failed", "cancelled", "abandoned"].includes(status);
}

interface InvocationLike {
  id?: unknown;
  name?: unknown;
  method?: unknown;
  status?: unknown;
  terminalOutcome?: unknown;
  terminalReasonCode?: unknown;
  error?: unknown;
  result?: unknown;
  execution?: {
    status?: unknown;
    terminalOutcome?: unknown;
    terminalReasonCode?: unknown;
    description?: unknown;
    error?: unknown;
    result?: unknown;
    isError?: unknown;
  };
}

function collectToolFailures(execution: TestExecutionResult): ToolFailureSummary[] {
  const failures: ToolFailureSummary[] = [];
  const seen = new Set<string>();

  const add = (summary: ToolFailureSummary) => {
    const key = summary.id
      ? `id:${summary.id}`
      : [summary.name, summary.status, summary.error, summary.resultSummary, summary.source].join(
          "\0"
        );
    if (seen.has(key)) return;
    seen.add(key);
    failures.push(summary);
  };

  for (const message of execution.messages) {
    if (message.contentType !== "invocation") continue;
    const payload = ((message as { invocation?: unknown }).invocation ??
      parseJson(message.content)) as InvocationLike | undefined;
    const summary = summarizeToolFailure(
      payload,
      "message",
      (message as { error?: unknown }).error
    );
    if (summary) add(summary);
  }

  for (const invocation of execution.snapshot?.invocations ?? []) {
    const summary = summarizeToolFailure(invocation as InvocationLike, "snapshot");
    if (summary) add(summary);
  }

  return failures;
}

function classifyExpectedToolFailures(
  failures: ToolFailureSummary[],
  expected: TestCase["expectedToolFailures"]
): ToolFailureSummary[] {
  if (!expected?.length) return failures;
  return failures.map((failure) => {
    const text = `${failure.error ?? ""}\n${failure.resultSummary ?? ""}`.toLowerCase();
    const matched = expected.some(
      (candidate) =>
        candidate.name === failure.name &&
        (!candidate.errorIncludes || text.includes(candidate.errorIncludes.toLowerCase()))
    );
    return matched ? { ...failure, expected: true } : failure;
  });
}

function unexpectedToolFailures(failures: ToolFailureSummary[] | undefined): ToolFailureSummary[] {
  return (failures ?? []).filter((failure) => failure.expected !== true);
}

function summarizeToolFailure(
  invocation: InvocationLike | undefined,
  source: ToolFailureSummary["source"],
  messageError?: unknown
): ToolFailureSummary | null {
  if (!invocation || typeof invocation !== "object") return null;
  const exec = isRecord(invocation.execution) ? invocation.execution : {};
  const status = asString(exec.status) ?? asString(invocation.status);
  const terminalOutcome = asString(exec.terminalOutcome) ?? asString(invocation.terminalOutcome);
  const terminalReasonCode =
    asString(exec.terminalReasonCode) ?? asString(invocation.terminalReasonCode);
  const isError = exec.isError === true;
  const hasFailureStatus = status === "error" || status === "failed";
  const hasFailureOutcome = /error|fail/i.test(terminalOutcome ?? "");
  const rawError =
    invocation.error ??
    exec.error ??
    messageError ??
    (isError ? (exec.result ?? exec.description) : undefined);

  if (!isError && !hasFailureStatus && !hasFailureOutcome && rawError === undefined) return null;

  const rawResult = invocation.result ?? exec.result;
  const name = asString(invocation.name) ?? asString(invocation.method) ?? "(unknown)";
  return {
    id: asString(invocation.id),
    name,
    status,
    terminalOutcome,
    terminalReasonCode,
    error: summarizeError(rawError),
    resultSummary: rawResult === undefined ? undefined : summarizeValue(rawResult, 240),
    source,
  };
}

function summarizeError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value) && typeof value["error"] === "string") return clip(value["error"], 240);
  if (value instanceof Error) return clip(value.message, 240);
  return summarizeValue(value, 240);
}

function summarizeValue(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : safeJson(value);
  return clip(text, limit);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
