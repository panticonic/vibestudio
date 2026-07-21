import { afterEach, describe, expect, it } from "vitest";
import {
  clearMainProcessErrors,
  readMainProcessErrors,
  recordMainProcessError,
} from "./mainProcessErrorLedger.js";

describe("main-process error ledger", () => {
  const originalTestMode = process.env["VIBESTUDIO_TEST_MODE"];

  afterEach(() => {
    clearMainProcessErrors();
    if (originalTestMode === undefined) delete process.env["VIBESTUDIO_TEST_MODE"];
    else process.env["VIBESTUDIO_TEST_MODE"] = originalTestMode;
  });

  it("captures failures only in test mode and returns defensive snapshots", () => {
    delete process.env["VIBESTUDIO_TEST_MODE"];
    recordMainProcessError("unhandledRejection", new Error("ignored"));
    expect(readMainProcessErrors()).toEqual([]);

    process.env["VIBESTUDIO_TEST_MODE"] = "1";
    recordMainProcessError("unhandledRejection", new Error("navigation failed"));
    const first = readMainProcessErrors();
    expect(first).toEqual([
      expect.objectContaining({ kind: "unhandledRejection", message: "navigation failed" }),
    ]);

    first[0]!.message = "mutated";
    expect(readMainProcessErrors()[0]?.message).toBe("navigation failed");
  });
});
