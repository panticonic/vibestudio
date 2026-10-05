/** Own filesystem calls through authoritative caller retirement, across both IPC ends. */
export class FsCallerLifetime {
  private readonly callers = new Map<
    string,
    {
      calls: Set<Promise<unknown>>;
      retirement?: { state: "closing" | "failed"; promise: Promise<void> };
    }
  >();
  private stopping = false;
  private shutdown?: Promise<void>;

  run<T>(owners: readonly string[], operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("Filesystem is stopping");
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length === 0 || uniqueOwners.some((owner) => !owner))
      throw new Error("Filesystem calls require actual caller owners");
    for (const owner of uniqueOwners) {
      if (this.callers.get(owner)?.retirement)
        throw Object.assign(new Error(`Filesystem caller ${owner} is retiring`), {
          code: "EOWNERRETIRED",
        });
    }
    const entries = uniqueOwners.map((owner) => {
      let entry = this.callers.get(owner);
      if (!entry) {
        entry = { calls: new Set() };
        this.callers.set(owner, entry);
      }
      return entry;
    });
    const call = Promise.resolve().then(operation);
    for (const entry of entries) entry.calls.add(call);
    const release = () => {
      for (const entry of entries) entry.calls.delete(call);
    };
    void call.then(release, release);
    return call;
  }

  retire(owner: string, cleanup: () => Promise<void>): Promise<void> {
    let entry = this.callers.get(owner);
    if (entry?.retirement?.state === "closing") return entry.retirement.promise;
    if (!entry) {
      entry = { calls: new Set() };
      this.callers.set(owner, entry);
    }
    const owned = entry;
    const promise = Promise.resolve().then(async () => {
      // Each call delivers its own result/error; retirement must join it before
      // releasing handles, including opens whose IPC reply is still in flight.
      await Promise.allSettled([...owned.calls]);
      await cleanup();
    });
    const retirement = { state: "closing" as "closing" | "failed", promise };
    owned.retirement = retirement;
    void promise.then(
      () => this.callers.delete(owner),
      () => {
        // Keep failed resources owned. Another explicit retirement can resume
        // cleanup; no timer or background retry manufactures success.
        retirement.state = "failed";
      }
    );
    return promise;
  }

  stop(cleanup: (owner: string) => Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    const shutdown = joinFsCleanup(
      [...this.callers.keys()].map((owner) => this.retire(owner, () => cleanup(owner)))
    );
    this.shutdown = shutdown;
    void shutdown.catch(() => {
      this.shutdown = undefined;
    });
    return shutdown;
  }
}

/** Join every owned close before propagating its original failure. */
export async function joinFsCleanup(operations: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = [
    ...new Set(
      results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []))
    ),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Filesystem cleanup failed");
}
