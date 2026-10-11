/**
 * Preserve an operation's failure while attempting every owned cleanup step.
 * Cleanup steps run in the order supplied so callers can encode their
 * dependency order (close clients, join processes, then retire scratch).
 */
export async function runWithOwnedCleanup(operation, cleanup, message) {
  let value;
  let operationFailure;
  let hasOperationFailure = false;
  try {
    value = await operation();
  } catch (error) {
    operationFailure = error;
    hasOperationFailure = true;
  }

  let cleanupFailure;
  let hasCleanupFailure = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
    hasCleanupFailure = true;
  }

  if (hasOperationFailure && hasCleanupFailure) {
    throw joinedFailure([operationFailure, cleanupFailure], message);
  }
  if (hasOperationFailure) throw operationFailure;
  if (hasCleanupFailure) throw cleanupFailure;
  return value;
}

/** Attempt all cleanup steps and retain every distinct failure in order. */
export async function runOwnedCleanupSteps(steps, message) {
  const failures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length) throw joinedFailure(failures, message);
}

function joinedFailure(failures, message) {
  const distinct = [...new Set(failures)];
  if (distinct.length === 1) return distinct[0];
  return new AggregateError(distinct, message, { cause: distinct[0] });
}

export function hasOwnershipFailure(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  return (
    error.code === "EOWNERSHIP" ||
    hasOwnershipFailure(error.cause, seen) ||
    (Array.isArray(error.errors) && error.errors.some((child) => hasOwnershipFailure(child, seen)))
  );
}
