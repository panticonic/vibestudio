/**
 * RunController / AgentRun — the consolidated agent-execution lifecycle.
 *
 * Phase 1 of the architecture-sanitization roadmap. Today "is the agent
 * running / which turn / aborted / interrupted" is tracked in several parallel
 * places (`PiRunner.running`, `TurnDispatcher.running`, the durable
 * `agent_turn_runs.status` ledger, plus in-memory abort signals/flags) that
 * must be hand-synced — the source of the "stop didn't stop" and
 * "tool hung forever" bugs.
 *
 * This module introduces ONE authoritative model:
 *   - `RunController` is **channel-scoped** and long-lived: it owns run state
 *     + admission authority (phase, interrupt gate, cancellation).
 *   - `AgentRun` is **turn-scoped**, identified by the durable `turnId`.
 *
 * It is introduced first as a *read-through projection* (shadow mode): the
 * vessel keeps writing the ledger as before and mirrors each transition here,
 * so we can assert the projection agrees with the legacy truth before any
 * writer is removed. See the roadmap's Phase 1 migration steps.
 */

/**
 * The authoritative run phase. The eight durable values are exactly the
 * `agent_turn_runs.status` union; `idle` (no active turn) and `executing_tools`
 * (a derived-only refinement of `running_model`) are in-memory additions.
 */
export type RunPhase =
  | "idle"
  | "starting"
  | "running_model"
  | "executing_tools"
  | "waiting_external"
  | "continuing"
  | "closing"
  | "closed"
  | "interrupted"
  | "failed";

/** The eight durable phases (== `AgentTurnRunStatus`). */
export type DurableRunPhase = Exclude<RunPhase, "idle" | "executing_tools">;

export const DURABLE_RUN_PHASES: readonly DurableRunPhase[] = [
  "starting",
  "running_model",
  "waiting_external",
  "continuing",
  "closing",
  "closed",
  "failed",
  "interrupted",
];

const TERMINAL_PHASES = new Set<RunPhase>(["closed", "interrupted", "failed"]);
const ACTIVE_PHASES = new Set<RunPhase>([
  "starting",
  "running_model",
  "executing_tools",
  "waiting_external",
  "continuing",
]);

export function isTerminalRunPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** "The agent is doing work" — drives typing/busy and admission decisions. */
export function isActiveRunPhase(phase: RunPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

/**
 * Legal phase transitions, owned solely by `RunController`. Wraps the durable
 * CAS in `transitionTurn`. Terminal phases leave only by opening a NEW turn
 * (a fresh `turnId`) — which is why a late resume targeting a terminal turn has
 * nowhere legal to go and is dropped, structurally killing "ghost continue".
 */
const LEGAL_TRANSITIONS: Record<DurableRunPhase, readonly DurableRunPhase[]> = {
  starting: ["running_model", "waiting_external", "continuing", "closing", "failed", "interrupted"],
  running_model: ["waiting_external", "continuing", "closing", "failed", "interrupted"],
  waiting_external: ["continuing", "running_model", "closing", "failed", "interrupted"],
  continuing: ["running_model", "waiting_external", "closing", "failed", "interrupted"],
  closing: ["closed", "failed"],
  closed: [],
  failed: [],
  interrupted: [],
};

export function isLegalRunTransition(from: DurableRunPhase, to: DurableRunPhase): boolean {
  return from === to || LEGAL_TRANSITIONS[from].includes(to);
}

/** Typed, durable cancellation reason — replaces the in-memory `abortContexts`. */
export type RunCancelReason =
  | { kind: "user_interrupt" }
  | { kind: "channel_unsubscribe" }
  | { kind: "dispose" }
  | { kind: "supersede" }
  | { kind: "work_failed"; detail?: string };

/**
 * Derive the authoritative `RunPhase` from the durable ledger status (the
 * source of truth) plus whether a turn is active. During shadow mode this lets
 * us compute the projection and assert it agrees with the legacy in-memory
 * flags (`PiRunner.running`, `TurnDispatcher.running`).
 */
export function deriveRunPhase(ledgerStatus: DurableRunPhase | null | undefined): RunPhase {
  return ledgerStatus ?? "idle";
}

/**
 * Whether the legacy in-memory `running` booleans should be true for a given
 * authoritative phase. Used by the shadow-mode agreement assertion: any
 * disagreement between this and the live flags is a latent sync bug.
 */
export function expectedRunningForPhase(phase: RunPhase): boolean {
  return isActiveRunPhase(phase);
}

/** A turn-scoped run. The `AbortController` is in-memory and one-shot. */
export class AgentRun {
  readonly turnId: string;
  private readonly ac = new AbortController();
  private _phase: RunPhase;
  private _cancelReason: RunCancelReason | null = null;

  constructor(turnId: string, phase: RunPhase = "starting", preAborted?: RunCancelReason) {
    this.turnId = turnId;
    this._phase = phase;
    if (preAborted) {
      this._cancelReason = preAborted;
      this.ac.abort(preAborted);
    }
  }

  get phase(): RunPhase {
    return this._phase;
  }
  get signal(): AbortSignal {
    return this.ac.signal;
  }
  get cancelReason(): RunCancelReason | null {
    return this._cancelReason;
  }
  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  /** Shadow-mode mirror of a durable transition. */
  setPhase(phase: RunPhase): void {
    this._phase = phase;
  }

  /** Aborts the in-memory signal with a typed reason (one-shot). */
  abort(reason: RunCancelReason): void {
    if (this.ac.signal.aborted) return;
    this._cancelReason = reason;
    this.ac.abort(reason);
  }
}

export interface RunControllerDebugState {
  turnId: string | null;
  phase: RunPhase;
  interruptGatedTurnId: string | null;
  aborted: boolean;
  cancelReason: RunCancelReason | null;
}

/**
 * Channel-scoped owner of the current `AgentRun`. In shadow mode it tracks the
 * vessel's durable transitions and the interrupt gate; later migration steps
 * make it the *sole writer* and route reads/admission through it.
 *
 * The interrupt gate is **turn-scoped** (records "turn T was interrupted by the
 * user"), so a fresh turn is un-gated by construction and a late resume for the
 * interrupted turn is dropped intrinsically.
 */
export class RunController {
  private run: AgentRun | null = null;
  /** Turn whose user-interrupt must suppress any resume until a new turn. */
  private interruptGatedTurnId: string | null = null;

  /** The currently *active* turn id (null when idle or terminal). */
  get currentTurnId(): string | null {
    if (!this.run) return null;
    return isTerminalRunPhase(this.run.phase) ? null : this.run.turnId;
  }

  /** The tracked turn id regardless of phase (used for gate/terminal checks). */
  get trackedTurnId(): string | null {
    return this.run?.turnId ?? null;
  }

  get phase(): RunPhase {
    return this.run?.phase ?? "idle";
  }

  get isRunning(): boolean {
    return isActiveRunPhase(this.phase);
  }

  get signal(): AbortSignal | undefined {
    return this.run?.signal;
  }

  /** Resume is permitted only for the current, non-terminal, un-gated turn. */
  mayResume(turnId: string): boolean {
    if (this.interruptGatedTurnId === turnId) return false;
    const run = this.run;
    if (!run || run.turnId !== turnId) return false;
    return !isTerminalRunPhase(run.phase);
  }

  /**
   * Shadow-mode projection of a durable status write. Creates/replaces the
   * `AgentRun` to match the durable turn + status the vessel just wrote.
   */
  project(turnId: string, phase: RunPhase): void {
    if (!this.run || this.run.turnId !== turnId) {
      this.onTurnSwitch(turnId);
      this.run = new AgentRun(turnId, phase);
    } else {
      this.run.setPhase(phase);
    }
  }

  /** Project a freshly-opened turn (at `starting`) without regressing one already tracked. */
  projectNewTurn(turnId: string): void {
    if (this.run?.turnId === turnId) return;
    this.onTurnSwitch(turnId);
    this.run = new AgentRun(turnId, "starting");
  }

  /**
   * Switching to a different turn means the user re-engaged (a new turn is
   * opened by a fresh user message), so a stale interrupt gate from a *previous*
   * turn must not survive. The gate is turn-scoped, so this only matters as
   * defense-in-depth, but clearing it here makes the "only a new user message
   * re-engages the agent" invariant explicit and footgun-proof.
   */
  private onTurnSwitch(turnId: string): void {
    if (this.interruptGatedTurnId && this.interruptGatedTurnId !== turnId) {
      this.interruptGatedTurnId = null;
    }
  }

  /** Project the channel going idle (no active turn). */
  projectIdle(): void {
    this.run = null;
  }

  /** Record a user interrupt on the current turn (turn-scoped, durable intent). */
  gateInterrupt(turnId: string): void {
    this.interruptGatedTurnId = turnId;
  }

  /** A fresh user message clears the gate (only a new turn re-engages). */
  clearInterruptGate(): void {
    this.interruptGatedTurnId = null;
  }

  isInterruptGated(turnId: string): boolean {
    return this.interruptGatedTurnId === turnId;
  }

  /**
   * Conservative admission check for resume/continue. Returns true only when the
   * controller *knows* this turn must not resume — it was user-interrupted, or
   * it is in a terminal phase. When the controller has not (yet) projected the
   * turn (e.g. a cold wake before rehydration), it returns false and defers to
   * the legacy recovery logic, so it can never wrongly block a valid recovery.
   */
  isResumeBlocked(turnId: string): boolean {
    if (this.interruptGatedTurnId === turnId) return true;
    if (this.run?.turnId === turnId && isTerminalRunPhase(this.run.phase)) return true;
    return false;
  }

  getDebugState(): RunControllerDebugState {
    return {
      turnId: this.currentTurnId,
      phase: this.phase,
      interruptGatedTurnId: this.interruptGatedTurnId,
      aborted: this.run?.aborted ?? false,
      cancelReason: this.run?.cancelReason ?? null,
    };
  }
}
