import { describe, expect, it } from "vitest";
import { createLaunchProgress, formatElapsed } from "./launchProgress.js";

describe("launch progress", () => {
  it("reports each step with its own facts and measured duration", () => {
    const lines: string[] = [];
    let clock = 0;
    const progress = createLaunchProgress({
      write: (line) => lines.push(line),
      total: 3,
      now: () => clock,
    });
    const build = progress.step("Building Vibestudio");
    clock = 5_600;
    build.done();
    const templates = progress.step("Preparing workspace templates");
    templates.note("base prepared (1/3)");
    clock = 8_000;
    templates.fail();
    expect(lines).toEqual([
      "[1/3] Building Vibestudio…",
      "      done after 5.6s",
      "[2/3] Preparing workspace templates…",
      "      base prepared (1/3)",
      "      failed after 2.4s",
    ]);
  });

  it("ends an open step when the next begins, once", () => {
    const lines: string[] = [];
    let clock = 0;
    const progress = createLaunchProgress({ write: (line) => lines.push(line), now: () => clock });
    const first = progress.step("Starting the server");
    clock = 1_000;
    progress.step("Pairing this terminal");
    first.done();
    first.note("ignored after the step ended");
    expect(lines).toEqual(["Starting the server…", "  done after 1.0s", "Pairing this terminal…"]);
  });

  it("formats durations a person can read", () => {
    expect(formatElapsed(1_000)).toBe("1.0s");
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 5s");
  });
});
