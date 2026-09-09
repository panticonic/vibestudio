import { describe, expect, it } from "vitest";
import {
  FRESH_REMOTE_STARTUP_CONNECTION_PHASES,
  startupConnectionProgress,
} from "../startupConnectionProgress.js";
import { createStartupProgressDeadline } from "./startupProgressDeadline.js";

const starting = (phase: Parameters<typeof startupConnectionProgress>[1]) => ({
  mode: "starting",
  startupProgress: startupConnectionProgress(FRESH_REMOTE_STARTUP_CONNECTION_PHASES, phase),
});

describe("startup progress deadline", () => {
  it("fails a host that reports the same state past the budget", () => {
    const deadline = createStartupProgressDeadline(180_000);
    deadline.restart(0);

    // The first report is news; the budget runs from there.
    deadline.note(starting("resolve-workspace"), 2_000);
    for (let now = 4_000; now < 182_000; now += 2_000) {
      deadline.note(starting("resolve-workspace"), now);
      expect(deadline.stalled(now)).toBe(false);
    }

    deadline.note(starting("resolve-workspace"), 182_000);
    expect(deadline.stalled(182_000)).toBe(true);
  });

  it("lets a slow but advancing startup run past the budget", () => {
    const deadline = createStartupProgressDeadline(180_000);
    deadline.restart(0);

    // A cold first run: each phase alone takes longer than the whole budget
    // used to allow, but the host keeps reporting news.
    deadline.note(starting("redeem-pairing-link"), 150_000);
    expect(deadline.stalled(150_000)).toBe(false);
    deadline.note(starting("resolve-workspace"), 320_000);
    expect(deadline.stalled(320_000)).toBe(false);
    deadline.note(starting("connect-workspace"), 480_000);
    expect(deadline.stalled(480_000)).toBe(false);

    // Total elapsed is far past the budget, and that alone must not fail it.
    expect(deadline.stalled(600_000)).toBe(false);
    expect(deadline.stalled(660_001)).toBe(true);
  });

  it("does not treat an unchanged repeat as an advance", () => {
    const deadline = createStartupProgressDeadline(10_000);
    deadline.restart(0);
    deadline.note(starting("resolve-workspace"), 1_000);
    deadline.note(starting("resolve-workspace"), 9_000);

    expect(deadline.stalled(11_000)).toBe(true);
  });

  it("counts a mode change as progress even without a phase change", () => {
    const deadline = createStartupProgressDeadline(10_000);
    deadline.restart(0);
    deadline.note(starting("resolve-workspace"), 1_000);
    deadline.note({ ...starting("resolve-workspace"), mode: "connected" }, 9_000);

    expect(deadline.stalled(11_000)).toBe(false);
  });

  it("restartIfIdle starts an unstarted budget but never extends a running one", () => {
    const deadline = createStartupProgressDeadline(10_000);
    deadline.restartIfIdle(5_000);
    expect(deadline.stalled(14_000)).toBe(false);

    deadline.restartIfIdle(14_000);
    expect(deadline.stalled(15_000)).toBe(true);
  });
});
