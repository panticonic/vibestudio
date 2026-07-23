type Waiter = {
  resolve(partition: string): void;
  reject(error: Error): void;
};

type ReadinessState =
  | { kind: "pending" }
  | { kind: "ready"; partition: string }
  | { kind: "unavailable"; error: Error };

/**
 * One lifecycle boundary for the active browser environment.
 *
 * Browser views await this boundary before acquiring a runtime lease or
 * creating Electron state. Ordinary extension activation therefore leaves the
 * panel loading instead of converting a transient dependency into a panel
 * build error.
 */
export class BrowserEnvironmentReadiness {
  private state: ReadinessState = { kind: "pending" };
  private readonly waiters = new Set<Waiter>();

  begin(): void {
    if (this.state.kind === "ready") {
      throw new Error("Cannot restart an active browser environment");
    }
    this.state = { kind: "pending" };
  }

  wait(): Promise<string> {
    if (this.state.kind === "ready") return Promise.resolve(this.state.partition);
    if (this.state.kind === "unavailable") return Promise.reject(this.state.error);
    return new Promise<string>((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }

  ready(partition: string): void {
    if (!partition) throw new Error("Browser environment partition is required");
    this.state = { kind: "ready", partition };
    for (const waiter of this.waiters) waiter.resolve(partition);
    this.waiters.clear();
  }

  unavailable(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.state = { kind: "unavailable", error: normalized };
    for (const waiter of this.waiters) waiter.reject(normalized);
    this.waiters.clear();
  }

  requireReady(): string {
    if (this.state.kind === "ready") return this.state.partition;
    if (this.state.kind === "unavailable") throw this.state.error;
    throw new Error("Browser environment is still initializing");
  }
}
