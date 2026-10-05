/** One byte budget for every regenerable HTTP representation, across builds. */
export class ArtifactBodyCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get retainedBytes(): number {
    return this.bytes;
  }

  get(key: string, load: () => Promise<Buffer>): Promise<Buffer> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return Promise.resolve(existing);
    }
    const flight = this.pending.get(key);
    if (flight) return flight;
    const promise = Promise.resolve()
      .then(load)
      .then((body) => {
        if (body.byteLength <= this.maxBytes) {
          while (this.bytes + body.byteLength > this.maxBytes) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.byteLength;
            this.entries.delete(oldest);
          }
          this.entries.set(key, body);
          this.bytes += body.byteLength;
        }
        return body;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
