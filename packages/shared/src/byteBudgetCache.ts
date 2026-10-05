/** LRU residency for reconstructible values, bounded by their retained byte weight. */
export class ByteBudgetCache<K, V> extends Map<K, V> {
  private readonly weights = new Map<K, number>();
  private retainedBytes = 0;
  constructor(
    private readonly maxBytes: number,
    private readonly weight: (value: V, key: K) => number
  ) {
    super();
    if (!Number.isFinite(maxBytes) || maxBytes < 0)
      throw new Error("Cache budget must be finite and nonnegative");
  }
  override get(key: K): V | undefined {
    const value = super.get(key);
    if (super.has(key)) {
      super.delete(key);
      super.set(key, value!);
    }
    return value;
  }
  override set(key: K, value: V): this {
    const bytes = this.weight(value, key);
    if (!Number.isFinite(bytes) || bytes < 0)
      throw new Error("Cache weight must be finite and nonnegative");
    this.delete(key);
    if (bytes > this.maxBytes) return this;
    super.set(key, value);
    this.weights.set(key, bytes);
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.maxBytes) this.delete(this.keys().next().value!);
    return this;
  }
  override delete(key: K): boolean {
    this.retainedBytes -= this.weights.get(key) ?? 0;
    this.weights.delete(key);
    return super.delete(key);
  }
  override clear(): void {
    super.clear();
    this.weights.clear();
    this.retainedBytes = 0;
  }
  get bytes(): number {
    return this.retainedBytes;
  }
}
