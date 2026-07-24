import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcCall: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ artifactId: "build-1" })),
  runSuite: vi.fn(),
  cancelTestRunner: vi.fn(),
  testerCancelled: false,
  runnerArgs: [] as unknown[],
  testerOptions: null as Record<string, unknown> | null,
  snapshotAll: vi.fn(() => []),
  modelPolicySnapshot: vi.fn(() => ({
    primaryModel: "openai-codex:gpt-5.4-mini",
    activeModel: "openai-codex:gpt-5.4-mini",
    fallbackModel: null,
    fallbackThinkingLevel: null,
    fallbackOn: null,
    activations: [],
  })),
  resolveService: vi.fn(),
  listUnits: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  rpc: { call: mocks.rpcCall },
  workers: { resolveService: mocks.resolveService },
  workspace: { units: { list: mocks.listUnits } },
}));

vi.mock("./runner.js", () => ({
  HeadlessRunner: class {
    constructor(...args: unknown[]) {
      mocks.runnerArgs = args;
    }
    snapshotAll() {
      return mocks.snapshotAll();
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
    cancel() {
      mocks.testerCancelled = true;
      mocks.cancelTestRunner();
    }
    get cancelled() {
      return mocks.testerCancelled;
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

import {
  failedSystemTestNames,
  inspectSystemTestRun,
  listSystemTests,
  runSystemTests,
  systemTestDoctor,
  systemTestTrajectory,
  type SystemTestRunRecord,
} from "./cli.js";
import { SYSTEM_TEST_AGENT_MODEL } from "./config.js";

describe("system-testing CLI-neutral API", () => {
  beforeEach(() => {
    mocks.rpcCall.mockReset().mockResolvedValue({ artifactId: "build-1" });
    mocks.runSuite.mockReset();
    mocks.cancelTestRunner.mockReset();
    mocks.testerCancelled = false;
    mocks.runnerArgs = [];
    mocks.testerOptions = null;
    mocks.snapshotAll.mockReset().mockReturnValue([]);
    mocks.modelPolicySnapshot.mockClear();
    mocks.resolveService.mockReset();
    mocks.listUnits.mockReset();
  });

  function configureHealthyDoctorModels(
    models: Array<{ ref: string; availability: { state: string } }>
  ): void {
    mocks.resolveService.mockResolvedValue({
      kind: "durable-object",
      targetId: "do:models",
    });
    mocks.listUnits.mockResolvedValue([{ name: "workers/agent-worker", status: "running" }]);
    mocks.rpcCall.mockImplementation(async (...args: unknown[]) => {
      const method = args[1];
      if (method === "inspectModels") return { models };
      return {};
    });
  }

  it("doctors only an explicitly selected model when the run has no fallback", async () => {
    configureHealthyDoctorModels([{ ref: "anthropic:test-model", availability: { state: "ready" } }]);

    const result = await systemTestDoctor("anthropic:test-model");

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "model")).toMatchObject({
      ok: true,
      data: {
        primary: { model: "anthropic:test-model", availability: "ready" },
        usageLimitFallback: null,
      },
    });
  });

  it("treats an explicit default-model selection as a single-model run", async () => {
    configureHealthyDoctorModels([
      { ref: SYSTEM_TEST_AGENT_MODEL, availability: { state: "ready" } },
    ]);

    const result = await systemTestDoctor(SYSTEM_TEST_AGENT_MODEL);

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "model")).toMatchObject({
      ok: true,
      data: {
        primary: { model: SYSTEM_TEST_AGENT_MODEL, availability: "ready" },
        usageLimitFallback: null,
      },
    });
  });

  it("doctors only GPT-5.4 mini for the default route", async () => {
    configureHealthyDoctorModels([
      { ref: SYSTEM_TEST_AGENT_MODEL, availability: { state: "ready" } },
    ]);

    const result = await systemTestDoctor();

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "model")).toMatchObject({
      ok: true,
      data: {
        primary: { model: SYSTEM_TEST_AGENT_MODEL, availability: "ready" },
        usageLimitFallback: null,
      },
    });
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

  it("exposes structured failures through inspect and trajectory views", () => {
    const setupFailure = {
      phase: "workspace-fixture-setup",
      error: {
        name: "RemoteRpcError",
        message: "fixture setup failed",
        code: "InternalFailure",
        errorKind: "application",
        errorData: { code: "InternalFailure", handle: "diagnostic:vcs:inspectable" },
        diagnosticHandles: ["diagnostic:vcs:inspectable"],
      },
    };
    const primaryFailure = {
      phase: "agent-turn",
      error: {
        name: "RemoteRpcError",
        message: "agent turn failed",
        code: "InternalFailure",
        errorData: { handle: "diagnostic:agent:primary" },
        diagnosticHandles: ["diagnostic:agent:primary"],
      },
    };
    const cleanupFailure = {
      phase: "session-close",
      error: {
        name: "RemoteRpcError",
        message: "session close failed",
        code: "InternalFailure",
        errorData: { handle: "diagnostic:agent:cleanup" },
        diagnosticHandles: ["diagnostic:agent:cleanup"],
      },
    };
    const setupEntry = {
      test: { name: "alpha", category: "smoke", description: "alpha test", prompt: "alpha" },
      result: { passed: false, reason: "Error: fixture setup failed" },
      execution: {
        messages: [],
        duration: 12,
        error: "fixture setup failed",
        failure: setupFailure,
      },
    };
    const primaryEntry = {
      test: {
        name: "alphabet",
        category: "filesystem",
        description: "alphabet test",
        prompt: "alphabet",
      },
      result: { passed: false, reason: "Error: agent turn failed" },
      execution: {
        messages: [],
        duration: 13,
        error: "agent turn failed",
        failure: primaryFailure,
        cleanupErrors: ["close: session close failed"],
        cleanupFailures: [cleanupFailure],
      },
    };
    const record: SystemTestRunRecord = {
      schemaVersion: 1,
      runId: "st_structured_failure",
      status: "completed",
      startedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
      config: {
        contextId: "ctx-1",
        names: ["alpha", "alphabet"],
        all: false,
        modelPolicy: mocks.modelPolicySnapshot(),
        concurrency: 1,
      },
      provenance: {},
      summary: {
        runId: "st_structured_failure",
        status: "completed",
        total: 2,
        passed: 0,
        failed: 0,
        errored: 2,
        toolFailureCount: 0,
        testsWithToolFailures: 0,
        skipped: 0,
        durationMs: 25,
        failedTests: ["alpha", "alphabet"],
        testsWithUnexpectedToolFailures: [],
      },
      suite: {
        total: 2,
        passed: 0,
        failed: 0,
        errored: 2,
        skipped: 0,
        duration: 25,
        results: [setupEntry, primaryEntry],
      },
    };

    expect(inspectSystemTestRun(record)).toMatchObject({
      diagnostics: {
        failures: [
          { failure: setupFailure },
          { failure: primaryFailure, cleanupFailures: [cleanupFailure] },
        ],
      },
    });
    expect(systemTestTrajectory(record, "alpha")).toMatchObject({ failure: setupFailure });
    expect(systemTestTrajectory(record, "alphabet")).toMatchObject({
      failure: primaryFailure,
      cleanupFailures: [cleanupFailure],
    });
    expect(systemTestTrajectory(record, "alpha", { full: true })).toMatchObject({
      execution: { failure: setupFailure },
    });
    expect(systemTestTrajectory(record, "alphabet", { full: true })).toMatchObject({
      execution: { failure: primaryFailure, cleanupFailures: [cleanupFailure] },
    });
    const inspection = JSON.stringify(inspectSystemTestRun(record));
    expect(inspection).toContain("diagnostic:vcs:inspectable");
    expect(inspection).toContain("diagnostic:agent:primary");
    expect(inspection).toContain("diagnostic:agent:cleanup");
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
      fallbackModel: null,
      fallbackThinkingLevel: null,
      fallbackOn: null,
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

  it("waits for the runner-owned cleanup before returning a cancellation record", async () => {
    let resolveSuite!: (value: unknown) => void;
    mocks.runSuite.mockImplementation(() => new Promise((resolve) => (resolveSuite = resolve)));
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

    let cleanupSettled = false;
    const cleaning = cleanup!().then((record) => {
      cleanupSettled = true;
      return record;
    });
    await Promise.resolve();
    expect(mocks.cancelTestRunner).toHaveBeenCalledOnce();
    expect(cleanupSettled).toBe(false);

    resolveSuite({
      total: 1,
      passed: 0,
      failed: 0,
      errored: 1,
      skipped: 0,
      duration: 5,
      results: [
        {
          test: { name: "alpha", category: "smoke", description: "alpha test", prompt: "alpha" },
          result: { passed: false, reason: "System-test run cancelled" },
          execution: {
            messages: [],
            duration: 5,
            error: "System-test run cancelled",
            provenance: { channelId: "headless-alpha" },
            toolFailures: [{ name: "eval", error: "boom", source: "snapshot" }],
          },
        },
      ],
    });

    const record = await cleaning;
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
    await expect(running).resolves.toEqual(record);
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
