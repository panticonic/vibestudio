import { describe, expect, it } from "vitest";

import {
  RunController,
  isLegalRunTransition,
  isTerminalRunPhase,
  isActiveRunPhase,
  deriveRunPhase,
  expectedRunningForPhase,
} from "./run-controller.js";

describe("run-controller phase model", () => {
  it("classifies terminal vs active phases", () => {
    for (const p of ["closed", "interrupted", "failed"] as const) {
      expect(isTerminalRunPhase(p)).toBe(true);
      expect(isActiveRunPhase(p)).toBe(false);
    }
    for (const p of ["starting", "running_model", "waiting_external", "continuing"] as const) {
      expect(isActiveRunPhase(p)).toBe(true);
      expect(isTerminalRunPhase(p)).toBe(false);
    }
    expect(isActiveRunPhase("idle")).toBe(false);
    expect(isTerminalRunPhase("idle")).toBe(false);
  });

  it("derives idle when there is no durable turn", () => {
    expect(deriveRunPhase(null)).toBe("idle");
    expect(deriveRunPhase(undefined)).toBe("idle");
    expect(deriveRunPhase("waiting_external")).toBe("waiting_external");
  });

  it("expects running iff the phase is active", () => {
    expect(expectedRunningForPhase("running_model")).toBe(true);
    expect(expectedRunningForPhase("waiting_external")).toBe(true);
    expect(expectedRunningForPhase("closed")).toBe(false);
    expect(expectedRunningForPhase("idle")).toBe(false);
  });

  it("permits the real durable transitions and rejects illegal ones", () => {
    expect(isLegalRunTransition("starting", "running_model")).toBe(true);
    expect(isLegalRunTransition("running_model", "waiting_external")).toBe(true);
    expect(isLegalRunTransition("waiting_external", "continuing")).toBe(true);
    expect(isLegalRunTransition("continuing", "running_model")).toBe(true);
    expect(isLegalRunTransition("running_model", "closing")).toBe(true);
    expect(isLegalRunTransition("closing", "closed")).toBe(true);
    // terminal phases never leave (a new turn is a new run id)
    expect(isLegalRunTransition("interrupted", "running_model")).toBe(false);
    expect(isLegalRunTransition("closed", "running_model")).toBe(false);
    expect(isLegalRunTransition("failed", "continuing")).toBe(false);
    // can't skip closing
    expect(isLegalRunTransition("starting", "closed")).toBe(false);
  });
});

describe("RunController", () => {
  it("projects the current turn + phase and reports running", () => {
    const c = new RunController();
    expect(c.phase).toBe("idle");
    expect(c.isRunning).toBe(false);

    c.project("turn-1", "running_model");
    expect(c.currentTurnId).toBe("turn-1");
    expect(c.phase).toBe("running_model");
    expect(c.isRunning).toBe(true);

    c.project("turn-1", "closed");
    expect(c.isRunning).toBe(false);

    c.projectIdle();
    expect(c.phase).toBe("idle");
    expect(c.currentTurnId).toBeNull();
  });

  it("replaces the AgentRun when a new turn opens", () => {
    const c = new RunController();
    c.project("turn-1", "running_model");
    const sig1 = c.signal;
    c.project("turn-2", "starting");
    expect(c.currentTurnId).toBe("turn-2");
    expect(c.signal).not.toBe(sig1);
  });

  it("permits resume only for the current, non-terminal, un-gated turn", () => {
    const c = new RunController();
    c.project("turn-1", "waiting_external");
    expect(c.mayResume("turn-1")).toBe(true);
    // wrong turn
    expect(c.mayResume("turn-other")).toBe(false);
    // terminal
    c.project("turn-1", "interrupted");
    expect(c.mayResume("turn-1")).toBe(false);
  });

  it("gates resume after a user interrupt until the gate is cleared", () => {
    const c = new RunController();
    c.project("turn-1", "waiting_external");
    c.gateInterrupt("turn-1");
    expect(c.isInterruptGated("turn-1")).toBe(true);
    expect(c.mayResume("turn-1")).toBe(false);

    // a fresh turn is un-gated by construction
    c.clearInterruptGate();
    c.project("turn-2", "waiting_external");
    expect(c.isInterruptGated("turn-2")).toBe(false);
    expect(c.mayResume("turn-2")).toBe(true);
  });

  it("auto-clears a stale interrupt gate when a new turn opens (no cross-turn stall)", () => {
    const c = new RunController();
    c.project("turn-1", "waiting_external");
    c.gateInterrupt("turn-1");
    expect(c.isResumeBlocked("turn-1")).toBe(true);

    // The user re-engages: a fresh turn opens. The stale gate must not survive
    // and must never block the new turn's resumes.
    c.projectNewTurn("turn-2");
    expect(c.isInterruptGated("turn-1")).toBe(false);
    expect(c.isResumeBlocked("turn-2")).toBe(false);

    // Same via project() (a durable transition that opens a different turn).
    c.gateInterrupt("turn-2");
    c.project("turn-3", "running_model");
    expect(c.isResumeBlocked("turn-3")).toBe(false);
  });

  it("can carry a pre-aborted run (woken into an interrupted phase)", () => {
    const c = new RunController();
    c.project("turn-1", "interrupted");
    // projecting terminal does not abort the signal by itself; that is the
    // cancellation step's job — but mayResume must already be false.
    expect(c.mayResume("turn-1")).toBe(false);
  });
});
