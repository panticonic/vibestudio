/** Owns the admitted calls and disposers of one physical extension activation. */
export class ExtensionRuntimeLifecycle {
  private sealed = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly cancellation = new AbortController();
  private flight: Promise<void> | null = null;
  private deactivated = false;

  run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("Extension activation is shutting down"));
    const combined = AbortSignal.any([signal, this.cancellation.signal]);
    return this.retain(Promise.resolve().then(() => operation(combined)));
  }

  retain<T>(flight: Promise<T>): Promise<T> {
    this.active.add(flight);
    void flight.then(
      () => this.active.delete(flight),
      () => this.active.delete(flight)
    );
    return flight;
  }

  private async drain(): Promise<void> {
    // Already admitted calls may attach their own waitUntil work while settling.
    // Follow actual ownership changes, never elapsed time or a retry deadline.
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  shutdown(
    disposers: Array<{ dispose(): void | Promise<void> }>,
    deactivate?: () => unknown
  ): Promise<void> {
    if (this.flight) return this.flight;
    this.sealed = true;
    this.cancellation.abort(new Error("Extension activation is shutting down"));
    const cleanup = [...disposers].reverse();
    const runDeactivate = deactivate && !this.deactivated ? deactivate : undefined;
    const flight = (async () => {
      const results = await Promise.allSettled([
        ...(runDeactivate ? [Promise.resolve().then(runDeactivate)] : []),
        ...cleanup.map((disposer) => Promise.resolve().then(() => disposer.dispose())),
        // Calls retain their own original outcome at the RPC boundary. Shutdown
        // waits for them even when cancellation legitimately rejects a call.
        this.drain(),
      ]);
      const offset = runDeactivate ? 1 : 0;
      if (runDeactivate && results[0]?.status === "fulfilled") this.deactivated = true;
      cleanup.forEach((disposer, index) => {
        if (results[offset + index]?.status === "fulfilled") {
          const retained = disposers.indexOf(disposer);
          if (retained !== -1) disposers.splice(retained, 1);
        }
      });
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Extension shutdown failed to release owned resources", {
          cause: failures[0],
        });
    })();
    this.flight = flight;
    void flight.catch(() => {
      if (this.flight === flight) this.flight = null;
    });
    return flight;
  }
}
