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

  /**
   * The environment failed to come up. This is terminal for the current
   * attempt: later waiters fail fast rather than hanging on a dependency that
   * is not coming.
   */
  unavailable(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.state = { kind: "unavailable", error: normalized };
    for (const waiter of this.waiters) waiter.reject(normalized);
    this.waiters.clear();
  }

  /**
   * The environment stopped as part of an ordinary lifecycle transition — the
   * owning extension restarted, the workspace reloaded. In-flight waiters are
   * released with the reason, but the boundary returns to `pending` so views
   * created afterwards wait for the next start instead of failing forever.
   *
   * Treating a stop as terminal meant one extension restart permanently broke
   * every browser panel for the rest of the session.
   */
  stopped(reason: unknown): void {
    const normalized = reason instanceof Error ? reason : new Error(String(reason));
    this.state = { kind: "pending" };
    for (const waiter of this.waiters) waiter.reject(normalized);
    this.waiters.clear();
  }

  requireReady(): string {
    if (this.state.kind === "ready") return this.state.partition;
    if (this.state.kind === "unavailable") throw this.state.error;
    throw new Error("Browser environment is still initializing");
  }
}
