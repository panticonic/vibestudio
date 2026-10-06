/** Application close owns graceful shutdown. Process ownership observes the
 * real leader exit and retires only executors orphaned by that terminal event. */
export async function closeOwnedDesktop(app, owner) {
  try {
    await app.close();
  } catch (original) {
    // A failed close protocol is a failed release. The resource owner explicitly
    // contains that failed target and joins it, preserving the original error.
    try {
      await owner.retire("SIGKILL");
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
  await owner.join();
  const child = app.process();
  if (child.exitCode !== 0) {
    throw new Error(
      child.exitCode !== null
        ? `Desktop exited with code ${child.exitCode} after close`
        : `Desktop exited with signal ${child.signalCode ?? "unknown"} after close`
    );
  }
}
