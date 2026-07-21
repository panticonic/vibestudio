export interface PanelInitializationFailure {
  timestamp: number;
  phase: "panel-tree";
  trigger: string;
  message: string;
  stack?: string;
}

let currentFailure: PanelInitializationFailure | null = null;

/**
 * Record a caught, terminal failure of the current panel-tree initialization
 * attempt. This is deliberately separate from the main-process error ledger:
 * the rejection is handled and surfaced to the product UI, not uncaught.
 */
export function recordPanelInitializationFailure(
  trigger: string,
  error: unknown
): PanelInitializationFailure {
  currentFailure = {
    timestamp: Date.now(),
    phase: "panel-tree",
    trigger,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
  return { ...currentFailure };
}

/** Clear the previous attempt's terminal state before retrying or after success. */
export function clearPanelInitializationFailure(): void {
  currentFailure = null;
}

/** Return a defensive snapshot for diagnostics and the E2E test boundary. */
export function readPanelInitializationFailure(): PanelInitializationFailure | null {
  return currentFailure ? { ...currentFailure } : null;
}
