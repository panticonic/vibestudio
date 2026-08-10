import type { StateArgsValidation } from "./stateArgs.js";

/** Clone one state-args value through its wire representation. */
export function normalizeStateArgs(args: unknown): StateArgsValidation {
  try {
    return { success: true, data: JSON.parse(JSON.stringify(args ?? {})) };
  } catch {
    return { success: false, error: "stateArgs must be JSON-serializable" };
  }
}
