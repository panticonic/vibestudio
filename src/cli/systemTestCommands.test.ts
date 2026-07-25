import { describe, expect, it } from "vitest";
import { systemTestJsonPageExpression, systemTestRunCode } from "./systemTestCommands.js";

describe("system-test durable driver lifecycle", () => {
  it("uses short start/status/result RPCs and keeps the driver alive through cancellation cleanup", () => {
    const code = systemTestRunCode("st_test", {
      names: ["probe"],
      all: false,
      concurrency: 1,
    });

    expect(code).toContain('"startSystemTestRun"');
    expect(code).toContain('"getSystemTestRunSnapshot"');
    expect(code).toContain('"getSystemTestRunResult"');
    expect(code).not.toContain('"runSystemTests"');
    expect(code).toContain("let cancellationCleanup = null");
    expect(code).toContain("cancellationCleanup = cleanup");
    expect(code).toContain("if (cancellationCleanup)");
    expect(code).toContain("await releaseDriverResources()");
    expect(code).toContain('"releaseSystemTestRunResult"');
    expect(code.indexOf("cancellationCleanup = cleanup")).toBeLessThan(
      code.lastIndexOf("if (cancellationCleanup)")
    );
    expect(code.indexOf("if (cancellationCleanup)")).toBeLessThan(
      code.lastIndexOf("await releaseDriverResources()")
    );
  });
});

describe("system-test persisted diagnostic paging", () => {
  it("caches a deterministic reconstruction instead of the shared large-return spill", () => {
    const code = systemTestJsonPageExpression(
      "inspectSystemTestRun(record, {})",
      0,
      1024,
      "__page"
    );

    expect(code).toContain("inspectSystemTestRun(record, {})");
    expect(code).toContain("scope[pageKey] = JSON.stringify(value, null, 2)");
    expect(code).not.toContain("$lastLargeReturn");
    expect(code).toContain("source.slice(0, 1024)");
  });
});
