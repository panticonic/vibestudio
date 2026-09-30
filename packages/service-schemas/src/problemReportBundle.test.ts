import { describe, expect, it } from "vitest";
import { ProblemReportBundleSchema, ReportProblemSchema } from "./problemReportBundle";

describe("problem report authoring diagnostics", () => {
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
