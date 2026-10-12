export function runWithOwnedCleanup<T>(
  operation: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
  message: string
): Promise<T>;

export function runOwnedCleanupSteps(
  steps: readonly (() => void | Promise<void>)[],
  message: string
): Promise<void>;

export function hasOwnershipFailure(error: unknown, seen?: Set<object>): boolean;
