import { describe, expect, it } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { EVAL_RESULT_RETURN_PREVIEW_CHARS } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";

type Reach = { compactReturnValue(value: unknown, scopeKey: string): unknown };
const reach = (instance: EvalDO): Reach => instance as unknown as Reach;

describe("eval return budget", () => {
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
});
