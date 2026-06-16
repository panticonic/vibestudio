/**
 * Serialize asynchronous work independently per key.
 *
 * The stored chain always settles successfully, so one rejected task cannot
 * wedge future work for the same key. The returned promise preserves the task
 * result/rejection for the caller.
 */
export function serializeByKey<K, T>(
  chains: Map<K, Promise<unknown>>,
  key: K,
  task: () => T | Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, stored);
  stored
    .finally(() => {
      if (chains.get(key) === stored) chains.delete(key);
    })
    .catch(() => undefined);
  return run;
}
