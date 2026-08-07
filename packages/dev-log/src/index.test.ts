import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevLogger } from "./index.js";

describe("dev-log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps verbose diagnostics on console.debug for structured host capture", () => {
    vi.stubEnv("VIBESTUDIO_LOG_LEVEL", "verbose");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createDevLogger("Test");

    log.trace("trace");
    log.verbose("verbose");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("[Test] verbose");
    expect(log.isTrace()).toBe(false);
  });

  it("enables per-event traces only at the trace level", () => {
    vi.stubEnv("VIBESTUDIO_LOG_LEVEL", "trace");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createDevLogger("Test");

    log.trace("trace");
    log.verbose("verbose");

    expect(debug).toHaveBeenCalledTimes(2);
    expect(log.isTrace()).toBe(true);
  });
});
