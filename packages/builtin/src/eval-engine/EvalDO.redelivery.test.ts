import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDO, successfulTestRpcFetch } from "@vibestudio/durable/test-utils";
import { EvalDO } from "./EvalDO.js";

type Fixture = Awaited<ReturnType<typeof createTestDO<EvalDO>>>;
const receiver = "do:workers/test:Agent:owner";
const result = { success: true, console: "domain truth", returnValue: 42 };

function seed(f: Fixture, id: string, status = "done") {
  f.sql.exec(
    "INSERT INTO runs (run_id, args, status, result, started_at) VALUES (?, ?, ?, ?, 1)",
    id,
    JSON.stringify({
      code: "return 42",
      runDigest: "a".repeat(64),
      scopeInputRevision: "scope:initial",
      resultReceiverRef: receiver,
      executionSessionNonce: `session:${id}`,
    }),
    status,
    status === "done" ? JSON.stringify(result) : null
  );
}
function deadlines(f: Fixture) {
  return f.sql
    .exec("SELECT run_id, attempt, wake_at FROM eval_result_redeliveries ORDER BY wake_at, run_id")
    .toArray();
}
function installRpc(f: Fixture, receive: (id: string) => Promise<unknown>) {
  const call = vi.fn(async (_target: string, method: string, args: unknown[]) => {
    if (method === "onEvalComplete") return receive((args[0] as { runId: string }).runId);
    return undefined;
  });
  Object.defineProperty(f.instance, "rpc", { value: { call }, configurable: true });
  return call;
}
async function reopen(f: Fixture) {
  // Production schema admission performs activation reconstruction before RPC.
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(successfulTestRpcFetch);
  try {
    return await createTestDO(EvalDO, {}, { db: f.db });
  } finally {
    fetch.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());
describe("EvalDO durable exact-ack redelivery", () => {
  it("rolls domain admission back if its delivery index cannot commit", async () => {
    const f = await createTestDO(EvalDO);
    const execute = vi.fn(async () => result);
    Object.defineProperty(f.instance, "runLocked", { value: execute });
    installRpc(f, async () => undefined);
    f.sql.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON eval_result_redeliveries BEGIN SELECT RAISE(ABORT, 'delivery commit failed'); END"
    );
    const input = {
      runId: "admission-fault",
      code: "return 42",
      resultReceiverRef: receiver,
      executionSessionNonce: "session:admission",
    };
    await expect(f.instance.startRun(input)).rejects.toThrow("delivery commit failed");
    expect(f.sql.exec("SELECT * FROM runs").toArray()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    f.sql.exec("DROP TRIGGER fail_delivery");
    await f.instance.startRun(input);
    await vi.waitFor(() => expect(f.instance.getRunReceipt(input.runId)).not.toBeNull());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deadlines(f)).toHaveLength(1);
  });
  it("repairs a missing delivery index from terminal admissions after activation", async () => {
    const f = await createTestDO(EvalDO);
    seed(f, "retained");
    const fresh = await reopen(f);
    expect(deadlines(fresh)).toEqual([
      { run_id: "retained", attempt: 1, wake_at: expect.any(Number) },
    ]);
    installRpc(fresh, async () => undefined);
    const due = Number(deadlines(fresh)[0]!["wake_at"]);
    vi.spyOn(Date, "now").mockReturnValue(due);
    await expect(fresh.instance.alarm()).resolves.toEqual({ wakeAt: due + 10_000 });
    expect(fresh.instance.getRunReceipt("retained")?.result).toEqual(result);
    expect(fresh.instance.getRunReceipt("retained")?.acknowledged).toBe(false);
  });

  it("preserves deadlines across repeated activation and ordinary receipt reads", async () => {
    const f = await createTestDO(EvalDO);
    seed(f, "deadline");
    f.sql.exec("INSERT INTO eval_result_redeliveries VALUES ('deadline', 3, 1)");
    const fresh = await reopen(f);
    expect(deadlines(fresh)).toEqual([{ run_id: "deadline", attempt: 3, wake_at: 1 }]);
    installRpc(fresh, async () => undefined);
    await fresh.call("getRunReceipt", "deadline");
    expect(deadlines(fresh)).toEqual([{ run_id: "deadline", attempt: 3, wake_at: 1 }]);
  });

  it("never rebuilds an exactly acknowledged delivery, including quoted operation identities", async () => {
    const f = await createTestDO(EvalDO);
    const id = 'quoted"\\\n😀';
    seed(f, id);
    const receipt = f.instance.getRunReceipt(id)!;
    await f.instance.acknowledgeRunResult(id, receipt);
    const fresh = await reopen(f);
    expect(deadlines(fresh)).toEqual([]);
    expect(fresh.instance.getRunReceipt(id)).toEqual({ ...receipt, acknowledged: true });
  });

  it("does not turn a pending or cancelling admission into a result", async () => {
    const f = await createTestDO(EvalDO);
    seed(f, "pending", "pending");
    seed(f, "cleanup", "cancelling");
    const fresh = await reopen(f);
    // Interrupted cleanup is already reconciled to cancellation by the domain.
    f.sql.exec("UPDATE runs SET status = 'cancelling' WHERE run_id = 'cleanup'");
    f.sql.exec("UPDATE eval_result_redeliveries SET wake_at = 0");
    const call = installRpc(fresh, async () => undefined);
    await fresh.instance.alarm();
    expect(call.mock.calls.filter(([, method]) => method === "onEvalComplete")).toEqual([]);
    expect(fresh.instance.getRunReceipt("pending")).toBeNull();
    expect(fresh.instance.getRunReceipt("cleanup")).toBeNull();
    expect(deadlines(fresh)).toHaveLength(2);
  });

  it("redelivers a canonical cancellation whose terminal row has no payload", async () => {
    const f = await createTestDO(EvalDO);
    seed(f, "cancelled", "cancelled");
    const fresh = await reopen(f);
    fresh.sql.exec("UPDATE eval_result_redeliveries SET wake_at = 0");
    const call = installRpc(fresh, async (id) => {
      const receipt = fresh.instance.getRunReceipt(id)!;
      expect(receipt.result).toMatchObject({
        failureKind: "cancelled",
        failureCode: "eval_cancelled",
      });
      return fresh.instance.acknowledgeRunResult(id, receipt);
    });
    await expect(fresh.instance.alarm()).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith(
      receiver,
      "onEvalComplete",
      [
        expect.objectContaining({
          runId: "cancelled",
          result: expect.objectContaining({ failureKind: "cancelled" }),
        }),
      ],
      {}
    );
    expect(deadlines(fresh)).toEqual([]);
  });

  it("bounds a pass and serves older due receipts before rescheduled receipts", async () => {
    const f = await createTestDO(EvalDO);
    for (let i = 0; i < 65; i++) seed(f, `run:${String(i).padStart(3, "0")}`);
    const fresh = await reopen(f);
    fresh.sql.exec("UPDATE eval_result_redeliveries SET wake_at = 0");
    const observed: string[] = [];
    installRpc(fresh, async (id) => {
      observed.push(id);
    });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await expect(fresh.instance.alarm()).resolves.toEqual({ wakeAt: 0 });
    expect(observed).toHaveLength(64);
    await expect(fresh.instance.alarm()).resolves.toEqual({ wakeAt: now + 10_000 });
    expect(observed).toHaveLength(65);
    expect(observed.at(-1)).toBe("run:064");
    expect(deadlines(fresh)).toHaveLength(65);
  });

  it("an acknowledgement racing a failed delivery cannot reopen its slot", async () => {
    const f = await createTestDO(EvalDO);
    seed(f, "race");
    const fresh = await reopen(f);
    fresh.sql.exec("UPDATE eval_result_redeliveries SET wake_at = 0");
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    installRpc(fresh, async () => {
      started();
      await gate;
      throw new Error("lost delivery response");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const alarm = fresh.instance.alarm();
    await begun;
    const receipt = fresh.instance.getRunReceipt("race")!;
    await fresh.instance.acknowledgeRunResult("race", receipt);
    finish();
    await expect(alarm).resolves.toBeNull();
    expect(deadlines(fresh)).toEqual([]);
    const replaced = await reopen(fresh);
    expect(deadlines(replaced)).toEqual([]);
  });

  it("commits the delivery obligation before asynchronous execution starts", async () => {
    const f = await createTestDO(EvalDO);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(f.instance, "runLocked", {
      value: async () => {
        await gate;
        return result;
      },
    });
    installRpc(f, async () => undefined);
    await f.instance.startRun({
      runId: "before-execution",
      code: "return 42",
      resultReceiverRef: receiver,
      executionSessionNonce: "session:before",
    });
    expect(deadlines(f)).toEqual([
      { run_id: "before-execution", attempt: 1, wake_at: expect.any(Number) },
    ]);
    release();
    await vi.waitFor(() => expect(f.instance.getRunReceipt("before-execution")).not.toBeNull());
  });

  it("reopens current storage without changing canonical rows or acknowledgements", async () => {
    const probe = await createTestDO(EvalDO, { WORKER_CLASS_NAME: "EvalDO" });
    const fingerprint = String(
      probe.sql.exec("SELECT shape_json FROM _vibestudio_schema").one()["shape_json"]
    );
    const f = await createTestDO(EvalDO, { WORKER_CLASS_NAME: "EvalDO" });
    seed(f, "unacked");
    seed(f, "acked");
    await f.instance.acknowledgeRunResult("acked", f.instance.getRunReceipt("acked")!);
    const retained = f.sql.exec("SELECT * FROM runs ORDER BY run_id").toArray();
    const descriptor = { className: "EvalDO", version: 5, freshSchemaFingerprint: fingerprint };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(successfulTestRpcFetch);
    try {
      const reopened = await createTestDO(
        EvalDO,
        { WORKER_CLASS_NAME: "EvalDO", VIBESTUDIO_SCHEMA_DESCRIPTOR: descriptor },
        { db: f.db }
      );
      expect(reopened.sql.exec("SELECT * FROM runs ORDER BY run_id").toArray()).toEqual(retained);
      expect(deadlines(reopened)).toEqual([
        { run_id: "unacked", attempt: 1, wake_at: expect.any(Number) },
      ]);
      expect(reopened.instance.getRunReceipt("acked")?.acknowledged).toBe(true);
      expect(reopened.sql.exec("SELECT version FROM _vibestudio_schema").one()["version"]).toBe(5);
    } finally {
      fetch.mockRestore();
    }
  });

  it("refuses the preceding schema unchanged at the final pre-release cut", async () => {
    const f = await createTestDO(EvalDO, { WORKER_CLASS_NAME: "EvalDO" });
    seed(f, "retained");
    f.sql.exec("UPDATE _vibestudio_schema SET version=4");
    const before = f.sql.exec("SELECT * FROM runs").toArray();
    await expect(
      createTestDO(EvalDO, { WORKER_CLASS_NAME: "EvalDO" }, { db: f.db })
    ).rejects.toMatchObject({
      code: "DO_SCHEMA_INCOMPATIBLE",
      errorData: { reason: "version-mismatch", persistedVersion: 4, targetVersion: 5 },
    });
    expect(f.sql.exec("SELECT * FROM runs").toArray()).toEqual(before);
    expect(f.sql.exec("SELECT version FROM _vibestudio_schema").one()["version"]).toBe(4);
  });
});
