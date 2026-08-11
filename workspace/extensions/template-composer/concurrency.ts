export async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
