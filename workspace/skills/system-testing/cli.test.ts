import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcCall: vi.fn(async () => ({ artifactId: "build-1" })),
  runSuite: vi.fn(),
  runnerArgs: [] as unknown[],
  testerOptions: null as Record<string, unknown> | null,
  captureAll: vi.fn(async () => []),
  snapshotAll: vi.fn(() => []),
  closeAll: vi.fn(async () => undefined),
  modelPolicySnapshot: vi.fn(() => ({
    primaryModel: "openai-codex:gpt-5.3-codex-spark",
    activeModel: "openai-codex:gpt-5.3-codex-spark",
    fallbackModel: "openai-codex:gpt-5.6-luna",
    fallbackThinkingLevel: "minimal" as const,
    fallbackOn: "usage_limit_terminal" as const,
    activations: [],
  })),
}));

vi.mock("@workspace/runtime", () => ({
  rpc: { call: mocks.rpcCall },
  workers: { resolveService: vi.fn() },
  workspace: { units: { list: vi.fn() } },
}));

vi.mock("./runner.js", () => ({
  HeadlessRunner: class {
    constructor(...args: unknown[]) {
      mocks.runnerArgs = args;
    }
    captureAll() {
      return mocks.captureAll();
    }
    snapshotAll() {
      return mocks.snapshotAll();
    }
    closeAll() {
      return mocks.closeAll();
    }
    modelPolicySnapshot() {
      return mocks.modelPolicySnapshot();
    }
  },
}));

vi.mock("./test-runner.js", () => ({
  TestRunner: class {
    constructor(_runner: unknown, opts?: Record<string, unknown>) {
      mocks.testerOptions = opts ?? null;
    }
    async runSuite(tests: Array<{ name: string }>, opts?: unknown) {
      const onTestStart = mocks.testerOptions?.["onTestStart"] as
        | ((test: unknown) => void)
        | undefined;
      const onTestResult = mocks.testerOptions?.["onTestResult"] as
        | ((entry: unknown, aggregate: unknown) => Promise<void> | void)
        | undefined;
      for (const test of tests) onTestStart?.(test);
      const result = await mocks.runSuite(tests, opts);
      for (const entry of result.results ?? []) await onTestResult?.(entry, result);
      return result;
    }
  },
}));

vi.mock("./stages.js", () => ({
  allTests: () => [
    {
      name: "alpha",
      category: "smoke",
      description: "alpha test",
      prompt: "alpha",
      validate: () => ({ passed: true }),
    },
    {
      name: "alphabet",
      category: "filesystem",
      description: "alphabet test",
      prompt: "alphabet",
      validate: () => ({ passed: true }),
    },
    {
      name: "worker-one",
      category: "workers",
      description: "worker test",
      prompt: "worker",
      validate: () => ({ passed: true }),
    },
  ],
}));

import { failedSystemTestNames, listSystemTests, runSystemTests } from "./cli.js";
import { SYSTEM_TEST_AGENT_MODEL } from "./config.js";

describe("system-testing CLI-neutral API", () => {
  beforeEach(() => {
    mocks.rpcCall.mockClear();
    mocks.runSuite.mockReset();
    mocks.runnerArgs = [];
    mocks.testerOptions = null;
    mocks.captureAll.mockReset().mockResolvedValue([]);
    mocks.snapshotAll.mockReset().mockReturnValue([]);
    mocks.closeAll.mockReset().mockResolvedValue(undefined);
    mocks.modelPolicySnapshot.mockClear();
  });

  it("lists stable exact test descriptors", () => {
    expect(listSystemTests()).toEqual([
      {
        name: "alpha",
        category: "smoke",
        description: "alpha test",
        orchestrated: false,
      },
      {
        name: "alphabet",
        category: "filesystem",
        description: "alphabet test",
        orchestrated: false,
      },
      {
        name: "worker-one",
        category: "workers",
        description: "worker test",
        orchestrated: false,
      },
    ]);
  });

  it("runs an exact name without substring expansion and records configuration", async () => {
    mocks.runSuite.mockResolvedValue({
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
      skipped: 0,
      duration: 12,
      results: [
        {
          test: { name: "alpha", category: "smoke", description: "alpha test", prompt: "alpha" },
          result: { passed: true },
          execution: { messages: [], duration: 12 },
        },
      ],
    });

    const progress = vi.fn();
    const record = await runSystemTests({
      runId: "st_exact",
      contextId: "ctx-1",
      names: ["alpha"],
      model: "openai:test",
      concurrency: 2,
      testTimeoutMs: 99,
      onProgress: progress,
    });

    expect(mocks.runnerArgs).toEqual(["ctx-1", { model: "openai:test" }]);
    expect(mocks.runSuite.mock.calls[0]![0]).toHaveLength(1);
    expect(mocks.runSuite.mock.calls[0]![0][0].name).toBe("alpha");
    expect(record.config).toMatchObject({
      names: ["alpha"],
      concurrency: 2,
      testTimeoutMs: 99,
    });
    expect(record.summary).toMatchObject({ runId: "st_exact", passed: 1, failed: 0 });
    expect(progress.mock.calls[0]?.[0]).toMatchObject({
      status: "running",
      total: 1,
      queued: ["alpha"],
      running: [],
      completed: [],
    });
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "completed",
      queued: [],
      running: [],
      completed: [expect.objectContaining({ name: "alpha", outcome: "passed" })],
    });
  });

  it("pins the default model for every spawned test agent and records it", async () => {
    mocks.runSuite.mockResolvedValue({
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
      skipped: 0,
      duration: 0,
      results: [],
    });

    const record = await runSystemTests({
      runId: "st_default_model",
      contextId: "ctx-1",
      names: ["alpha"],
    });

    expect(mocks.runnerArgs).toEqual(["ctx-1", { model: SYSTEM_TEST_AGENT_MODEL }]);
    expect(record.config.model).toBe(SYSTEM_TEST_AGENT_MODEL);
    expect(record.config.modelPolicy).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      fallbackModel: "openai-codex:gpt-5.6-luna",
      fallbackThinkingLevel: "minimal",
      fallbackOn: "usage_limit_terminal",
    });
  });

  it("handles a rejected background progress publication without an unhandled rejection", async () => {
    mocks.runSuite.mockResolvedValue({
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
      skipped: 0,
      duration: 1,
      results: [
        {
          test: { name: "alpha", category: "smoke", description: "alpha test", prompt: "alpha" },
          result: { passed: true },
          execution: { messages: [], duration: 1 },
        },
      ],
    });
    const progress = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("progress unavailable"))
      .mockResolvedValue(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runSystemTests({
        runId: "st_progress_rejection",
        contextId: "ctx-1",
        names: ["alpha"],
        onProgress: progress,
      })
    ).resolves.toMatchObject({ status: "completed" });
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining("progress unavailable"))
    );
  });

  it("publishes active trajectories plus bounded completed failures in live heartbeats", async () => {
    vi.useFakeTimers();
    try {
      let resolveSuite!: (value: unknown) => void;
      mocks.runSuite.mockImplementationOnce(
        () => new Promise((resolve) => (resolveSuite = resolve))
      );
      mocks.runSuite.mockResolvedValue({
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
        duration: 1,
        results: [],
      });
      const snapshot = (name: string) => ({
        channelId: `headless-${name}`,
        agentEntityId: `agent-${name}`,
        agentTargetId: `target-${name}`,
        agentContextId: `ctx-${name}`,
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        localMethodNames: [],
        connected: true,
        duration: 5,
        title: null,
        modelExecutionEvidence: { totalCalls: 1, calls: [] },
      });
      mocks.snapshotAll.mockReturnValue([
        { testName: "alpha", snapshot: snapshot("alpha") },
        { testName: "alphabet", snapshot: snapshot("alphabet") },
      ] as never);
      const onInspectionUpdate = vi.fn(
        async (_record: { suite: { results: unknown[] } }) => undefined
      );

      const running = runSystemTests({
        runId: "st_live_bounded",
        contextId: "ctx-1",
        names: ["alpha", "alphabet"],
        onInspectionUpdate,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(mocks.runSuite).toHaveBeenCalled());

      const onTestResult = mocks.testerOptions?.["onTestResult"] as
        | ((entry: unknown) => Promise<void>)
        | undefined;
      expect(onTestResult).toBeTypeOf("function");
      await onTestResult!({
        test: { name: "alpha", category: "smoke", description: "alpha test", prompt: "alpha" },
        result: { passed: false, reason: "alpha failed" },
        execution: { messages: [], duration: 10 },
      });
      // Categories normally start sequentially. Simulate the next category
      // becoming active while the first category's completed result remains in
      // completedEntries.
      const onTestStart = mocks.testerOptions?.["onTestStart"] as
        | ((test: unknown) => void)
        | undefined;
      onTestStart?.({
        name: "alphabet",
        category: "filesystem",
        description: "alphabet test",
        prompt: "alphabet",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(onInspectionUpdate).toHaveBeenCalled();
      const heartbeat = onInspectionUpdate.mock.calls.at(-1)?.[0];
      expect(heartbeat).toBeDefined();
      expect(
        (heartbeat!.suite.results as Array<{ test: { name: string } }>).map(
          (entry) => entry.test.name
        )
      ).toEqual(["alpha", "alphabet"]);

      resolveSuite({
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
        duration: 1,
        results: [],
      });
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an inspectable partial record from cancellation cleanup", async () => {
    let resolveSuite!: (value: unknown) => void;
    mocks.runSuite.mockImplementation(() => new Promise((resolve) => (resolveSuite = resolve)));
    mocks.captureAll.mockResolvedValue([
      {
        testName: "alpha",
        snapshot: {
          channelId: "headless-alpha",
          agentEntityId: "agent-alpha",
          agentTargetId: "target-alpha",
          agentContextId: "ctx-alpha",
          messages: [],
          invocations: [{ id: "call-1", name: "eval", status: "failed", error: "boom" }],
          debugEvents: [],
          cleanupErrors: [],
          participants: {},
          localMethodNames: [],
          connected: true,
          duration: 5,
          title: null,
          modelExecutionEvidence: { totalCalls: 1, calls: [] },
        },
      },
    ] as never);
    let cleanup: (() => Promise<unknown>) | undefined;
    const running = runSystemTests({
      runId: "st_cancelled",
      contextId: "ctx-1",
      names: ["alpha"],
      registerCancellationCleanup: (handler) => {
        cleanup = handler;
      },
    });
    await vi.waitFor(() => expect(cleanup).toBeTypeOf("function"));

    const record = await cleanup!();
    expect(record).toMatchObject({
      runId: "st_cancelled",
      status: "cancelled",
      summary: { status: "cancelled", errored: 1 },
      suite: {
        results: [
          {
            test: { name: "alpha" },
            execution: {
              provenance: { channelId: "headless-alpha" },
              toolFailures: [{ name: "eval", error: "boom" }],
            },
          },
        ],
      },
    });
    expect(mocks.captureAll).toHaveBeenCalledBefore(mocks.closeAll);

    resolveSuite({
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
      duration: 1,
      results: [],
    });
    await running;
  });

  it("rejects unknown exact names", async () => {
    await expect(
      runSystemTests({ runId: "st_unknown", contextId: "ctx-1", names: ["alp"] })
    ).rejects.toThrow("Unknown system test(s): alp");
    expect(mocks.runSuite).not.toHaveBeenCalled();
  });

  it("caps the workers category at one concurrent agent", async () => {
    mocks.runSuite.mockResolvedValue({
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      skipped: 0,
      duration: 1,
      results: [],
    });

    await runSystemTests({
      runId: "st_workers",
      contextId: "ctx-1",
      names: ["worker-one"],
      concurrency: 8,
    });

    expect(mocks.runSuite).toHaveBeenCalledWith([expect.objectContaining({ name: "worker-one" })], {
      concurrency: 1,
    });
  });

  it("includes passing tests with unexpected tool failures in reruns", () => {
    expect(
      failedSystemTestNames({
        schemaVersion: 1,
        runId: "st_tools",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        config: {
          contextId: "ctx-1",
          names: ["alpha"],
          all: false,
          modelPolicy: mocks.modelPolicySnapshot(),
          concurrency: 1,
          testTimeoutMs: 100,
        },
        provenance: {},
        summary: {
          runId: "st_tools",
          status: "completed",
          total: 1,
          passed: 1,
          failed: 0,
          errored: 0,
          toolFailureCount: 1,
          testsWithToolFailures: 1,
          skipped: 0,
          durationMs: 1,
          failedTests: [],
          testsWithUnexpectedToolFailures: ["alpha"],
        },
        suite: {
          total: 1,
          passed: 1,
          failed: 0,
          errored: 0,
          skipped: 0,
          duration: 1,
          results: [
            {
              test: {
                name: "alpha",
                category: "smoke",
                description: "alpha test",
                prompt: "alpha",
              },
              result: { passed: true },
              execution: {
                messages: [],
                duration: 1,
                toolFailures: [{ name: "eval", source: "snapshot" }],
              },
            },
          ],
        },
      })
    ).toEqual(["alpha"]);
  });
});
