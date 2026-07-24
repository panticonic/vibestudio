/**
 * Sealed authority conduit for the headless system-test harness.
 *
 * System-test source is intentionally evaluated in the normal EvalDO runtime,
 * where its portable APIs actually live. EvalDO recognizes this exact sealed
 * runner build and issues the explicit test policy for its nested runs. No
 * session, shell, or arbitrary eval can impersonate that execution identity.
 */
import { DurableObjectBase, rpc } from "@workspace/runtime/worker";
import { anyOf, methodCapability, relationship } from "@vibestudio/shared/authorization";
import { readEvalStatusWithRetry } from "./eval-status-retry.js";

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

interface EvalRunResult {
  success: boolean;
  returnValue?: unknown;
  error?: string;
}

interface EvalCancelResult {
  ok: true;
  forcedReset: boolean;
}

interface StoredSystemTestRecord {
  kind: "system-test-record-v1";
  scopeKey: string;
  length: number;
}

export interface SystemTestRunnerSnapshot {
  status: string;
  progress?: unknown;
  result?: {
    success: boolean;
    error?: string;
  };
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
    const recordScopeKey = "$systemTestRecord:" + progressKey;
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
            const serializedRecord = JSON.stringify(cancelledRecord);
            scope[recordScopeKey] = serializedRecord;
          }
        }),
      });
      const serializedRecord = JSON.stringify(record);
      scope[recordScopeKey] = serializedRecord;
      return {
        kind: "system-test-record-v1",
        scopeKey: recordScopeKey,
        length: serializedRecord.length,
      };
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
  protected createTables(): void {
    // The child EvalDO owns durable progress/result state. This conduit stays
    // stateless so an activation change cannot orphan an active run.
  }

  private async runHarnessUtility(kind: "doctor" | "list", code: string): Promise<unknown> {
    const runId = `system-test-runner:${kind}:${crypto.randomUUID()}`;
    const subKey = `system-test-${kind}`;
    const scopeKey = `$systemTestUtility:${kind}`;
    await this.rpc.call("main", "eval.startRun", [
      {
        runId,
        subKey,
        code: `
          ${code}
          const serialized = JSON.stringify(utilityValue);
          scope[${JSON.stringify(scopeKey)}] = serialized;
          return {
            kind: "system-test-record-v1",
            scopeKey: ${JSON.stringify(scopeKey)},
            length: serialized.length,
          };
        `,
        syntax: "typescript",
      },
    ]);
    for (;;) {
      const status = await this.rpc.call<EvalRunStatus>("main", "eval.getRun", [{ runId, subKey }]);
      if (status.status === "done") {
        if (!status.result?.success) {
          throw new Error(status.result?.error ?? `system-test ${kind} eval failed`);
        }
        const stored = parseStoredSystemTestRecord(status.result.returnValue);
        try {
          return await this.readStoredSystemTestRecord(subKey, stored);
        } finally {
          await this.rpc.call("main", "eval.deleteScopeValue", [{ subKey, key: stored.scopeKey }]);
        }
      }
      if (status.status === "cancelled" || status.status === "unknown") {
        throw new Error(`system-test ${kind} eval ended with status ${status.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async doctor(model?: string): Promise<unknown> {
    return this.runHarnessUtility(
      "doctor",
      `
        import { systemTestDoctor } from "@workspace-skills/system-testing/cli";
        const utilityValue = await systemTestDoctor(${JSON.stringify(model)});
      `
    );
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async listSystemTests(category?: string): Promise<unknown> {
    return this.runHarnessUtility(
      "list",
      `
        import { listSystemTests } from "@workspace-skills/system-testing/cli";
        const category = ${JSON.stringify(category)};
        const utilityValue = listSystemTests().filter(
          (test) => !category || test.category === category
        );
      `
    );
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async startSystemTestRun(options: SystemTestRunConfig): Promise<{ runId: string }> {
    await this.rpc.call("main", "eval.startRun", [
      {
        runId: systemTestEvalRunId(options.runId),
        subKey: options.runId,
        code: systemTestEvalCode(options),
        syntax: "typescript",
      },
    ]);
    return { runId: options.runId };
  }

  private async readStoredSystemTestRecord(
    runId: string,
    stored: StoredSystemTestRecord
  ): Promise<unknown> {
    const pageSize = 128 * 1024;
    let text = "";
    for (let offset = 0; offset < stored.length; offset += pageSize) {
      const page = await this.rpc.call<{
        length: number;
        encoding: "utf16le-base64";
        chunk: string;
      }>("main", "eval.readScopeTextPage", [
        {
          subKey: runId,
          key: stored.scopeKey,
          offset,
          limit: Math.min(pageSize, stored.length - offset),
        },
      ]);
      if (page.length !== stored.length || page.encoding !== "utf16le-base64") {
        throw new Error(`system-test record ${runId} changed while it was being read`);
      }
      text += decodeUtf16LeBase64(page.chunk);
    }
    if (text.length !== stored.length) {
      throw new Error(
        `system-test record ${runId} was truncated (${text.length}/${stored.length} UTF-16 units)`
      );
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `system-test record ${runId} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async getSystemTestRunSnapshot(runId: string): Promise<SystemTestRunnerSnapshot> {
    const status = await this.readSystemTestEvalStatus(runId);
    return {
      status: status.status,
      ...(status.progress !== undefined ? { progress: status.progress } : {}),
      ...(status.result
        ? {
            result: {
              success: status.result.success,
              ...(status.result.error ? { error: status.result.error } : {}),
            },
          }
        : {}),
    };
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async getSystemTestRunResult(runId: string): Promise<unknown> {
    const status = await this.readSystemTestEvalStatus(runId);
    if (status.status !== "done") {
      throw new Error(
        `System-test run ${runId} is ${status.status}; no terminal result is available`
      );
    }
    if (!status.result?.success) {
      throw new Error(status.result?.error ?? `System-test run ${runId} failed`);
    }
    return this.readStoredSystemTestRecord(
      runId,
      parseStoredSystemTestRecord(status.result.returnValue)
    );
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async releaseSystemTestRunResult(runId: string): Promise<{ released: boolean }> {
    const released = await this.rpc.call<{ ok: boolean; existed: boolean }>(
      "main",
      "eval.deleteScopeValue",
      [{ subKey: runId, key: systemTestRecordScopeKey(runId) }]
    );
    return { released: released.existed };
  }

  @rpc({
    requires: SYSTEM_TEST_OPERATOR,
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async cancelSystemTestRun(runId: string): Promise<unknown | null> {
    let cancellation: EvalCancelResult;
    try {
      cancellation = await this.rpc.call<EvalCancelResult>("main", "eval.cancel", [
        { runId: systemTestEvalRunId(runId), subKey: runId },
      ]);
    } catch (error) {
      throw new Error(
        `System-test run ${runId} could not settle its inner eval cancellation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    if (cancellation.forcedReset) {
      throw new Error(
        `System-test run ${runId} required a forced EvalDO scope reset after non-cooperative cancellation; ` +
          "its terminal cleanup record is unavailable. Restart from a fresh exact run."
      );
    }
    // The inner eval's registered cleanup serializes the complete terminal
    // record under the same durable key as ordinary completion. Read only its
    // envelope through eval's bounded return, then retrieve the record by page.
    let recovered: EvalRunResult;
    try {
      recovered = await this.rpc.call<EvalRunResult>("main", "eval.run", [
        {
          subKey: runId,
          syntax: "javascript",
          code: `
          const scopeKey = ${JSON.stringify(systemTestRecordScopeKey(runId))};
          const serialized = scope[scopeKey];
          return typeof serialized === "string"
            ? { kind: "system-test-record-v1", scopeKey, length: serialized.length }
            : null;
        `,
        },
      ]);
    } catch (error) {
      throw new Error(
        `System-test run ${runId} settled, but its terminal cleanup record could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    if (!recovered.success) {
      throw new Error(
        `System-test run ${runId} cleanup record could not be recovered: ${recovered.error ?? "eval failed"}`
      );
    }
    if (recovered.returnValue == null) return null;
    return this.readStoredSystemTestRecord(
      runId,
      parseStoredSystemTestRecord(recovered.returnValue)
    );
  }

  private readSystemTestEvalStatus(runId: string): Promise<EvalRunStatus> {
    return readEvalStatusWithRetry(() =>
      this.rpc.call<EvalRunStatus>("main", "eval.getRun", [
        { runId: systemTestEvalRunId(runId), subKey: runId },
      ])
    );
  }
}

function systemTestEvalRunId(runId: string): string {
  return `system-test-runner:${runId}`;
}

function systemTestRecordScopeKey(runId: string): string {
  return `$systemTestRecord:${runId}`;
}

function parseStoredSystemTestRecord(value: unknown): StoredSystemTestRecord {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>)["kind"] !== "system-test-record-v1" ||
    typeof (value as Record<string, unknown>)["scopeKey"] !== "string" ||
    !Number.isInteger((value as Record<string, unknown>)["length"]) ||
    Number((value as Record<string, unknown>)["length"]) < 0
  ) {
    throw new Error("system-test eval completed without a stored record envelope");
  }
  return value as StoredSystemTestRecord;
}

function decodeUtf16LeBase64(value: string): string {
  const binary = atob(value);
  if (binary.length % 2 !== 0) throw new Error("invalid UTF-16LE scope page");
  let result = "";
  const chunkSize = 16_384;
  for (let offset = 0; offset < binary.length; offset += chunkSize * 2) {
    const end = Math.min(binary.length, offset + chunkSize * 2);
    const units = new Uint16Array((end - offset) / 2);
    for (let index = offset; index < end; index += 2) {
      units[(index - offset) / 2] = binary.charCodeAt(index) | (binary.charCodeAt(index + 1) << 8);
    }
    result += String.fromCharCode(...units);
  }
  return result;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("System-test runner Durable Object.", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
