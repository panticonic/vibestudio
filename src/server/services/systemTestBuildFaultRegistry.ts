import { randomUUID } from "node:crypto";
import type { DevelopmentRun } from "@vibestudio/service-schemas/development";

export type SystemTestBuildFaultPhase = "after-snapshot-retained";

export interface SystemTestBuildFault {
  faultId: string;
  runId: string;
  phase: SystemTestBuildFaultPhase;
}

export interface SystemTestBuildFaultArmReceipt extends SystemTestBuildFault {
  armedAt: number;
}

interface ArmedFault extends SystemTestBuildFaultArmReceipt {
  sessionId: string;
  ownerRuntimeId: string;
  ownerUserId: string | null;
  expiresAt: number;
}

/**
 * A deliberately tiny, process-local test fixture. It is neither a build
 * option nor durable product state: an arm is bound to one owned run, expires
 * quickly, and is removed before it can affect the reviewed executor.
 */
export class SystemTestBuildFaultRegistry {
  private readonly faults = new Map<string, ArmedFault>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 2 * 60_000;
    this.maxEntries = options.maxEntries ?? 128;
  }

  arm(input: {
    sessionId: string;
    runId: string;
    ownerRuntimeId: string;
    ownerUserId: string | null;
    phase: SystemTestBuildFaultPhase;
  }): SystemTestBuildFaultArmReceipt {
    this.prune();
    const existing = this.faults.get(input.runId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.ownerRuntimeId !== input.ownerRuntimeId ||
        existing.ownerUserId !== input.ownerUserId ||
        existing.phase !== input.phase
      ) {
        throw coded("EIDEMPOTENCYDRIFT", "System-test build fault binding drifted");
      }
      return receipt(existing);
    }
    if (this.faults.size >= this.maxEntries) {
      throw coded("EBUSY", "System-test build fault registry is at capacity");
    }
    const armedAt = this.now();
    const armed: ArmedFault = {
      faultId: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      phase: input.phase,
      ownerRuntimeId: input.ownerRuntimeId,
      ownerUserId: input.ownerUserId,
      expiresAt: armedAt + this.ttlMs,
      armedAt,
    };
    this.faults.set(input.runId, armed);
    return receipt(armed);
  }

  /**
   * Delete first: JavaScript's single-threaded turn makes this exact run's
   * consumption indivisible, even if the executor immediately retries work.
   */
  consumeAfterSnapshotRetained(run: DevelopmentRun): SystemTestBuildFault | null {
    this.prune();
    const armed = this.faults.get(run.runId);
    if (!armed) return null;
    if (
      run.commitPoint !== "snapshot-retained" ||
      run.state !== "installing" ||
      armed.sessionId !== run.sessionId ||
      armed.ownerRuntimeId !== run.ownerRuntimeId ||
      armed.ownerUserId !== run.ownerUserId
    ) {
      return null;
    }
    this.faults.delete(run.runId);
    return { faultId: armed.faultId, runId: armed.runId, phase: armed.phase };
  }

  private prune(): void {
    const now = this.now();
    for (const [runId, fault] of this.faults) {
      if (fault.expiresAt <= now) this.faults.delete(runId);
    }
  }
}

function receipt(fault: ArmedFault): SystemTestBuildFaultArmReceipt {
  return {
    faultId: fault.faultId,
    runId: fault.runId,
    phase: fault.phase,
    armedAt: fault.armedAt,
  };
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
