import type { Ownership } from "@vibestudio/shared/ownership";

export interface OwnedEntryContext {
  /** Aborts on a stop signal (`reason.code === "ESTOP"`), lease loss or reaper loss. */
  signal: AbortSignal;
  ownership: Ownership;
  /** Present when `scratchPrefix` was given. */
  scratchRoot: string | undefined;
}

export function ownedEntry<T>(
  main: (context: OwnedEntryContext) => Promise<T> | T,
  options?: { appRoot?: string; scratchPrefix?: string; profileDir?: string }
): Promise<T | undefined>;

export function retireOnAbort(
  ownership: Ownership,
  signal: AbortSignal,
  owned: { retire(mode?: "graceful" | "immediate"): Promise<void> }
): void;

export function withOwnership<T>(
  operation: (ownership: Ownership) => Promise<T> | T,
  options?: { profileDir?: string }
): Promise<T>;
