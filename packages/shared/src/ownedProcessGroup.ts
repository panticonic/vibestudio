import type { ChildProcess } from "node:child_process";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  parseOwnedProcessIdentity,
  type OwnedProcessIdentity,
} from "./ownedProcessIdentity.js";

const DEFAULT_TERM_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;

export interface OwnedProcessGroupHandle {
  readonly identity: OwnedProcessIdentity | null;
  /** Resolve only after the complete detached group is absent. Idempotent. */
  retire(signal?: NodeJS.Signals): Promise<void>;
}

export interface OwnedProcessGroupOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
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

  private constructor(
    child: ChildProcess | null,
    options: OwnedProcessGroupOptions,
    adoptedIdentity: OwnedProcessIdentity | null
  ) {
    this.child = child;
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
    this.retirement ??= this.retireOnce(signal);
    return this.retirement;
  }

  private async retireOnce(signal: NodeJS.Signals): Promise<void> {
    if (process.platform === "win32") {
      if (!this.child) throw new Error("Owned Windows process handle is unavailable");
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
      if (await this.waitForChildExit(this.options.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS))
        return;
      this.child.kill("SIGKILL");
      if (!(await this.waitForChildExit(this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS))) {
        throw Object.assign(new Error("Owned process did not retire after forced termination"), {
          code: "EOWNERSHIP",
        });
      }
      return;
    }

    if (!this.identity) throw new Error("Detached process-group identity is unavailable");
    if (!this.groupExists()) return;
    if (signal !== "SIGKILL" && this.options.requestGracefulStop && this.child) {
      this.options.requestGracefulStop(signal);
    } else {
      this.signal(signal);
    }
    if (signal !== "SIGKILL") {
      const retired = await this.waitForGroupAbsence(
        this.options.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS
      );
      if (retired) return;
      this.signal("SIGKILL");
    }
    if (!(await this.waitForGroupAbsence(this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS))) {
      throw Object.assign(
        new Error(
          `Owned process group ${this.identity.processGroupId} did not retire after SIGKILL`
        ),
        { code: "EOWNERSHIP" }
      );
    }
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

  private async waitForGroupAbsence(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.groupExists()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async waitForChildExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child) throw new Error("Owned process handle is unavailable");
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      child.once("exit", onExit);
    });
  }
}
