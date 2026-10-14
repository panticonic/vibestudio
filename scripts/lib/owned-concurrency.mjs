/** Run independent work with bounded admission and join every admitted item
 * before returning ownership to a caller that may retire its resources.
 * @template T
 * @param {readonly T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<void>} operation
 */
export async function forEachOwnedConcurrent(values, concurrency, operation) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError("Owned concurrency must be a positive integer");
  let cursor = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (failures.length === 0 && cursor < values.length) {
        const value = values[cursor++];
        try {
          await operation(value);
        } catch (error) {
          failures.push(error);
        }
      }
    })
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Concurrent owned work failed", { cause: failures[0] });
}
