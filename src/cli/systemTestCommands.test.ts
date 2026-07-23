import { describe, expect, it } from "vitest";
import { systemTestRunCode } from "./systemTestCommands.js";

describe("system-test durable driver lifecycle", () => {
  it("keeps the driver alive until nested cancellation cleanup settles", () => {
    const code = systemTestRunCode("st_test", {
      names: ["probe"],
      all: false,
      concurrency: 1,
    });

    expect(code).toContain("let cancellationCleanup = null");
    expect(code).toContain("cancellationCleanup = cleanup");
    expect(code).toContain("if (cancellationCleanup) await cancellationCleanup");
    expect(code.indexOf("cancellationCleanup = cleanup")).toBeLessThan(
      code.lastIndexOf("if (cancellationCleanup) await cancellationCleanup")
    );
  });
});
