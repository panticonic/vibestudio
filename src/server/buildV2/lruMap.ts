/**
 * Insertion-ordered map that evicts its least recently written entries beyond
 * `capacity`. Used for caches of immutable, recomputable projections, where an
 * eviction costs only a later recomputation.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): V {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return value;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }
}
