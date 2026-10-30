import type {
  OwnedProcessIdentity,
  ProcessLiveness,
  ProcessStart,
} from "./ownedProcessIdentity.mjs";

/**
 * `graceful`: SIGTERM the leader and wait for its exit, then SIGKILL whatever
 * the group still holds. `immediate`: SIGKILL the group at once.
 */
export type KillMode = "graceful" | "immediate";
/** Declared contract, recorded for attach/stop/list; retirement itself is identical. */
export type OwnershipLifetime = "leased" | "until-stop";

export interface LedgerGroup {
  /** `${pid}:${startCoordinate}` (`${pid}` where Windows has no start coordinate). */
  key: string;
  pid: number;
  /** Null only on Windows, where retirement is leader-only (`taskkill /T /F`). */
  identity: OwnedProcessIdentity | null;
  kill: KillMode;
  label?: string;
  /** Result of the best-effort Linux `oom_score_adj=+500` write, reported as data. */
  oom?: { ok: true } | { ok: false; error: string };
  /**
   * Registered by `Ownership.spawnDetached`: deliberately outlives this ledger's
   * owner and reaper. Retirement and sweeps forget it without signalling it; its
   * successor owner retires it.
   */
  outlives?: true;
}
export interface LedgerPath {
  path: string;
  kind: "scratch" | "path";
  label?: string;
}
export interface Ledger {
  version: 1;
  id: string;
  /** Unique per claim; distinguishes this claim from a later one with the same id. */
  token: string;
  bootId: string;
  lifetime: OwnershipLifetime;
  state: "claimed" | "ready";
  owner: ProcessStart;
  reaper: ProcessStart;
  groups: LedgerGroup[];
  /** Removed in reverse order. */
  paths: LedgerPath[];
  /** Caller-defined JSON (e.g. an instance's registry record). */
  meta: Record<string, unknown>;
}
export interface LedgerFailure {
  message: string;
  code?: string;
  stack?: string;
}
export interface LedgerResult {
  id: string;
  failures: LedgerFailure[];
}

export type OwnershipError = Error & { code: "EOWNERSHIP" };

/** `<profile>/ownership`: ledgers, `.result` files. */
export function ledgerDirOf(profileDir: string): string;
/** `<profile>/ownership/scratch`: disk-backed scratch roots. */
export function scratchDirOf(profileDir: string): string;
export function ledgerFile(dir: string, id: string): string;
export function resultFile(dir: string, id: string): string;
export function validateLedgerId(id: string): string;

export function parseLedger(value: unknown): Ledger;
export function readLedger(dir: string, id: string): Ledger | null;
/** Every parsable ledger file in the directory (including stale-takeover tombstones). */
export function listLedgers(dir: string): Array<{ file: string; ledger: Ledger }>;
/** Atomic replace: temp file + rename. */
export function writeLedger(file: string, ledger: Ledger): void;
/** Whether `file` still holds this claim; an unreadable file is not proof that it does. */
export function ownsFile(file: string, ledger: Ledger): boolean;
export function readResult(dir: string, id: string): LedgerResult | null;
export function failureError(result: LedgerResult): AggregateError & OwnershipError;

/** Liveness of the ledger's REAPER (R) identity: pid + start coordinate + boot id. */
export function ledgerLiveness(ledger: Ledger): ProcessLiveness;

/**
 * Retire a Windows group by its leader (`taskkill /T /F`). Windows has no group
 * identity: success is the leader being gone, whatever `taskkill` reported while
 * the tree was exiting. The options exist for tests.
 */
export function retireWindowsLeader(
  group: Pick<LedgerGroup, "pid">,
  options?: {
    platform?: NodeJS.Platform;
    run?: (
      command: string,
      args: string[],
      options: object
    ) => { status: number | null; stderr?: string | null };
    exists?: (pid: number) => boolean;
  }
): Promise<void>;

export type ClaimResult = { claimed: true } | { claimed: false; holder: Ledger };
/**
 * Claim `ledger.id` by exclusive creation of its ledger file. A holder whose
 * reaper is not live is stale: it is renamed to a unique tombstone (exactly one
 * racer wins the rename), retired, and the claim retried. A live holder is
 * returned so the caller can attach.
 */
export function claimLedger(dir: string, ledger: Ledger): Promise<ClaimResult>;

export interface RetireOptions {
  dir: string;
  /** The ledger file being retired (default `ledgerFile(dir, ledger.id)`). */
  file?: string;
  /** Memoising hook for owners that already have group retirements in flight. */
  retireGroup?: (group: LedgerGroup) => Promise<void>;
  /** Polled during graceful waits; true means SIGKILL now. */
  escalated?: () => boolean;
  /** Called after each group/path is gone. */
  onRetired?: (entry: { group?: LedgerGroup; path?: LedgerPath }) => void;
}
/**
 * 1 SIGTERM each live graceful leader and await its exit (immediate: SIGKILL);
 * 2 SIGKILL remaining group members by identity; 3 observe until the group is
 * absent; 4 remove paths in reverse order; 5 unlink the ledger. A ledger from
 * another boot only has its paths removed; nothing is ever signalled. Groups
 * marked `outlives` are forgotten, not signalled.
 * Paths are removed only when every group is proven gone: if any group could
 * not be retired, ALL paths (scratch included) and the ledger are kept.
 * On failure the reduced ledger and `<name>.result` are kept and the promise
 * rejects with an AggregateError of the original failures.
 */
export function retireLedger(ledger: Ledger, options: RetireOptions): Promise<void>;
/** Retire one group by identity (steps 1-3). Idempotent. */
export function retireGroup(
  group: LedgerGroup,
  options?: { escalated?: () => boolean }
): Promise<void>;

export interface SweepReport {
  retired: string[];
  skippedLive: string[];
}
/**
 * Retire every ledger whose reaper identity is not live. Safe to run
 * concurrently from any process. Rejects with an AggregateError (`.report`
 * carries the partial outcome) after attempting every ledger.
 */
export function sweep(dir: string): Promise<SweepReport>;

/**
 * Wait (observing the reaper) until the ledger's reaper has exited. Resolves
 * when the ledger is gone; rejects with the reaper's `.result` failures, or
 * with the in-process retirement failure when the reaper died silently.
 * `token` (the `Ledger.token` read before signalling) fences the wait to that
 * claim: if the id has been reused by a successor, the wait resolves instead of
 * waiting on the successor.
 */
export function awaitRetirement(
  dir: string,
  id: string,
  options?: { token?: string }
): Promise<void>;
/** Resolve once the holder marks the ledger ready; reject if its reaper dies first. */
export function awaitReady(dir: string, id: string): Promise<Ledger>;

export interface LedgerRss {
  rssKb: number;
  groups: Array<{
    key: string;
    label?: string;
    pid: number;
    rssKb: number;
    members: number;
    truncated: boolean;
    /** False when the group could not be observed (gone, or ownership unprovable): RSS 0 then. */
    observed: boolean;
  }>;
}
/** Summed RSS of the registered groups' live members (inspect/list). Never throws. */
export function summarizeLedger(ledger: Ledger): LedgerRss;
