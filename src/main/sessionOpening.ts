/** Own a session from acquisition, including the wait for authentication. */
export async function finishSessionOpening<T extends { close(): Promise<void> }>(
  session: T,
  ready: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<T> {
  let cancellation: Promise<void> | null = null;
  const cancel = () => {
    cancellation ??= session.close();
    // Observe immediately; the opening caller joins and reports cleanup below.
    void cancellation.catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) {
      cancel();
      throw signal.reason;
    }
    await ready();
    if (signal?.aborted) throw signal.reason;
    return session;
  } catch (error) {
    try {
      await (cancellation ?? session.close());
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Session opening and cleanup failed");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
