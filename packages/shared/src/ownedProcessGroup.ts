import type { ChildProcess } from "node:child_process";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  parseOwnedProcessIdentity,
  type OwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";

export interface OwnedProcessGroupHandle {
  readonly identity: OwnedProcessIdentity | null;
  /** Observe the original leader exit, retire its orphans, and join producer close. */
  join(): Promise<void>;
  /** Request leader-owned shutdown, or explicitly force termination. Idempotent. */
  retire(signal?: NodeJS.Signals): Promise<void>;
}

export interface OwnedProcessGroupOptions {
  groupExists?: (processGroupId: number) => boolean;
  signalGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  requestGracefulStop?: (signal: NodeJS.Signals) => void;
}

/**
 * Capability for one detached process group. It can be created directly from
 * the ChildProcess creation receipt or recovered from a strictly parsed
 * durable PID/start receipt after an owner restart.
 */
export class OwnedProcessGroup implements OwnedProcessGroupHandle {
  readonly identity: OwnedProcessIdentity | null;
  private readonly child: ChildProcess | null;
  private readonly options: OwnedProcessGroupOptions;
  private retirement: Promise<void> | null = null;
  private readonly childClosed: Promise<void> | null;
  private readonly childExited: Promise<void> | null;
  private stopRequested = false;

  private constructor(
    child: ChildProcess | null,
    options: OwnedProcessGroupOptions,
    adoptedIdentity: OwnedProcessIdentity | null
  ) {
    this.child = child;
    this.childExited = child
      ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
      : null;
    this.childClosed = child
      ? new Promise<void>((resolve) => child.once("close", () => resolve()))
      : null;
    this.options = options;
    if (adoptedIdentity !== null) {
      this.identity = adoptedIdentity;
      return;
    }
    if (child?.pid === undefined) throw new Error("Owned detached process has no PID");
    this.identity = process.platform === "win32" ? null : captureOwnedProcessIdentity(child.pid);
  }

  /** Own a freshly spawned detached process group. */
  static create(child: ChildProcess, options: OwnedProcessGroupOptions = {}): OwnedProcessGroup {
    return new OwnedProcessGroup(child, options, null);
  }

  private static fromIdentity(
    identity: OwnedProcessIdentity,
    options: OwnedProcessGroupOptions
  ): OwnedProcessGroup {
    if (identity.platform !== process.platform) {
      throw Object.assign(new Error("Durable process receipt belongs to another platform"), {
        code: "EOWNERSHIP",
      });
    }
    return new OwnedProcessGroup(null, options, identity);
  }

  /** Recover the exact original group capability from trusted durable storage. */
  static adopt(value: unknown, options: OwnedProcessGroupOptions = {}): OwnedProcessGroup {
    if (process.platform === "win32") {
      throw Object.assign(new Error("Durable process ownership is unavailable on this platform"), {
        code: "EEXECUTOR_UNAVAILABLE",
      });
    }
    return OwnedProcessGroup.fromIdentity(parseOwnedProcessIdentity(value), options);
  }

  retire(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    try {
      // An explicit force request remains authoritative even when graceful
      // shutdown or an observer join is already in flight.
      if (signal === "SIGKILL") {
        if (process.platform === "win32") this.child?.kill(signal);
        else if (this.groupExists()) this.signal(signal);
      } else if (!this.stopRequested && this.leaderIsLive()) {
        this.stopRequested = true;
        if (this.options.requestGracefulStop) this.options.requestGracefulStop(signal);
        else if (this.child) {
          if (!this.child.kill(signal) && this.leaderIsLive()) {
            throw new Error("Original process leader did not accept shutdown signal");
          }
        } else {
          // A recovered receipt still grants only the exact original leader.
          // Its children belong to that leader until it has actually exited.
          try {
            process.kill(this.identity!.pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
    } catch (cause) {
      return Promise.reject(this.ownershipFailure(cause));
    }
    return this.join();
  }

  join(): Promise<void> {
    this.retirement ??= this.joinOnce().catch((cause: unknown) => {
      throw this.ownershipFailure(cause);
    });
    return this.retirement;
  }

  private ownershipFailure(cause: unknown): Error {
    return Object.assign(new Error("Owned process-group retirement failed", { cause }), {
      code: "EOWNERSHIP",
    });
  }

  private leaderIsLive(): boolean {
    if (this.child) return this.child.exitCode === null && this.child.signalCode === null;
    if (!this.identity) throw new Error("Detached process-group identity is unavailable");
    const observation = observeOwnedProcessGroup(this.identity);
    if (observation === "unknown") {
      throw new Error("Exact process-group ownership can no longer be proven");
    }
    return observation === "owned";
  }

  private async joinOnce(): Promise<void> {
    if (this.child) {
      if (this.leaderIsLive()) await this.childExited;
    } else {
      // Recovered receipts have no ChildProcess event producer. Inspect actual
      // kernel identity until the original leader exits; elapsed time is never
      // evidence that it has failed or that its children are orphaned.
      while (this.leaderIsLive()) await this.observeAgain();
    }
    if (process.platform !== "win32") {
      if (this.groupExists()) this.signal("SIGKILL");
      while (this.groupExists()) await this.observeAgain();
    }
    // Exit is not producer close: a retained stdio pipe must still be joined.
    await this.childClosed;
  }

  private observeAgain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 25));
  }

  private signal(signal: NodeJS.Signals): void {
    const identity = this.identity;
    if (!identity) throw new Error("Detached process-group identity is unavailable");
    try {
      if (this.options.signalGroup) {
        this.options.signalGroup(identity.processGroupId, signal);
      } else {
        const observation = observeOwnedProcessGroup(identity);
        if (observation === "unknown") {
          throw Object.assign(new Error("Exact process-group ownership can no longer be proven"), {
            code: "EOWNERSHIP",
          });
        }
        if (observation !== "absent") process.kill(-identity.processGroupId, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private groupExists(): boolean {
    const identity = this.identity;
    if (!identity) throw new Error("Detached process-group identity is unavailable");
    if (this.options.groupExists) return this.options.groupExists(identity.processGroupId);
    const observation = observeOwnedProcessGroup(identity);
    if (observation === "unknown") {
      throw Object.assign(new Error("Exact process-group ownership can no longer be proven"), {
        code: "EOWNERSHIP",
      });
    }
    return observation !== "absent";
  }
}
