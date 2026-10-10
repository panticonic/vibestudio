/** Admission belongs to a real initiating call, never to an observer's guessed ID. */
export class BrowserImportAdmissions<T = unknown> {
  private readonly pending = new Map<string, { request: string; ready: Promise<T> }>();

  run(key: string, request: string, admit: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.request !== request) {
        return Promise.reject(new Error("Import operation has different inputs"));
      }
      return existing.ready;
    }
    // Register ownership before executing any asynchronous preparation.
    const ready = Promise.resolve().then(admit);
    const entry = { request, ready };
    this.pending.set(key, entry);
    const release = () => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    };
    void ready.then(release, release);
    return ready;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  async wait(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const entry = this.pending.get(key);
    if (!entry) return;
    if (!signal) {
      await entry.ready;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
      void entry.ready.then(
        () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        }
      );
    });
  }
}
