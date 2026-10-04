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
}
