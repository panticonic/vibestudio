import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { OwnedProcessIdentity } from "./ownedProcessIdentity.mjs";
import type { KillMode, Ledger, OwnershipError, OwnershipLifetime } from "./ownershipLedger.mjs";

export type { KillMode, Ledger, OwnershipLifetime } from "./ownershipLedger.mjs";
export { watchLease } from "./ownershipLease.mjs";

export interface OwnershipOptions {
  /** Profile directory; ownership state lives in `<profileDir>/ownership`. */
  profileDir: string;
  /** Claim name (default: a fresh unique id). An id held by a live ledger rejects with `OwnershipClaimedError`. */
  id?: string;
  lifetime: OwnershipLifetime;
  /** JSON stored in the ledger at claim time. */
  meta?: Record<string, unknown>;
  /**
   * Absolute path of `reaper.mjs` (default: beside this module). Needed when the
   * client is bundled somewhere the reaper does not ship beside. The reaper's
   * sibling files (`OWNERSHIP_REAPER_FILES`) must sit in the same directory.
   */
  reaperPath?: string;
}

/** How the reaper process is started; pure, so the Electron case is testable. */
export interface ReaperSpawnPlan {
  command: string;
  args: string[];
  options: {
    env: Record<string, string | undefined>;
    detached: boolean;
    stdio: ["ignore", "ignore", "ignore", "ipc"];
    windowsHide: true;
  };
}
/**
 * Plan the reaper spawn. When `versions.electron` is set the reaper runs as
 * Node via `ELECTRON_RUN_AS_NODE=1` in the reaper's env only; NODE_OPTIONS and
 * the owner's lease descriptor variable are removed from it.
 */
export function buildReaperSpawn(input: {
  reaperPath: string;
  config: Record<string, unknown>;
  execPath?: string;
  versions?: { electron?: string };
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}): ReaperSpawnPlan;

export interface OwnedSpawnOptions extends Omit<SpawnOptions, "detached"> {
  /** Required: how this resource is retired. */
  kill: KillMode;
  label?: string;
  /**
   * Give the child a lease: an extra stdio pipe (fd number in
   * `VIBESTUDIO_LEASE_FD`) whose end-of-file means this owner is gone. The child
   * watches it with `watchLease()`.
   */
  lease?: boolean;
}

export interface OwnedDetachedSpawnOptions extends Omit<OwnedSpawnOptions, "kill" | "lease"> {
  /** Applies only to an explicit `retire()` (default "graceful"). */
  kill?: KillMode;
}
export interface OwnedAdoptOptions {
  kill: KillMode;
  label?: string;
}

export interface OwnedProcess {
  /** The owner's own ChildProcess: stdio, IPC and events work unchanged. */
  readonly child: ChildProcess;
  /** Null when the process could not be spawned (the child's `error` event reports why) or on Windows. */
  readonly identity: OwnedProcessIdentity | null;
  /**
   * Resolves once the reaper has durably recorded the group. Rejects if it
   * refused (the group is then killed) or the process never started. The
   * failure is reported once: to an observer of this promise (or of `join()` /
   * `retire()`), otherwise by the owner's `release()`.
   */
  readonly registered: Promise<void>;
  /**
   * Retire this group now: per its kill mode, or immediately when `mode` is
   * "immediate" (also escalates a graceful retirement in flight). Resolves when
   * the group is absent and the child's stdio has closed.
   */
  retire(mode?: KillMode): Promise<void>;
  /** Wait for the leader to exit on its own, retire leftover members, forget the group. */
  join(): Promise<void>;
}

/** Settles all owned work and aggregates every original failure. */
export class OwnedScope {
  /** Track in-flight work; a rejection surfaces from `close()`. Returns the promise. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Cleanup run by `close()`, last-registered first; sync or async. */
  defer(cleanup: () => unknown): void;
  /** Idempotent. Runs cleanups (all of them, even after a failure), then awaits tracked work. Rejects with AggregateError(errors = originals, code EOWNERSHIP). */
  close(): Promise<void>;
}

export interface ReaperStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The id is held by a live ledger (`holder`); callers may attach with `awaitReady`. */
export class OwnershipClaimedError extends Error {
  readonly code: "ECLAIMED";
  readonly holder: Ledger;
}

export class Ownership {
  /**
   * Start this owner's reaper (plain node, own process group), claim the id,
   * and resolve once the ledger is durable. Nothing may be started before this.
   */
  static open(options: OwnershipOptions): Promise<Ownership>;
  readonly id: string;
  readonly profileDir: string;
  readonly ledgerDir: string;
  readonly lifetime: OwnershipLifetime;
  /** This claim's ledger token: pass to `awaitRetirement(dir, id, { token })`. */
  readonly token: string;
  readonly scope: OwnedScope;
  /** Aborts with an EOWNERSHIP reason (carrying `reaperStatus`) if the reaper dies before release. The owner should then exit non-zero. */
  readonly signal: AbortSignal;

  /** Spawn detached, record the group with the reaper in the same synchronous turn. */
  spawn(command: string, args: readonly string[], options: OwnedSpawnOptions): OwnedProcess;
  /**
   * Spawn a child that deliberately OUTLIVES this owner (the `until-stop`
   * instance supervisor). Registers its group in this ledger marked `outlives`:
   * visible, never retired by this owner's release, death, or any sweep. Its
   * successor owner (its own `Ownership`) retires it. No lease; stdio defaults
   * to "ignore"; the child is unref'd and `release()` does not wait for it.
   * Callers must use this instead of a raw `detached: true`.
   */
  spawnDetached(
    command: string,
    args: readonly string[],
    options?: OwnedDetachedSpawnOptions
  ): OwnedProcess;
  /**
   * Register an ALREADY-RUNNING child this owner did not spawn through the
   * library (e.g. Playwright's `electron.launch`) so the reaper retires its
   * group. It must be its own process-group leader (else this throws and nothing
   * is registered). No lease or stdio control; `join()`/`retire()` wait for the
   * group to be gone, not for stdio to close.
   */
  adopt(child: ChildProcess, options: OwnedAdoptOptions): OwnedProcess;
  /** Reaper-created directory under `<profile>/ownership/scratch`; removed at retirement. */
  scratch(prefix: string): Promise<string>;
  /** Record an absolute path to remove at retirement (after scratch/groups, reverse order). */
  own(path: string, label?: string): Promise<void>;
  /** Merge JSON into the ledger's `meta`. */
  annotate(patch: Record<string, unknown>): Promise<void>;
  /** Mark the claim ready for attachers (`awaitReady`). */
  markReady(): Promise<void>;
  /** SIGKILL every graceful retirement in flight (and any later one). */
  escalate(): Promise<void>;
  /** Retire everything and return only once the reaper has exited and every owned child has closed. Idempotent. Rejects with AggregateError of the original failures; the ledger and `.result` are then retained. */
  release(): Promise<void>;
  /** Alias of `release()`. */
  close(): Promise<void>;
}

export type { OwnershipError };
export {
  awaitReady,
  awaitRetirement,
  readLedger,
  summarizeLedger,
  sweep,
} from "./ownershipLedger.mjs";
