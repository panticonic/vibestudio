import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import {
  findSystemTestImplementationInspections,
  TestRunner,
  validateAgentCompletionReport,
} from "./test-runner.js";
import type { TestExecutionResult, TestSuiteResult, TestSuiteResultEntry } from "./types.js";
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
    expect(session.close).toHaveBeenCalledWith({
      onPhase: expect.any(Function),
    });
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
    expect(execution.trajectoryReview).toEqual({
      required: true,
      agentReportedOutcome: "unspecified",
      invocationCount: 1,
      modelCallCount: 1,
      unexpectedToolFailureCount: 0,
      repeatedFailureOperations: [],
      potentialConfusionSignals: ["missing-completion-report"],
      frequentOperations: [],
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
      validation: "harness" as const,
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

  it("persists a thrown validator as one terminal test result and still retires the session", async () => {
    const messages = [
      {
        id: "prompt-validator",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "invocation-validator",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify({
          id: "call-validator",
          name: "eval",
          arguments: { code: "token=must-not-persist" },
          execution: {
            status: "complete",
            isError: false,
            result: {
              details: {
                returnValue: {
                  created: "panels/example",
                  publication: { published: true },
                },
              },
            },
          },
        }),
      },
      {
        id: "answer-validator",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message",
        complete: true,
        content: "Created and opened the panel.",
      },
    ] satisfies ChatMessage[];
    const snapshot = {
      channelId: "chat-validator",
      agentEntityId: "agent-validator",
      agentTargetId: "target-validator",
      agentContextId: "ctx-validator",
      messages,
      invocations: [],
      debugEvents: [{ kind: "panel-ready" }],
      cleanupErrors: [],
      participants: {},
      connected: true,
      duration: 10,
    };
    const session = {
      channelId: snapshot.channelId,
      messages,
      sendAndWait: vi.fn(async () => undefined),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => snapshot),
      close: vi.fn(async () => undefined),
    };
    const onTestResult = vi.fn(
      async (_entry: TestSuiteResultEntry, _aggregate: TestSuiteResult) => undefined
    );
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({ generatedAt: "now" })),
    } as unknown as HeadlessRunner;

    const suite = await new TestRunner(runner, { onTestResult }).runSuite([
      {
        name: "validator-crash",
        category: "test",
        description: "validator containment",
        prompt: "create and open a panel",
        validation: "harness" as const,
        validate: () => {
          const missing: { values?: string[] } = {};
          return { passed: missing.values!.includes("ready") };
        },
      },
    ]);

    expect(suite).toMatchObject({ total: 1, passed: 0, failed: 0, errored: 1 });
    expect(suite.results[0]).toMatchObject({
      result: {
        passed: false,
        reason: "Error: Cannot read properties of undefined (reading 'includes')",
      },
      execution: {
        error: "Cannot read properties of undefined (reading 'includes')",
        failure: {
          phase: "validation",
          error: {
            name: "TypeError",
            message: "Cannot read properties of undefined (reading 'includes')",
          },
        },
        validationFailure: {
          testName: "validator-crash",
          validator: "harness",
          phase: "validation",
          stack: expect.stringContaining("test-runner.test.ts"),
          inputProjection: {
            messageCount: 3,
            invocations: [
              {
                name: "eval",
                status: "complete",
                arguments: {
                  type: "object",
                  fields: { code: "string" },
                },
                result: {
                  type: "object",
                  fields: {
                    details: {
                      type: "object",
                      fields: {
                        returnValue: {
                          type: "object",
                          fields: {
                            created: "string",
                            publication: {
                              type: "object",
                              fields: { published: "boolean" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
        snapshot: {
          channelId: "chat-validator",
          debugEvents: [{ kind: "panel-ready" }],
        },
        diagnostics: { generatedAt: "now" },
      },
    });
    expect(onTestResult).toHaveBeenCalledOnce();
    expect(onTestResult.mock.calls[0]![0]).toMatchObject({
      execution: { validationFailure: suite.results[0]!.execution.validationFailure },
    });
    expect(JSON.stringify(suite.results[0]!.execution.validationFailure)).not.toContain(
      "must-not-persist"
    );
    expect(session.close).toHaveBeenCalledOnce();
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
      validation: "harness" as const,
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
        senderMetadata: { type: "agent" },
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
        id: "invocation:call-2",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify({
          id: "call-2",
          name: "vcs",
          execution: {
            status: "error",
            terminalOutcome: "tool_error",
            terminalReasonCode: "WorkingChangesPresent",
            result: { error: "Push requires a clean committed event" },
            isError: true,
          },
        }),
      },
      {
        id: "invocation:call-3",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify({
          id: "call-3",
          name: "eval",
          execution: {
            status: "error",
            terminalOutcome: "tool_error",
            terminalReasonCode: "guest_execution_failed",
            result: {
              details: {
                success: false,
                failureKind: "user-code",
                failureCode: "guest_execution_failed",
                error: "Assertion failed while developing the fixture",
              },
            },
            isError: true,
          },
        }),
      },
      {
        id: "answer-1",
        senderId: "agent",
        senderMetadata: { type: "agent" },
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
          {
            id: "call-2",
            name: "vcs",
            status: "error",
            terminalReasonCode: "WorkingChangesPresent",
            execution: {
              status: "error",
              terminalOutcome: "tool_error",
              terminalReasonCode: "WorkingChangesPresent",
              result: { error: "Push requires a clean committed event" },
              isError: true,
            },
          },
          {
            id: "call-3",
            name: "eval",
            status: "error",
            terminalReasonCode: "guest_execution_failed",
            execution: {
              status: "error",
              terminalOutcome: "tool_error",
              terminalReasonCode: "guest_execution_failed",
              result: {
                details: {
                  success: false,
                  failureKind: "user-code",
                  failureCode: "guest_execution_failed",
                  error: "Assertion failed while developing the fixture",
                },
              },
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
        validation: "harness" as const,
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
    expect(suite.results[0]!.execution.toolFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "eval",
          status: "error",
          terminalOutcome: "tool_error",
          error: "ReferenceError: missingVar is not defined",
        }),
        expect.objectContaining({
          name: "vcs",
          diagnosticOnly: true,
          classification: "domain-rejection",
          terminalReasonCode: "WorkingChangesPresent",
        }),
        expect.objectContaining({
          name: "eval",
          diagnosticOnly: true,
          classification: "guest-code-failure",
          terminalReasonCode: "guest_execution_failed",
          failureKind: "user-code",
        }),
      ])
    );

    const expectedSuite = await tester.runSuite([
      {
        name: "intentional-tool-error-recovery",
        category: "test",
        description: "intentional tool error recovery",
        prompt: "trigger recovery",
        expectedToolFailures: [{ name: "eval", errorIncludes: "missingVar" }],
        validation: "harness" as const,
        validate: () => ({ passed: true }),
      },
    ]);

    expect(expectedSuite).toMatchObject({
      passed: 1,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
    });
    expect(expectedSuite.results[0]!.execution.toolFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "eval", expected: true }),
        expect.objectContaining({
          name: "vcs",
          classification: "domain-rejection",
        }),
      ])
    );
  });

  it("fails fast when a test-policy authority prompt is unexpectedly emitted", async () => {
    let listener: ((message: ChatMessage) => void) | undefined;
    const session = {
      channelId: "chat-authority-failure",
      agentTargetId: "target-authority-failure",
      messages: [] as ChatMessage[],
      onMessage: vi.fn((callback: (message: ChatMessage) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
      sendAndWait: vi.fn(() => new Promise<never>(() => undefined)),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => ({
        channelId: "chat-authority-failure",
        agentTargetId: "target-authority-failure",
        messages: session.messages,
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const running = new TestRunner(runner, { testTimeoutMs: 60_000 }).runOne({
      name: "authority-failure",
      category: "test",
      description: "authority failure",
      prompt: "trigger an authority failure",
      validation: "harness" as const,
      validate: () => ({ passed: true }),
    });

    await vi.waitFor(() => expect(session.sendAndWait).toHaveBeenCalledOnce());
    listener?.({
      id: "invocation:authority-failure",
      senderId: "agent",
      senderMetadata: { type: "agent" },
      kind: "message",
      contentType: "invocation",
      complete: true,
      content: "authority failure",
      invocation: {
        id: "authority-failure",
        name: "eval",
        arguments: {},
        execution: {
          status: "error",
          description:
            "Unexpected authority prompt in system test authority-failure: workspace.runtime-state.manage",
          result: {
            error: "EUNEXPECTEDTESTPROMPT",
          },
          isError: true,
        },
      },
    });

    const { result, execution } = await running;
    expect(result.passed).toBe(false);
    expect(execution.error).toContain("Unexpected authority prompt in system test");
    expect(execution.error).toContain("workspace.runtime-state.manage");
    expect(session.interrupt).toHaveBeenCalledWith("target-authority-failure");
    expect(session.close).toHaveBeenCalledOnce();
    expect(listener).toBeUndefined();
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
        senderMetadata: { type: "agent" },
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
        channelId: "chat-orchestrated",
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
      collectDiagnostics: vi.fn(async () => ({
        channelDelivery: { deliveryLifecycle: { latencyHistogram: [] } },
      })),
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
          diagnostics: { orchestratedEvidence: { recovered: true } },
        };
      },
      validation: "harness" as const,
      validate: (value) => ({
        passed: value.messages.some((message) => message.content === "ORCHESTRATED_OK"),
      }),
    });

    expect(result.passed).toBe(true);
    expect(execution.messages).toEqual(messages);
    expect(execution.diagnostics).toMatchObject({
      orchestratedEvidence: { recovered: true },
      channelDelivery: { deliveryLifecycle: { latencyHistogram: [] } },
    });
    expect(runner.collectDiagnostics).toHaveBeenCalledWith({ channelId: "chat-orchestrated" });
    expect(session.sendAndWait).toHaveBeenCalledWith(
      "phase prompt",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("gates a natural agent completion on independent outcome evidence", async () => {
    const messages = [
      {
        id: "prompt-agent-evidence",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "fix the visible problem",
      },
      {
        id: "answer-agent-evidence",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message",
        complete: true,
        content: "The problem is fixed.",
      },
    ] satisfies ChatMessage[];
    const snapshot = {
      channelId: "chat-agent-evidence",
      messages,
      invocations: [],
      debugEvents: [],
      cleanupErrors: [],
      participants: {},
      connected: true,
      duration: 10,
    };
    const session = {
      channelId: "chat-agent-evidence",
      messages,
      sendAndWait: vi.fn(async () => messages[1]),
      captureModelExecutionEvidence: vi.fn(async () => modelEvidence()),
      snapshot: vi.fn(() => snapshot),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      modelRef: TEST_MODEL,
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({
        channelDelivery: { deliveryLifecycle: { latencyHistogram: [] } },
      })),
    } as unknown as HeadlessRunner;
    const validate = vi.fn(() => ({
      passed: false,
      reason: "The saved workspace still contains the original defect",
    }));

    const { result } = await new TestRunner(runner).runOne({
      name: "agent-evidence",
      category: "test",
      description: "objective agent outcome",
      prompt: "Fix the visible problem.",
      validation: "agent-evidence",
      validate,
    });

    expect(validate).toHaveBeenCalledOnce();
    expect(result).toEqual({
      passed: false,
      reason: "The saved workspace still contains the original defect",
    });
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
        validation: "harness" as const,
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
      validation: "harness" as const,
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

  it("serializes workspace repository fixtures while unrelated tests remain concurrent", async () => {
    let activeSetups = 0;
    let maxActiveSetups = 0;
    let unrelatedRanWhileFixtureActive = false;
    const unrelatedStarted = deferred<void>();
    const session = (testName: string) => ({
      channelId: crypto.randomUUID(),
      messages: [] as ChatMessage[],
      sendAndWait: vi.fn(async () => {
        if (testName === "unrelated") {
          unrelatedRanWhileFixtureActive = activeSetups === 1;
          unrelatedStarted.resolve();
        }
      }),
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
          if (testName === "alpha") await unrelatedStarted.promise;
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
        spawn: vi.fn(async () => session(testName)),
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
      validation: "harness" as const,
      validate: () => ({ passed: true }),
    });
    const unrelatedTest: TestCase = {
      name: "unrelated",
      category: "test",
      description: "unrelated",
      prompt: "unrelated",
      validation: "harness" as const,
      validate: () => ({ passed: true }),
    };

    const suite = await tester.runSuite(
      [fixtureTest("alpha"), fixtureTest("beta"), unrelatedTest],
      { concurrency: 3 }
    );

    expect(suite.passed).toBe(3);
    expect(maxActiveSetups).toBe(1);
    expect(unrelatedRanWhileFixtureActive).toBe(true);
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
        validation: "harness" as const,
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
        senderMetadata: { type: "agent" },
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
      validation: "harness" as const,
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
        senderMetadata: { type: "agent" },
        kind: "message",
        complete: true,
        content: "FALLBACK_OK",
      },
    ] satisfies ChatMessage[];
    const evidence = {
      totalCalls: 4,
      calls: [
        {
          messageId: "m:t:chat-fallback:first:agent:0",
          ref: TEST_MODEL,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "failed",
        },
        {
          messageId: "m:t:chat-fallback:first:agent:1",
          ref: fallbackModel,
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "completed",
          usage: { input: 12, output: 4, totalTokens: 16 },
        },
        {
          messageId: "m:t:chat-fallback:followup:agent:0",
          ref: TEST_MODEL,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "failed",
        },
        {
          messageId: "m:t:chat-fallback:followup:agent:1",
          ref: fallbackModel,
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          api: "openai-codex-responses",
          auth: "url-bound",
          outcome: "completed",
          usage: { input: 10, output: 3, totalTokens: 13 },
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
        activeModel: TEST_MODEL,
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
      validation: "harness" as const,
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(true);
    expect(execution.modelExecutionEvidence).toEqual(evidence);
  });
});

describe("validateAgentCompletionReport", () => {
  const execution = (final: string): TestExecutionResult =>
    ({
      duration: 1,
      messages: [
        {
          id: "user",
          senderId: "user",
          senderMetadata: { type: "headless" },
          kind: "message",
          contentType: "text",
          content: "Exercise file handles.",
          complete: true,
        },
        {
          id: "agent",
          senderId: "agent",
          senderMetadata: { type: "agent" },
          kind: "message",
          contentType: "text",
          content: final,
          complete: true,
        },
      ],
    }) as TestExecutionResult;

  it("trusts an explicit completed status despite scoped caveats", () => {
    expect(
      validateAgentCompletionReport(
        execution(
          "Task completed.\n\nAll requested lifecycle behavior was verified.\n\nWhat I could not verify: automatic cleanup after a process crash."
        )
      )
    ).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: { required: true, agentReportedOutcome: "completed" },
      },
    });
  });

  it("accepts a summary immediately after the completed status marker", () => {
    expect(
      validateAgentCompletionReport(
        execution("Task completed. I verified a full write/read round-trip.")
      )
    ).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: { required: true, agentReportedOutcome: "completed" },
      },
    });
  });

  it("accepts one terminal declaration after transport-combined progress text", () => {
    expect(
      validateAgentCompletionReport(
        execution(
          "Comparing the read output against the write payload.\n\nTask completed.\nThe contents matched exactly."
        )
      )
    ).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: { required: true, agentReportedOutcome: "completed" },
      },
    });
  });

  it("trusts an explicit incomplete status", () => {
    expect(
      validateAgentCompletionReport(
        execution(
          "Task not completed.\n\nThe documented operation returned an infrastructure error."
        )
      )
    ).toMatchObject({
      passed: false,
      reason: expect.stringContaining("did not complete"),
    });
  });

  it("accepts a natural completion report without requiring marker syntax", () => {
    expect(
      validateAgentCompletionReport(execution("All requested lifecycle behavior was verified."))
    ).toEqual({
      passed: true,
      details: {
        trajectoryReview: expect.objectContaining({
          required: true,
          agentReportedOutcome: "unspecified",
        }),
      },
    });
  });

  it("rejects a completion report when harness-observed execution invariants failed", () => {
    const result = execution("Task completed. The temporary panel was inspected.");
    result.error = "Agent left temporary panels in the tree: panel-leak";

    expect(validateAgentCompletionReport(result)).toEqual({
      passed: false,
      reason:
        "Agent-goal execution failed: Agent left temporary panels in the tree: panel-leak",
    });
  });

  it("rejects a completion report when harness cleanup did not finish", () => {
    const result = execution("Task completed. The panel lifecycle was verified.");
    result.cleanupErrors = ["archive leaked panel panel-leak: unavailable"];

    expect(validateAgentCompletionReport(result)).toEqual({
      passed: false,
      reason:
        "Agent-goal cleanup failed: archive leaked panel panel-leak: unavailable",
    });
  });

  it("flags a wasteful trajectory for review without converting success into failure", () => {
    const result = execution("The requested command completed successfully.");
    result.snapshot = {
      invocations: Array.from({ length: 24 }, (_, index) => ({
        id: `read-${index}`,
        name: "read",
        status: "complete",
      })),
    } as TestExecutionResult["snapshot"];
    result.modelExecutionEvidence = { totalCalls: 18, calls: [] };

    expect(validateAgentCompletionReport(result)).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: {
          potentialConfusionSignals: [
            "high-model-call-count",
            "high-tool-invocation-count",
            "frequent-operation:read",
          ],
          frequentOperations: [{ name: "read", count: 24 }],
        },
      },
    });
  });

  it("flags duplicate substantial completion reports without failing the scenario", () => {
    const result = execution(`First complete synthesis. ${"detail ".repeat(90)}`);
    result.messages.push({
      ...result.messages[1]!,
      id: "agent-second-completion",
      content: `Second complete synthesis. ${"detail ".repeat(90)}`,
    });

    expect(validateAgentCompletionReport(result)).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: {
          potentialConfusionSignals: ["multiple-substantial-completion-reports"],
        },
      },
    });
  });

  it("flags repeated subagent transcript access without failing the scenario", () => {
    const result = execution("The two design reviews were synthesized.");
    result.snapshot = {
      invocations: [
        { id: "inspect-1", name: "inspect_subagent", status: "complete" },
        { id: "read-1", name: "read_subagent", status: "complete" },
      ],
    } as TestExecutionResult["snapshot"];

    expect(validateAgentCompletionReport(result)).toMatchObject({
      passed: true,
      details: {
        trajectoryReview: {
          potentialConfusionSignals: ["subagent-transcript-chasing"],
        },
      },
    });
  });

  it("recognizes the agent when recipient delivery omits every self-authored message", () => {
    const result = execution("The retained child result was reviewed without integration.");
    result.messages = result.messages.slice(1);

    expect(validateAgentCompletionReport(result)).toMatchObject({ passed: true });
  });

  it("rejects conflicting terminal declarations", () => {
    expect(
      validateAgentCompletionReport(
        execution("Task not completed.\nRetry succeeded.\nTask completed.")
      )
    ).toMatchObject({
      passed: false,
      reason: expect.stringContaining("conflicting"),
    });
  });
});

describe("system-test implementation boundary", () => {
  it("detects agent reads of harness implementation without matching ordinary workspace files", () => {
    const execution = {
      duration: 1,
      messages: [
        {
          id: "read-fixture",
          senderId: "agent",
          kind: "message",
          contentType: "invocation",
          complete: true,
          content: "",
          invocation: {
            id: "call:fixture",
            name: "read",
            arguments: { path: "skills/system-testing/workspace-repo-fixture.ts" },
          },
        },
        {
          id: "read-product",
          senderId: "agent",
          kind: "message",
          contentType: "invocation",
          complete: true,
          content: "",
          invocation: {
            id: "call:product",
            name: "read",
            arguments: { path: "projects/example/src/index.ts" },
          },
        },
        {
          id: "eval-fixture",
          senderId: "agent",
          kind: "message",
          contentType: "invocation",
          complete: true,
          content: "",
          invocation: {
            id: "call:eval-fixture",
            name: "eval",
            arguments: {
              code: 'return fs.readFile("skills/system-testing/workspace-repo-fixture.ts")',
            },
          },
        },
      ],
    } as unknown as TestExecutionResult;

    expect(findSystemTestImplementationInspections(execution)).toEqual([
      {
        id: "call:fixture",
        name: "read",
        arguments: '{"path":"skills/system-testing/workspace-repo-fixture.ts"}',
      },
      {
        id: "call:eval-fixture",
        name: "eval",
        arguments:
          '{"code":"return fs.readFile(\\"skills/system-testing/workspace-repo-fixture.ts\\")"}',
      },
    ]);
  });
});
