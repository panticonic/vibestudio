import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { EVAL_RESULT_RETURN_PREVIEW_CHARS } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";

type Reach = {
  compactReturnValue(value: unknown, scopeKey: string): unknown;
  materializeResultArtifact(
    runId: string,
    result: { success: boolean; console: string; returnValue: unknown }
  ): Promise<{ returnValue?: unknown }>;
  infrastructureExecution(): unknown;
  compactRunResult(result: {
    success: boolean;
    console: string;
    error?: string;
    returnValue?: unknown;
    operationJournal: import("@vibestudio/service-schemas/eval").EvalOperationJournal;
  }): { operationJournal?: unknown };
};
const reach = (instance: EvalDO): Reach => instance as unknown as Reach;

describe("eval return budget", () => {
  it("keeps operation evidence when independently compacting large guest output", async () => {
    const { instance } = await createTestDO(EvalDO);
    const operationJournal = {
      protocol: "workspace-operations.v1" as const,
      entries: [
        {
          type: "interaction",
          receipt: { protocol: "cdp-interaction-outcome.v1", effect: { status: "observed" } },
        },
      ],
      truncated: false,
    };
    const result = reach(instance).compactRunResult({
      success: false,
      console: "x".repeat(400_000),
      error: "later failure",
      returnValue: { projected: true },
      operationJournal,
    });
    expect(result.operationJournal).toEqual(operationJournal);
  });
  it("returns a small value untouched", async () => {
    const { instance } = await createTestDO(EvalDO);
    const value = { ok: true };
    expect(reach(instance).compactReturnValue(value, "$lastLargeReturn")).toBe(value);
  });

  it("reports the budget alongside the overage so a retry can be sized", async () => {
    const { instance } = await createTestDO(EvalDO);
    // A projected page of records, the shape that overflows in practice.
    const wide = Array.from({ length: 400 }, (_, seq) => ({
      seq,
      level: "info",
      tag: "Startup",
      message: `record ${seq} `.padEnd(60, "x"),
    }));

    const envelope = reach(instance).compactReturnValue(wide, "$lastLargeReturn") as Record<
      string,
      unknown
    >;

    expect(envelope["truncated"]).toBe(true);
    expect(envelope["limitChars"]).toBe(EVAL_RESULT_RETURN_PREVIEW_CHARS);
    // The measure is the indented rendering, and saying so is the difference
    // between sizing a retry and guessing at it.
    expect(envelope["measuredAs"]).toBe("json-indent-2");
    expect(envelope["originalChars"]).toBeGreaterThan(EVAL_RESULT_RETURN_PREVIEW_CHARS);
    expect(envelope["scopeKey"]).toBe("$lastLargeReturn");
    expect(typeof envelope["preview"]).toBe("string");
  });
  it("stores large image bytes as an owned artifact before applying the JSON budget", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      "INSERT INTO runs(run_id, args, status, started_at) VALUES ('image', '{}', 'running', 0)"
    );
    const data = btoa("x".repeat(400_000));
    const putRetained = vi.fn(async () => ({ digest: "a".repeat(64), size: 400_000 }));
    const releaseRetention = vi.fn(async () => {});
    vi.spyOn(reach(instance), "infrastructureExecution").mockReturnValue({
      blobstore: { putRetained, releaseRetention },
    });
    const materialized = await reach(instance).materializeResultArtifact("image", {
      success: true,
      console: "",
      returnValue: { data, mimeType: "image/png", width: 1280, height: 720 },
    });
    const compact = reach(instance).compactReturnValue(
      materialized.returnValue,
      "$lastLargeReturn"
    );
    expect(compact).toEqual({
      protocol: "eval-image-artifact.v1",
      digest: "a".repeat(64),
      size: 400_000,
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
    expect(JSON.stringify(compact).length).toBeLessThan(EVAL_RESULT_RETURN_PREVIEW_CHARS);
    expect(putRetained).toHaveBeenCalledWith({ base64: data, owner: "eval-result:image" });
    await instance.dispose();
    expect(releaseRetention).toHaveBeenCalledWith({ owner: "eval-result:image" });
    expect(sql.exec("SELECT owner FROM run_result_artifacts").toArray()).toEqual([]);
  });

  it("materializes nested images without truncating sibling verification evidence", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      "INSERT INTO runs(run_id, args, status, started_at) VALUES ('nested', '{}', 'running', 0)"
    );
    const putRetained = vi.fn(async () => ({ digest: "c".repeat(64), size: 400_000 }));
    const releaseRetention = vi.fn(async () => {});
    vi.spyOn(reach(instance), "infrastructureExecution").mockReturnValue({
      blobstore: { putRetained, releaseRetention },
    });
    const image = { data: btoa("x".repeat(400_000)), mimeType: "image/png" };
    const input = { checks: { passed: true }, screenshots: [image, image] };
    const materialized = await reach(instance).materializeResultArtifact("nested", {
      success: true,
      console: "",
      returnValue: input,
    });
    const compact = reach(instance).compactReturnValue(
      materialized.returnValue,
      "$lastLargeReturn"
    );
    expect(compact).toMatchObject({
      checks: { passed: true },
      screenshots: [{ protocol: "eval-image-artifact.v1" }, { protocol: "eval-image-artifact.v1" }],
    });
    expect(JSON.stringify(compact)).not.toContain(image.data);
    expect(putRetained).toHaveBeenCalledTimes(1);
    expect(input.screenshots[0]).toBe(image);
    await instance.dispose();
    expect(releaseRetention).toHaveBeenCalledWith({ owner: "eval-result:nested" });
  });

  it("joins a pending artifact write before releasing its ownership during disposal", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      "INSERT INTO runs(run_id, args, status, started_at) VALUES ('pending-image', '{}', 'running', 0)"
    );
    let finish!: (value: { digest: string; size: number }) => void;
    const pending = new Promise<{ digest: string; size: number }>((resolve) => {
      finish = resolve;
    });
    const releaseRetention = vi.fn(async () => {});
    vi.spyOn(reach(instance), "infrastructureExecution").mockReturnValue({
      blobstore: { putRetained: () => pending, releaseRetention },
    });
    const image = reach(instance).materializeResultArtifact("pending-image", {
      success: true,
      console: "",
      returnValue: {
        checks: { passed: true },
        screenshot: { data: "eA==", mimeType: "image/png" },
      },
    });
    let disposed = false;
    const disposal = instance.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() =>
      expect(sql.exec("SELECT status FROM runs").toArray()[0]?.["status"]).toBe("cancelled")
    );
    expect(disposed).toBe(false);
    expect(releaseRetention).not.toHaveBeenCalled();
    finish({ digest: "b".repeat(64), size: 1 });
    await image;
    await disposal;
    expect(releaseRetention).toHaveBeenCalledWith({ owner: "eval-result:pending-image" });
  });

  it("retains ownership of a failed nested upload until disposal", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      "INSERT INTO runs(run_id, args, status, started_at) VALUES ('failed-image', '{}', 'running', 0)"
    );
    const releaseRetention = vi.fn(async () => {});
    vi.spyOn(reach(instance), "infrastructureExecution").mockReturnValue({
      blobstore: {
        putRetained: async () => {
          throw new Error("upload interrupted");
        },
        releaseRetention,
      },
    });
    await expect(
      reach(instance).materializeResultArtifact("failed-image", {
        success: true,
        console: "",
        returnValue: { screenshot: { data: "eA==", mimeType: "image/png" } },
      })
    ).rejects.toThrow("upload interrupted");
    expect(sql.exec("SELECT owner FROM run_result_artifacts").toArray()).toEqual([
      { owner: "eval-result:failed-image" },
    ]);
    await instance.dispose();
    expect(releaseRetention).toHaveBeenCalledWith({ owner: "eval-result:failed-image" });
  });

  it("does not allocate an artifact after its run was cancelled", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      "INSERT INTO runs(run_id, args, status, started_at) VALUES ('cancelled-image', '{}', 'cancelled', 0)"
    );
    const putRetained = vi.fn();
    vi.spyOn(reach(instance), "infrastructureExecution").mockReturnValue({
      blobstore: { putRetained },
    });
    const result = {
      success: true,
      console: "",
      returnValue: { data: "eA==", mimeType: "image/png" },
    };
    expect(await reach(instance).materializeResultArtifact("cancelled-image", result)).toBe(result);
    expect(putRetained).not.toHaveBeenCalled();
  });
});
