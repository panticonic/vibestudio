/**
 * Map `values` with at most `concurrency` operations in flight, preserving
 * input order in the result.
 *
 * A failure stops admission of further values, but every admitted operation
 * is joined before the failure reaches the caller: callers commonly replay,
 * delete or release what the operations were writing, which must not race
 * stray work still in flight. One failure is rethrown as is; several become an
 * AggregateError carrying `failureMessage`.
 */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  failureMessage: string,
  apply: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (failures.length === 0 && next < values.length) {
        const index = next++;
        try {
          results[index] = await apply(values[index]!, index);
        } catch (error) {
          failures.push(error);
          return;
        }
      }
    })
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failureMessage, { cause: failures[0] });
  }
  return results;
}
