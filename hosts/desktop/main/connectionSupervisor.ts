import type { ConnectionProcessExit, ConnectionProcessHandle } from "./connectionProcess.js";

export interface ConnectionSupervisorDeps {
  /** Start a replacement connection process. */
  launch(): ConnectionProcessHandle;
  /**
   * Re-establish the connection on the replacement and rebind everything that
   * held the lost one (proxy handles, renderer ports). Rejects with the real
   * failure, including the replacement's own exit.
   */
  reestablish(next: ConnectionProcessHandle): Promise<void>;
  /** The connection process ended without being asked to: the connection is lost. */
  lost(exit: ConnectionProcessExit): void;
  /** The replacement is established and everything is rebound. */
  restored(): void;
  /** The replacement could not be established; nothing else will try. */
  failed(error: unknown, exit: ConnectionProcessExit): void;
}

/**
 * Keeps one connection process alive across its unexpected exits.
 *
 * The process's exit event is the only trigger: it fails every pending call
 * and port with the exit reason (that is `lost`), and a replacement is started
 * and re-established once per such event. There is no probe, timer or retry:
 * a replacement that fails to establish stays failed and is reported, and a
 * replacement that establishes and later exits is a new, separate event.
 */
export class ConnectionSupervisor {
  private current: ConnectionProcessHandle;
  private disposed = false;
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly deps: ConnectionSupervisorDeps,
    initial: ConnectionProcessHandle
  ) {
    this.current = initial;
    this.watch(initial);
  }

  /** The process currently serving the connection. */
  get handle(): ConnectionProcessHandle {
    return this.current;
  }

  /** The recovery in progress, if any; settles when it has restored or failed. */
  get recovering(): Promise<void> | null {
    return this.recovery;
  }

  private watch(handle: ConnectionProcessHandle): void {
    void handle.exited.then((exit) => {
      if (this.disposed || exit.requested || handle !== this.current) return;
      const recovery: Promise<void> = this.recover(exit).finally(() => {
        if (this.recovery === recovery) this.recovery = null;
      });
      this.recovery = recovery;
    });
  }

  private async recover(exit: ConnectionProcessExit): Promise<void> {
    this.deps.lost(exit);
    const next = this.deps.launch();
    this.current = next;
    try {
      await this.deps.reestablish(next);
    } catch (error) {
      await next.dispose();
      this.deps.failed(error, exit);
      return;
    }
    if (this.disposed) return;
    this.watch(next);
    this.deps.restored();
  }

  /** Stop the connection process on purpose and stop supervising it. */
  async dispose(): Promise<ConnectionProcessExit> {
    this.disposed = true;
    await this.recovery;
    return this.current.dispose();
  }
}
