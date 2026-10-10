import { describe, expect, it, vi } from "vitest";
import { createTestDO, successfulTestRpcFetch } from "@vibestudio/durable/test-utils";
import { evalResultReceiptSchema } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";

async function completedRun() {
  const fixture = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
  const execute = vi.fn(async () => ({ success: true, console: "actual output", returnValue: 42 }));
  Object.defineProperty(fixture.instance, "runLocked", { value: execute });
  await fixture.instance.startRun({
    runId: "receipt-run",
    code: "return 42",
    intentDigest: "a".repeat(64),
  });
  await vi.waitFor(() => expect(fixture.instance.getRunReceipt("receipt-run")).not.toBeNull());
  return { ...fixture, execute };
}

describe("EvalDO canonical result receipts", () => {
  it("rolls back never-admitted cancellation when its canonical event cannot commit", async () => {
    const { instance, sql } = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
    sql.exec(`CREATE TRIGGER reject_cancel_event BEFORE INSERT ON run_events
      WHEN NEW.run_id = 'cancel-rollback'
      BEGIN SELECT RAISE(ABORT, 'original cancellation event failure'); END`);
    await expect(instance.cancel("cancel-rollback")).rejects.toThrow(
      "original cancellation event failure"
    );
    expect(instance.getRunReceipt("cancel-rollback")).toBeNull();
    expect(instance.getRun("cancel-rollback")).toEqual({ status: "unknown" });
    sql.exec("DROP TRIGGER reject_cancel_event");
    await expect(instance.cancel("cancel-rollback")).resolves.toEqual({
      ok: true,
      forcedReset: false,
    });
    expect(instance.getRunReceipt("cancel-rollback")).not.toBeNull();
  });

  it("atomically cancels an identity before admission and fences late start/reset across reopen", async () => {
    const fixture = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
    await expect(fixture.instance.cancel("never-admitted")).resolves.toEqual({
      ok: true,
      forcedReset: false,
    });
    const receipt = evalResultReceiptSchema.parse(fixture.instance.getRunReceipt("never-admitted"));
    expect(receipt.result).toMatchObject({
      success: false,
      failureKind: "cancelled",
      error: { message: "eval: run cancelled before admission", errorKind: "application" },
    });
    expect(fixture.instance.getRun("never-admitted")).toMatchObject({
      status: "cancelled",
      result: receipt.result,
    });
    const args = JSON.parse(
      String(
        fixture.sql.exec("SELECT args FROM runs WHERE run_id = ?", receipt.runId).one()["args"]
      )
    );
    expect(args).toEqual({ runId: receipt.runId, runDigest: receipt.runDigest });
    const { instance: reopened } = await createTestDO(
      EvalDO,
      { RPC_FETCH: successfulTestRpcFetch },
      { db: fixture.db }
    );
    const execute = vi.fn(async () => ({ success: true, console: "wrongly executed" }));
    const reset = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(reopened, "runLocked", { value: execute });
    Object.defineProperty(reopened, "forceReset", { value: reset });
    await expect(
      reopened.startRun({ runId: receipt.runId, code: "return 99", reset: true })
    ).resolves.toEqual({
      runId: receipt.runId,
      runDigest: receipt.runDigest,
      status: "cancelled",
      existing: true,
    });
    await expect(reopened.cancel(receipt.runId)).resolves.toEqual({ ok: true, forcedReset: false });
    expect(reopened.getRunReceipt(receipt.runId)).toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    await reopened.acknowledgeRunResult(receipt.runId, receipt);
    expect(reopened.getRunReceipt(receipt.runId)?.acknowledged).toBe(true);
  });

  it("lets canonical cancellation win while the original resetting admission has yielded", async () => {
    const { instance } = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
    let finishReset!: () => void;
    const reset = new Promise<{ ok: boolean }>((resolve) => {
      finishReset = () => resolve({ ok: true });
    });
    const execute = vi.fn(async () => ({ success: true, console: "must not execute" }));
    Object.defineProperty(instance, "runLocked", { value: execute });
    Object.defineProperty(instance, "forceReset", { value: () => reset });
    const admission = instance.startRun({ runId: "reset-race", code: "return 99", reset: true });
    await instance.cancel("reset-race");
    const receipt = instance.getRunReceipt("reset-race")!;
    finishReset();
    await expect(admission).resolves.toMatchObject({
      status: "cancelled",
      existing: true,
      runDigest: receipt.runDigest,
    });
    expect(instance.getRunReceipt("reset-race")).toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not pretend a never-admitted cancellation changed notebook input for the next run", async () => {
    const { instance } = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
    Object.defineProperty(instance, "runLocked", {
      value: async () => ({ success: true, console: "" }),
    });
    await instance.cancel("never-started");
    const accepted = await instance.startRun({
      runId: "actual-first-run",
      code: "return 1",
      intentDigest: "a".repeat(64),
    });
    expect(accepted.scopeInputRevision).toBe("scope:initial");
    await vi.waitFor(() => expect(instance.getRunReceipt(accepted.runId)).not.toBeNull());
    const receipt = instance.getRunReceipt(accepted.runId);
    await instance.cancel(accepted.runId);
    expect(instance.getRunReceipt(accepted.runId)).toEqual(receipt);
  });

  it("exposes only actual terminal domain results and retains exact acknowledgement across activation", async () => {
    const { instance, db, execute } = await completedRun();
    expect(instance.getRunReceipt("absent")).toBeNull();
    const receipt = evalResultReceiptSchema.parse(instance.getRunReceipt("receipt-run"));
    expect(receipt).toMatchObject({
      result: { success: true, returnValue: 42 },
      acknowledged: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(instance.acknowledgeRunResult(receipt.runId, receipt)).resolves.toEqual({
      acknowledged: true,
      duplicate: false,
    });
    const { instance: reopened } = await createTestDO(
      EvalDO,
      { RPC_FETCH: successfulTestRpcFetch },
      { db }
    );
    expect(reopened.getRunReceipt(receipt.runId)).toEqual({ ...receipt, acknowledged: true });
    await expect(reopened.acknowledgeRunResult(receipt.runId, receipt)).resolves.toEqual({
      acknowledged: true,
      duplicate: true,
    });
    await reopened.startRun({
      runId: "receipt-run",
      code: "return 42",
      intentDigest: "a".repeat(64),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown, pending, wrong-admission and wrong-result acknowledgements without closing delivery", async () => {
    const { instance, sql } = await completedRun();
    const receipt = instance.getRunReceipt("receipt-run")!;
    sql.exec(
      "INSERT INTO eval_result_redeliveries(run_id, attempt, wake_at) VALUES (?, 1, 0)",
      receipt.runId
    );
    await expect(instance.acknowledgeRunResult("absent", receipt)).rejects.toThrow(
      "no terminal receipt"
    );
    sql.exec("UPDATE runs SET status = 'pending' WHERE run_id = ?", receipt.runId);
    expect(instance.getRunReceipt(receipt.runId)).toBeNull();
    await expect(instance.acknowledgeRunResult(receipt.runId, receipt)).rejects.toThrow(
      "no terminal receipt"
    );
    sql.exec("UPDATE runs SET status = 'done' WHERE run_id = ?", receipt.runId);
    await expect(
      instance.acknowledgeRunResult(receipt.runId, { ...receipt, runDigest: "b".repeat(64) })
    ).rejects.toThrow("does not match");
    await expect(
      instance.acknowledgeRunResult(receipt.runId, { ...receipt, resultDigest: "c".repeat(64) })
    ).rejects.toThrow("does not match");
    expect(instance.getRunReceipt(receipt.runId)?.acknowledged).toBe(false);
    expect(
      sql
        .exec("SELECT attempt FROM eval_result_redeliveries WHERE run_id = ?", receipt.runId)
        .toArray()
    ).toEqual([{ attempt: 1 }]);
  });

  it("rolls acknowledgement and delivery closure back together and accepts an exact retry", async () => {
    const { instance, sql } = await completedRun();
    const receipt = instance.getRunReceipt("receipt-run")!;
    sql.exec(
      "INSERT INTO eval_result_redeliveries(run_id, attempt, wake_at) VALUES (?, 1, 0)",
      receipt.runId
    );
    sql.exec(
      "CREATE TRIGGER refuse_ack BEFORE DELETE ON eval_result_redeliveries BEGIN SELECT RAISE(ABORT, 'fault before closure'); END"
    );
    await expect(instance.acknowledgeRunResult(receipt.runId, receipt)).rejects.toThrow(
      "fault before closure"
    );
    expect(instance.getRunReceipt(receipt.runId)?.acknowledged).toBe(false);
    sql.exec("DROP TRIGGER refuse_ack");
    await expect(instance.acknowledgeRunResult(receipt.runId, receipt)).resolves.toEqual({
      acknowledged: true,
      duplicate: false,
    });
    expect(sql.exec("SELECT * FROM eval_result_redeliveries").toArray()).toEqual([]);
    expect(instance.getRunReceipt(receipt.runId)?.result).toEqual(receipt.result);
  });

  it("detects a changed acknowledged result instead of legitimizing a conflicting replay", async () => {
    const { instance, sql } = await completedRun();
    const receipt = instance.getRunReceipt("receipt-run")!;
    await instance.acknowledgeRunResult(receipt.runId, receipt);
    sql.exec(
      "UPDATE runs SET result = ? WHERE run_id = ?",
      JSON.stringify({ success: true, console: "", returnValue: 43 }),
      receipt.runId
    );
    expect(() => instance.getRunReceipt(receipt.runId)).toThrow(
      "acknowledged result receipt-run changed"
    );
  });

  it("keeps receipt identity across terminal preparation and refuses replay after reopening", async () => {
    const { instance, db, execute } = await completedRun();
    const receipt = instance.getRunReceipt("receipt-run")!;
    await instance.acknowledgeRunResult(receipt.runId, receipt);
    await instance.releaseForLifecycle({
      epoch: "retire:receipt-owner",
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    });
    const { instance: reopened } = await createTestDO(
      EvalDO,
      { RPC_FETCH: successfulTestRpcFetch },
      { db }
    );
    expect(reopened.getRunReceipt(receipt.runId)).toEqual({ ...receipt, acknowledged: true });
    await expect(
      reopened.startRun({ runId: receipt.runId, code: "return 42", intentDigest: "a".repeat(64) })
    ).rejects.toThrow("execution namespace is retired");
    await expect(reopened.startRun({ runId: "new-run", code: "return 43" })).rejects.toThrow(
      "execution namespace is retired"
    );
    await expect(
      reopened.acquireKernelLease({ leaseId: "new-lease", idleMs: 1000 })
    ).rejects.toThrow("execution namespace is retired");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("seals admission before yielding to owned cleanup", async () => {
    const { instance, sql } = await completedRun();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(instance, "cancelRunsForLifecycle", { value: () => pending });
    const retirement = instance.releaseForLifecycle({
      epoch: "retire:pending-cleanup",
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    });
    await expect(instance.startRun({ runId: "racing-start", code: "return 99" })).rejects.toThrow(
      "execution namespace is retired"
    );
    expect(sql.exec("SELECT run_id FROM runs WHERE run_id = 'racing-start'").toArray()).toEqual([]);
    finish();
    await retirement;
  });

  it("rechecks admission after a resetting start yields to retirement", async () => {
    const { instance, sql } = await completedRun();
    let finish!: () => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      finish = () => resolve({ ok: true });
    });
    Object.defineProperty(instance, "forceReset", { value: () => pending });
    const admission = instance.startRun({ runId: "racing-reset", code: "return 99", reset: true });
    await instance.releaseForLifecycle({
      epoch: "retire:reset-gap",
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    });
    finish();
    await expect(admission).rejects.toThrow("execution namespace is retired");
    expect(sql.exec("SELECT run_id FROM runs WHERE run_id = 'racing-reset'").toArray()).toEqual([]);
  });
});
