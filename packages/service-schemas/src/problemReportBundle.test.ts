import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProblemReportBundleSchema, ReportProblemSchema, reportDigest } from "./problemReportBundle";

describe("problem report authoring diagnostics", () => {
  it("hashes exact report bytes without requiring native WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      for (const text of ["", "abc", "Report: € — 🦊"]) {
        const expected = createHash("sha256").update(text).digest("hex");
        await expect(reportDigest(text)).resolves.toBe(expected);
        await expect(reportDigest(new TextEncoder().encode(text))).resolves.toBe(expected);
      }
      await expect(reportDigest(new Uint8Array([255, 97, 98, 99, 255]).subarray(1, 4))).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("explains product tokens rather than reporting an unexplained regex refusal", () => {
    const problem = {
      category: "runtime",
      component: "host",
      operation: "eval-image artifact storage",
      code: null,
      kind: "internal",
      frames: [],
      externalFramesOmitted: 0,
    };
    const invalid = ReportProblemSchema.safeParse(problem);
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues[0]?.message).toContain(
        "put human-readable prose in symptom or expected"
      );
    expect(
      ReportProblemSchema.safeParse({ ...problem, operation: "eval.returnImage" }).success
    ).toBe(true);
    expect(ReportProblemSchema.safeParse({ ...problem, operation: null }).success).toBe(true);
  });
  it("distinguishes report reference identity from its source coordinate", () => {
    const schema = ProblemReportBundleSchema.innerType().shape.references;
    const reference = { id: "panel:task-board", kind: "panel", coordinate: "panel:task-board" };
    const invalid = schema.safeParse([reference]);
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues[0]?.message).toContain("target identifier in coordinate");
    expect(
      schema.safeParse([{ ...reference, id: "73e149a3-a04c-427f-a1bb-e597b875bf3a" }]).success
    ).toBe(true);
  });
});
