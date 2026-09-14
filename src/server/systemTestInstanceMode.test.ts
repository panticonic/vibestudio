import { describe, expect, it } from "vitest";
import { SYSTEM_TEST_INSTANCE_ENV, readSystemTestInstanceMode } from "./systemTestInstanceMode.js";

describe("system-test instance mode", () => {
  it("is off unless the process was started for tests", () => {
    expect(readSystemTestInstanceMode({})).toBe(false);
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "" })).toBe(false);
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "0" })).toBe(false);
    // Nothing truthy-but-vague: an ambiguous value is not a test server.
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "true" })).toBe(false);
  });

  it("is on for a server started to run system tests", () => {
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "1" })).toBe(true);
  });
});
