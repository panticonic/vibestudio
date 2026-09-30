import { describe, expect, it } from "vitest";
import { buildDiagnosticSchema } from "./build.js";

describe("build compiler diagnostic identity", () => {
  const diagnostic = {
    source: "tsc",
    severity: "error",
    file: "panels/example/index.tsx",
    line: 3,
    column: 4,
    message: "Object is possibly 'undefined'.",
    compilerCode: 2532,
  };

  it("preserves the original compiler code through the strict wire boundary", () => {
    expect(buildDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  it("rejects a prose substitute for a compiler identity", () => {
    expect(buildDiagnosticSchema.safeParse({ ...diagnostic, compilerCode: "TS2532" }).success).toBe(
      false
    );
  });
});
