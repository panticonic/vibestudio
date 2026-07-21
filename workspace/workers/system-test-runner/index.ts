/**
 * Sealed authority conduit for the headless system-test harness.
 *
 * System-test source is intentionally evaluated in the normal EvalDO runtime,
 * where its portable APIs actually live. This installed unit contributes only
 * an explicit, review-visible `tool-eval` delegation ceiling; the EvalDO gets
 * no authority that this exact build did not name.
 */
import { DurableObjectBase, rpc } from "@workspace/runtime/worker";
import { anyOf, methodCapability, relationship } from "@vibestudio/shared/authorization";

interface SystemTestRunConfig {
  runId: string;
  contextId: string;
  names?: string[];
  category?: string;
  all?: boolean;
  model?: string;
  concurrency?: number;
  testTimeoutMs?: number;
}

interface EvalRunStatus {
  status: string;
  progress?: unknown;
  result?: { success: boolean; returnValue?: unknown; error?: string };
}

interface ActiveSystemTestRun {
  evalRunId: string;
  progress: unknown;
}

export interface SystemTestRunnerSnapshot {
  progress: unknown;
}

const SYSTEM_TEST_OPERATOR = anyOf(
  methodCapability("host"),
  relationship("workspace-role", "root")
);

function systemTestEvalCode(options: SystemTestRunConfig): string {
  return `
    import {
      inspectSystemTestRun,
      runSystemTests,
      systemTestTrajectory,
    } from "@workspace-skills/system-testing/cli";
    const options = ${JSON.stringify(options)};
    const progressKey = options.runId;
    const durableHeartbeatLimit = 220 * 1024;
    let lastProgress = null;
    const publishProgress = (progress) => {
      let durable = { ...progress, updatedAt: new Date().toISOString() };
      if (JSON.stringify(durable).length > durableHeartbeatLimit && durable.liveInspection) {
        durable = {
          ...durable,
          liveInspection: { inspect: durable.liveInspection.inspect, trajectories: {} },
        };
      }
      if (JSON.stringify(durable).length > durableHeartbeatLimit) {
        const { liveInspection: _omitted, ...withoutInspection } = durable;
        durable = withoutInspection;
      }
      lastProgress = durable;
      ctx.reportProgress(durable);
    };
    try {
      const record = await runSystemTests({
        ...options,
        contextId: ctx.contextId,
        onProgress: publishProgress,
        onInspectionUpdate: (liveRecord) => {
          const limits = { failures: 2, messages: 4, invocations: 6, debugEvents: 6, text: 300 };
          const inspect = inspectSystemTestRun(liveRecord, { limits });
          const base = { ...(lastProgress || {}) };
          const trajectories = {};
          for (const entry of liveRecord.suite.results) {
            const name = entry.test.name;
            const candidate = {
              ...trajectories,
              [name]: { bounded: systemTestTrajectory(liveRecord, name, { limits }) },
            };
            const heartbeat = { ...base, liveInspection: { inspect, trajectories: candidate } };
            if (JSON.stringify(heartbeat).length <= durableHeartbeatLimit) {
              Object.assign(trajectories, candidate);
            }
          }
          publishProgress({ ...base, liveInspection: { inspect, trajectories } });
        },
        registerCancellationCleanup: (cleanup) => ctx.onCancel(async () => {
          const cancelledRecord = await cleanup();
          if (cancelledRecord) {
            const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
              ? scope.systemTestRuns
              : {};
            runs[progressKey] = cancelledRecord;
            scope.systemTestRuns = runs;
          }
        }),
      });
      const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
        ? scope.systemTestRuns
        : {};
      runs[progressKey] = record;
      scope.systemTestRuns = runs;
      return record;
    } catch (error) {
      const prior = lastProgress && typeof lastProgress === "object"
        ? lastProgress
        : { runId: progressKey, startedAt: new Date().toISOString(), total: 0, queued: [], running: [], completed: [] };
      publishProgress({
        ...prior,
        status: "errored",
        updatedAt: new Date().toISOString(),
        running: [],
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  `;
}

export class SystemTestRunnerDO extends DurableObjectBase {
  private readonly runs = new Map<string, ActiveSystemTestRun>();

  protected createTables(): void {
    // The child EvalDO owns durable progress/result state. This conduit is
    // activation-local and its runtime entity is retired after every CLI run.
  }

  @rpc({ requires: SYSTEM_TEST_OPERATOR, sensitivity: "write" })
  async runSystemTests(options: SystemTestRunConfig): Promise<unknown> {
    if (this.runs.has(options.runId)) {
      throw new Error(`System-test run ${options.runId} is already active in this runner`);
    }
    const evalRunId = `system-test-runner:${options.runId}`;
    const active: ActiveSystemTestRun = { evalRunId, progress: null };
    this.runs.set(options.runId, active);
    try {
      await this.rpc.call("main", "eval.startRun", [
        {
          runId: evalRunId,
          subKey: options.runId,
          code: systemTestEvalCode(options),
          syntax: "typescript",
        },
      ]);
      for (;;) {
        const status = await this.rpc.call<EvalRunStatus>("main", "eval.getRun", [
          { runId: evalRunId, subKey: options.runId },
        ]);
        active.progress = status.progress ?? active.progress;
        if (status.status === "done") {
          if (!status.result?.success) {
            throw new Error(status.result?.error ?? "system-test eval failed");
          }
          return status.result.returnValue;
        }
        if (status.status === "cancelled" || status.status === "unknown") {
          throw new Error(`system-test eval became ${status.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } finally {
      this.runs.delete(options.runId);
    }
  }

  @rpc({ requires: SYSTEM_TEST_OPERATOR, sensitivity: "read" })
  async getSystemTestRunSnapshot(runId: string): Promise<SystemTestRunnerSnapshot | null> {
    const active = this.runs.get(runId);
    return active ? { progress: structuredClone(active.progress) } : null;
  }

  @rpc({ requires: SYSTEM_TEST_OPERATOR, sensitivity: "write" })
  async cancelSystemTestRun(runId: string): Promise<null> {
    const active = this.runs.get(runId);
    if (!active) return null;
    await this.rpc.call("main", "eval.cancel", [
      { runId: active.evalRunId, subKey: runId },
    ]);
    return null;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("System-test runner Durable Object.", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
