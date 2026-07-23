import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { TestRunner } from "./test-runner.js";
import type { HeadlessRunner } from "./runner.js";
import { CONTENT_WORKSPACE_REPO_FIXTURE, type TestCase } from "./types.js";

const TEST_MODEL = "openai-codex:gpt-5.3-codex-spark";
const modelEvidence = () => ({
  totalCalls: 1,
  truncated: false,
  calls: [
    {
      ref: TEST_MODEL,
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      api: "openai-codex-responses",
      auth: "url-bound",
      usage: { input: 10, output: 5, totalTokens: 15 },
    },
  ],
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function remoteRpcFailure(message: string, handle: string): Error {
  return Object.assign(new Error(message), {
    name: "RemoteRpcError",
    code: "InternalFailure",
    errorKind: "application",
    errorData: {
      code: "InternalFailure",
      message,
      handle,
    },
  });
}

describe("TestRunner", () => {
  it("adds pending invocation and lifecycle context to headless timeouts", async () => {
    const lifecycleMessage = {
      id: "turn:waiting",
      senderId: "agent-1",
      content: "Waiting for model credential approval",
      contentType: "lifecycle",
      kind: "system",
      complete: true,
      lifecycle: {
        status: "waiting",
        reason: "model_credential_required",
        title: "Waiting for model credential approval",
      },
    } satisfies ChatMessage;
    const diagnosticMessage = {
      id: "diagnostic:empty",
      senderId: "agent-1",
      content: "Assistant message had no visible content.",
      contentType: "diagnostic",
      kind: "system",
      complete: true,
      diagnostic: {
        code: "message_empty",
        severity: "warning",
        title: "No assistant response",
      },
    } satisfies ChatMessage;
    const messages = [lifecycleMessage, diagnosticMessage];
    const cleanupOrder: string[] = [];
    let waitSignal: AbortSignal | undefined;
    let terminalWaitingReasons: readonly string[] | undefined;
    const session = {
      channelId: "chat-timeout",
      agentTargetId: "agent-target-timeout",
      messages,
      sendAndWait: vi.fn(
        (
          _prompt: string,
          opts?: { signal?: AbortSignal; terminalWaitingReasons?: readonly string[] }
        ) => {
          waitSignal = opts?.signal;
          terminalWaitingReasons = opts?.terminalWaitingReasons;
          return new Promise(() => undefined);
        }
      ),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: "chat-timeout",
        agentEntityId: "agent-entity-timeout",
        agentTargetId: "agent-target-timeout",
        agentContextId: "ctx-timeout",
        messages,
        invocations: [{ id: "call-eval", name: "eval", status: "pending" }],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      interrupt: vi.fn(async () => {
        cleanupOrder.push("interrupt");
      }),
      close: vi.fn(async () => {
        cleanupOrder.push("close");
      }),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const { result, execution } = await tester.runOne({
      name: "timeout-test",
      category: "test",
      description: "timeout",
      prompt: "hang",
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(false);
    expect(execution.error).toContain('Timed out waiting for agent to finish test "timeout-test"');
    expect(execution.error).toContain("Pending invocations: eval:pending.");
    expect(execution.error).toContain(
      'Last lifecycle: waiting reason=model_credential_required "Waiting for model credential approval".'
    );
    expect(execution.error).toContain(
      'Last diagnostic: code=message_empty "No assistant response".'
    );
    expect(waitSignal?.aborted).toBe(true);
    expect(terminalWaitingReasons).toEqual([
      "model_credential_required",
      "model_credential_reconnect_required",
    ]);
    expect(runner.collectDiagnostics).toHaveBeenCalledWith({ channelId: "chat-timeout" });
    expect(session.close).toHaveBeenCalledWith();
    expect(session.interrupt).toHaveBeenCalledWith("agent-target-timeout");
    expect(cleanupOrder).toEqual(["interrupt", "close"]);
    expect(session.captureModelExecutionEvidence).toHaveBeenCalledOnce();
    expect(execution.modelExecutionEvidence).toEqual(modelEvidence());
    expect(execution.provenance).toEqual({
      channelId: "chat-timeout",
      branchId: "branch:channel:chat-timeout",
      agentEntityId: "agent-entity-timeout",
      agentTargetId: "agent-target-timeout",
      contextId: "ctx-timeout",
    });
  });

  it("keeps the original test failure when diagnostics collection fails", async () => {
    const session = {
      channelId: "chat-fetch-failed",
      messages: [],
      sendAndWait: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => {
        throw new Error("diagnostics fetch failed");
      }),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const { result, execution } = await tester.runOne({
      name: "fetch-failed-test",
      category: "test",
      description: "fetch failed",
      prompt: "trigger fetch",
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(false);
    expect(execution.error).toBe("fetch failed");
    expect(execution.diagnostics).toMatchObject({
      diagnosticCollectionFailure: {
        phase: "diagnostic:collection",
        error: { name: "Error", message: "diagnostics fetch failed" },
      },
    });
    expect(execution.diagnostics).not.toHaveProperty("diagnosticCollectionError");
  });

  it("preserves typed fixture setup failures without changing error semantics", async () => {
    const failure = remoteRpcFailure(
      "[vcs.importSnapshot] fixture publication failed",
      "diagnostic:vcs:fixture-setup"
    );
    const childRunner = {
      modelRef: TEST_MODEL,
      prepareWorkspaceRepoFixture: vi.fn(async () => {
        throw failure;
      }),
      collectDiagnostics: vi.fn(async () => ({ generatedAt: "now" })),
    };
    const runner = {
      ...childRunner,
      forTest: vi.fn(() => childRunner),
    } as unknown as HeadlessRunner;

    const { result, execution } = await new TestRunner(runner).runOne({
      name: "fixture-setup-failure",
      category: "test",
      description: "typed fixture setup failure",
      prompt: "use the fixture",
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
      validate: () => ({ passed: true }),
    });

    expect(result).toEqual({
      passed: false,
      reason: "Error: [vcs.importSnapshot] fixture publication failed",
    });
    expect(execution.error).toBe("[vcs.importSnapshot] fixture publication failed");
    expect(execution.failure).toEqual({
      phase: "workspace-fixture-setup",
      error: {
        name: "RemoteRpcError",
        message: "[vcs.importSnapshot] fixture publication failed",
        code: "InternalFailure",
        errorKind: "application",
        errorData: {
          code: "InternalFailure",
          message: "[vcs.importSnapshot] fixture publication failed",
          handle: "diagnostic:vcs:fixture-setup",
        },
        diagnosticHandles: ["diagnostic:vcs:fixture-setup"],
      },
    });
    expect(childRunner.collectDiagnostics).toHaveBeenCalledWith({ channelId: undefined });
  });

  it("reports failed tool calls without converting a passing task into a failed test", async () => {
    const messages = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "invocation:call-1",
        senderId: "agent",
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify({
          id: "call-1",
          name: "eval",
          execution: {
            status: "error",
            terminalOutcome: "tool_error",
            result: { error: "ReferenceError: missingVar is not defined" },
            isError: true,
          },
        }),
      },
      {
        id: "answer-1",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "Recovered and finished with TOOL_RECOVERY_OK.",
      },
    ] satisfies ChatMessage[];
    const session = {
      channelId: "chat-tool-error",
      messages,
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        messages,
        invocations: [
          {
            id: "call-1",
            name: "eval",
            status: "error",
            execution: {
              status: "error",
              terminalOutcome: "tool_error",
              result: { error: "ReferenceError: missingVar is not defined" },
              isError: true,
            },
          },
        ],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const suite = await tester.runSuite([
      {
        name: "tool-error-recovery",
        category: "test",
        description: "tool error recovery",
        prompt: "trigger recovery",
        validate: () => ({ passed: true }),
      },
    ]);

    expect(suite).toMatchObject({
      passed: 1,
      failed: 0,
      errored: 0,
      toolFailureCount: 1,
      testsWithToolFailures: 1,
    });
    expect(suite.results[0]!.execution.error).toBeUndefined();
    expect(suite.results[0]!.execution.toolFailures).toEqual([
      expect.objectContaining({
        name: "eval",
        status: "error",
        terminalOutcome: "tool_error",
        error: "ReferenceError: missingVar is not defined",
      }),
    ]);

    const expectedSuite = await tester.runSuite([
      {
        name: "intentional-tool-error-recovery",
        category: "test",
        description: "intentional tool error recovery",
        prompt: "trigger recovery",
        expectedToolFailures: [{ name: "eval", errorIncludes: "missingVar" }],
        validate: () => ({ passed: true }),
      },
    ]);

    expect(expectedSuite).toMatchObject({
      passed: 1,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
    });
    expect(expectedSuite.results[0]!.execution.toolFailures).toEqual([
      expect.objectContaining({ name: "eval", expected: true }),
    ]);
  });

  it("runs custom test orchestration through the normal validation path", async () => {
    const messages = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "answer-1",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "ORCHESTRATED_OK",
      },
    ] satisfies ChatMessage[];
    const session = {
      channelId: "chat-orchestrated",
      messages,
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        messages,
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const { result, execution } = await tester.runOne({
      name: "orchestrated-test",
      category: "test",
      description: "orchestrated",
      prompt: "default prompt should not be sent directly",
      orchestrate: async ({ runner: orchestrationRunner, sendAndWait }) => {
        const target = await orchestrationRunner.spawn();
        await sendAndWait(target, "phase prompt", "phase one");
        return {
          messages: [...target.messages],
          duration: 1,
          snapshot: target.snapshot(),
        };
      },
      validate: (value) => ({
        passed: value.messages.some((message) => message.content === "ORCHESTRATED_OK"),
      }),
    });

    expect(result.passed).toBe(true);
    expect(execution.messages).toEqual(messages);
    expect(session.sendAndWait).toHaveBeenCalledWith(
      "phase prompt",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("shares one timeout budget across every orchestrated phase", async () => {
    let now = 10_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const session = {
      channelId: "chat-budget",
      messages: [] as ChatMessage[],
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;

    try {
      const { result } = await new TestRunner(runner, { testTimeoutMs: 1_000 }).runOne({
        name: "orchestrated-budget",
        category: "test",
        description: "one shared deadline",
        prompt: "unused",
        orchestrate: async ({ runner: orchestrationRunner, remainingTimeMs, sendAndWait }) => {
          const target = await orchestrationRunner.spawn();
          expect(remainingTimeMs()).toBe(1_000);
          await sendAndWait(target, "first", "phase one");
          now += 250;
          expect(remainingTimeMs()).toBe(750);
          await sendAndWait(target, "second", "phase two");
          return {
            messages: [],
            duration: 250,
            snapshot: target.snapshot(),
          };
        },
        validate: () => ({ passed: true }),
      });

      expect(result.passed).toBe(true);
      expect(
        timeout.mock.calls
          .map((call) => call[1])
          .filter((delay): delay is number => typeof delay === "number")
      ).toEqual([1_000, 750]);
    } finally {
      dateNow.mockRestore();
      timeout.mockRestore();
    }
  });

  it("serializes overlapping shared resources without blocking disjoint tests", async () => {
    let activeGit = 0;
    let maxActiveGit = 0;
    let unrelatedRanWhileGitActive = false;
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    let sessionNumber = 0;
    const makeSession = () => ({
      channelId: `channel-${++sessionNumber}`,
      messages: [] as ChatMessage[],
      sendAndWait: vi.fn(async (name: string) => {
        if (name.startsWith("git")) {
          activeGit += 1;
          maxActiveGit = Math.max(maxActiveGit, activeGit);
          if (name === "git-a") {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          activeGit -= 1;
        } else {
          await firstStarted.promise;
          unrelatedRanWhileGitActive = activeGit === 1;
          releaseFirst.resolve();
        }
      }),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: `channel-${sessionNumber}`,
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 1,
      })),
      close: vi.fn(async () => undefined),
    });
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => makeSession()),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 1_000 });
    const test = (name: string, resources?: string[]) => ({
      name,
      category: "test",
      description: name,
      prompt: name,
      ...(resources ? { resources } : {}),
      validate: () => ({ passed: true }),
    });

    const suite = await tester.runSuite(
      [
        test("git-a", ["workspace-config:git"]),
        test("git-b", ["workspace-config:git"]),
        test("unrelated"),
      ],
      { concurrency: 3 }
    );

    expect(suite.passed).toBe(3);
    expect(maxActiveGit).toBe(1);
    expect(unrelatedRanWhileGitActive).toBe(true);
  });

  it("runs exactly owned workspace repository fixtures concurrently", async () => {
    let activeSetups = 0;
    let maxActiveSetups = 0;
    const bothStarted = deferred<void>();
    const session = () => ({
      channelId: crypto.randomUUID(),
      messages: [] as ChatMessage[],
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: "fixture-channel",
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 1,
      })),
      close: vi.fn(async () => undefined),
    });
    const runner = {
      modelRef: TEST_MODEL,
      forTest: vi.fn((testName: string) => ({
        modelRef: TEST_MODEL,
        prepareWorkspaceRepoFixture: vi.fn(async () => {
          activeSetups += 1;
          maxActiveSetups = Math.max(maxActiveSetups, activeSetups);
          if (activeSetups === 2) bothStarted.resolve();
          await bothStarted.promise;
          activeSetups -= 1;
          return {
            kind: "content" as const,
            section: "projects" as const,
            testName,
            contextId: `context:${testName}`,
            repoName: `system-test-${testName}`,
            repositoryId: `repository:system-test-${testName}`,
            repoPath: `projects/system-test-${testName}`,
            seedFilePaths: [],
            importWorkUnitId: `work:import:${testName}`,
            importChangeIds: [`change:import:${testName}`],
            taskBaseEventId: "event:main",
          };
        }),
        spawn: vi.fn(async () => session()),
        collectDiagnostics: vi.fn(async () => ({})),
        cleanupWorkspaceRepoFixture: vi.fn(async () => ({
          publishedFixtureRemoved: null,
          unexpectedPublishedRepositoriesRemoved: [],
          counteractedChangeIds: [],
        })),
      })),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 1_000 });
    const fixtureTest = (name: string): TestCase => ({
      name,
      category: "test",
      description: name,
      prompt: name,
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
      validate: () => ({ passed: true }),
    });

    const suite = await tester.runSuite([fixtureTest("alpha"), fixtureTest("beta")], {
      concurrency: 2,
    });

    expect(suite.passed).toBe(2);
    expect(maxActiveSetups).toBe(2);
  });

  it("cancellation finishes the ordinary session and fixture cleanup path", async () => {
    const cleanupOrder: string[] = [];
    const session = {
      channelId: "chat-cancelled-fixture",
      agentTargetId: "target-cancelled-fixture",
      messages: [] as ChatMessage[],
      sendAndWait: vi.fn(
        async (_prompt: string, opts?: { signal?: AbortSignal }): Promise<never> =>
          await new Promise<never>((_resolve, reject) => {
            const rejectCancelled = () => reject(new Error("agent wait aborted"));
            if (opts?.signal?.aborted) rejectCancelled();
            else opts?.signal?.addEventListener("abort", rejectCancelled, { once: true });
          })
      ),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: "chat-cancelled-fixture",
        agentEntityId: "agent-cancelled-fixture",
        agentTargetId: "target-cancelled-fixture",
        agentContextId: "ctx-cancelled-fixture",
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      interrupt: vi.fn(async () => {
        cleanupOrder.push("interrupt");
      }),
      close: vi.fn(async () => {
        cleanupOrder.push("close");
      }),
    };
    const fixtureState = {
      kind: "content" as const,
      section: "projects" as const,
      testName: "cancelled-fixture",
      contextId: "context:cancelled-fixture",
      repoName: "system-test-cancelled-fixture",
      repositoryId: "repository:system-test-cancelled-fixture",
      repoPath: "projects/system-test-cancelled-fixture",
      seedFilePaths: [],
      importWorkUnitId: "work:import:cancelled-fixture",
      importChangeIds: ["change:import:cancelled-fixture"],
      taskBaseEventId: "event:main",
    };
    const childRunner = {
      modelRef: TEST_MODEL,
      prepareWorkspaceRepoFixture: vi.fn(async () => fixtureState),
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
      cleanupWorkspaceRepoFixture: vi.fn(async () => {
        cleanupOrder.push("fixture");
        return {
          publishedFixtureRemoved: {
            repositoryId: fixtureState.repositoryId,
            repoPath: fixtureState.repoPath,
          },
          unexpectedPublishedRepositoriesRemoved: [],
          counteractedChangeIds: [fixtureState.importChangeIds[0]!],
        };
      }),
    };
    const runner = {
      ...childRunner,
      forTest: vi.fn(() => childRunner),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 60_000 });
    const running = tester.runSuite([
      {
        name: "cancelled-fixture",
        category: "test",
        description: "cancelled fixture",
        prompt: "wait forever",
        workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
        validate: () => ({ passed: true }),
      },
    ]);
    await vi.waitFor(() => expect(session.sendAndWait).toHaveBeenCalledOnce());

    tester.cancel();
    const suite = await running;

    expect(tester.cancelled).toBe(true);
    expect(suite).toMatchObject({ total: 1, errored: 1 });
    expect(suite.results[0]!.execution.error).toContain("System-test run cancelled");
    expect(suite.results[0]!.execution.diagnostics?.["workspaceRepoFixture"]).toMatchObject({
      repositoryId: fixtureState.repositoryId,
      publishedFixtureRemoved: { repoPath: fixtureState.repoPath },
    });
    expect(cleanupOrder).toEqual(["interrupt", "close", "fixture"]);
  });

  it("surfaces workspace repo fixture teardown failures as infrastructure failures", async () => {
    const messages = [
      {
        id: "answer-fixture",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "FIXTURE_OK",
      },
    ] satisfies ChatMessage[];
    const session = {
      channelId: "chat-fixture",
      messages,
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: "chat-fixture",
        agentEntityId: "agent-fixture",
        agentTargetId: "target-fixture",
        agentContextId: "ctx-fixture",
        messages,
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const fixtureState = {
      kind: "content" as const,
      section: "projects" as const,
      testName: "fixture-test",
      contextId: "context:fixture-test",
      repoName: "system-test-fixture-test-1234",
      repositoryId: "repository:system-test-fixture-test-1234",
      repoPath: "projects/system-test-fixture-test-1234",
      seedFilePaths: [],
      importWorkUnitId: "work:import:fixture-test",
      importChangeIds: ["change:import:fixture-test"],
      taskBaseEventId: "event:main",
    };
    const childRunner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
      prepareWorkspaceRepoFixture: vi.fn(async () => fixtureState),
      cleanupWorkspaceRepoFixture: vi.fn(async () => {
        throw remoteRpcFailure(
          "delete approval transport failed",
          "diagnostic:vcs:fixture-cleanup"
        );
      }),
    };
    const runner = {
      ...childRunner,
      forTest: vi.fn(() => childRunner),
    } as unknown as HeadlessRunner;

    const { result, execution } = await new TestRunner(runner).runOne({
      name: "fixture-test",
      category: "test",
      description: "fixture lifecycle",
      prompt: "create a project",
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
      validate: () => ({ passed: true }),
    });

    expect(result).toMatchObject({
      passed: false,
      reason: "Headless cleanup failed: workspace-repo-fixture: delete approval transport failed",
    });
    expect(execution.error).toBe(
      "Headless cleanup failed: workspace-repo-fixture: delete approval transport failed"
    );
    expect(execution.cleanupErrors).toEqual([
      "workspace-repo-fixture: delete approval transport failed",
    ]);
    expect(execution.cleanupFailures).toEqual([
      {
        phase: "workspace-fixture-cleanup",
        error: {
          name: "RemoteRpcError",
          message: "delete approval transport failed",
          code: "InternalFailure",
          errorKind: "application",
          errorData: {
            code: "InternalFailure",
            message: "delete approval transport failed",
            handle: "diagnostic:vcs:fixture-cleanup",
          },
          diagnosticHandles: ["diagnostic:vcs:fixture-cleanup"],
        },
      },
    ]);
    expect(runner.forTest).toHaveBeenCalledWith("fixture-test", {
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    });
  });

  it("accepts a journaled Spark failure followed by a metered Luna fallback", async () => {
    const fallbackModel = "openai-codex:gpt-5.6-luna";
    const messages = [
      {
        id: "answer-fallback",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "FALLBACK_OK",
      },
    ] satisfies ChatMessage[];
    const evidence = {
      totalCalls: 2,
      calls: [
        {
          ref: TEST_MODEL,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "failed",
        },
        {
          ref: fallbackModel,
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "completed",
          usage: { input: 12, output: 4, totalTokens: 16 },
        },
      ],
    };
    const session = {
      channelId: "chat-fallback",
      messages,
      sendAndWait: vi.fn(async () => messages[0]!),
      captureModelExecutionEvidence: vi.fn(async () => evidence),
      snapshot: vi.fn(() => ({
        channelId: "chat-fallback",
        messages,
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: fallbackModel,
      modelPolicySnapshot: () => ({
        primaryModel: TEST_MODEL,
        activeModel: fallbackModel,
        fallbackModel,
        fallbackThinkingLevel: "minimal",
        fallbackOn: "usage_limit_terminal",
        activations: [],
      }),
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;

    const { result, execution } = await new TestRunner(runner).runOne({
      name: "fallback-test",
      category: "test",
      description: "fallback",
      prompt: "continue",
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(true);
    expect(execution.modelExecutionEvidence).toEqual(evidence);
  });
});
