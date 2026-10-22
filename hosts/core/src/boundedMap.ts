/**
 * Map `items` with at most `limit` operations in flight, keeping their order.
 *
 * The first failure stops anything further from starting; the operations already
 * in flight settle before it is reported, so nothing keeps running after the
 * caller has been told it failed.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  operate: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer, received ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await operate(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}
