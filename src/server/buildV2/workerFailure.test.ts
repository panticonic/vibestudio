import { describe, expect, it } from "vitest";
import { BuildDiagnosticsError } from "./diagnostics.js";
import { deserializeBuildWorkerFailure, serializeBuildWorkerFailure } from "./workerFailure.js";

describe("build worker failure transport", () => {
  it("preserves aggregate/cause identity and BuildDiagnosticsError diagnostics", () => {
    const diagnostics = new BuildDiagnosticsError("invalid source", [
      {
        source: "schema",
        severity: "error",
        file: "provider.ts",
        line: 4,
        column: 2,
        message: "invalid declaration",
      },
    ]);
    const aggregate = new AggregateError([diagnostics], "build failed", {
      cause: diagnostics,
    });

    // Worker messages cross structured-clone; JSON also makes the graph and
    // its reference nodes explicit in this focused boundary test.
    const wire = JSON.parse(JSON.stringify(serializeBuildWorkerFailure(aggregate)));
    const restored = deserializeBuildWorkerFailure(wire);

    expect(restored).toBeInstanceOf(AggregateError);
    const restoredAggregate = restored as AggregateError;
    expect(restoredAggregate.cause).toBe(restoredAggregate.errors[0]);
    expect(restoredAggregate.errors[0]).toBeInstanceOf(BuildDiagnosticsError);
    expect((restoredAggregate.errors[0] as BuildDiagnosticsError).diagnostics).toEqual(
      diagnostics.diagnostics
    );
  });
});
