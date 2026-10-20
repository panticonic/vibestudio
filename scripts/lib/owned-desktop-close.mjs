/** Application close owns graceful shutdown. Process ownership observes the
 * real leader exit and retires only executors orphaned by that terminal event.
 * Without an `owner` the application was launched by Playwright, which owns the
 * process tree it spawned and contains it when a close fails. */
export async function closeOwnedDesktop(app, owner) {
  const child = app.process();
  try {
    await app.close();
  } catch (original) {
    if (!owner) throw original;
    // A failed close protocol is a failed release. The resource owner explicitly
    // contains that failed target and joins it, preserving the original error.
    try {
      await owner.retire("immediate");
    } catch (cleanup) {
      throw new AggregateError(
        [original, cleanup],
        "Desktop close and physical retirement failed",
        {
          cause: original,
        }
      );
    }
    throw original;
  }
  await owner?.join();
  if (child.exitCode !== 0) {
    throw new Error(
      child.exitCode !== null
        ? `Desktop exited with code ${child.exitCode} after close`
        : `Desktop exited with signal ${child.signalCode ?? "unknown"} after close`
    );
  }
}
