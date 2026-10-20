// Durable ownership state and its retirement. Plain Node JS: the reaper runs
// this without a TypeScript loader.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  bootId,
  observeOwnedProcessGroupReceipt,
  observeProcessStart,
  ownedProcessFailure,
  parseOwnedProcessIdentity,
  readRssKb,
  signalOwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";
import { removeSealedTree } from "./removeSealedTree.mjs";

/** The kernel observation cadence. Observation only: never a deadline. */
const OBSERVE_MS = 25;
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function ownershipError(message, props = {}) {
  return Object.assign(new Error(message), { code: "EOWNERSHIP", ...props });
}
const observeAgain = () => new Promise((resolve) => setTimeout(resolve, OBSERVE_MS));

export function ledgerDirOf(profileDir) {
  return path.join(profileDir, "ownership");
}
export function scratchDirOf(profileDir) {
  return path.join(ledgerDirOf(profileDir), "scratch");
}
export function validateLedgerId(id) {
  if (typeof id !== "string" || !LEDGER_ID.test(id) || id.includes(".stale-")) {
    throw ownershipError(`Invalid ownership id: ${JSON.stringify(id)}`);
  }
  return id;
}
export function ledgerFile(dir, id) {
  return path.join(dir, `${validateLedgerId(id)}.json`);
}
export function resultFile(dir, id) {
  return path.join(dir, `${validateLedgerId(id)}.result`);
}
/** `<name>.json` -> `<name>.result`: a tombstone keeps its own result name. */
function resultFileOfLedgerFile(file) {
  return file.replace(/\.json$/u, ".result");
}

// ---------------------------------------------------------------------------
// Ledger records

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseProcessStart(value, what) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startCoordinate !== "string" ||
    typeof value.bootId !== "string"
  ) {
    throw ownershipError(`Ownership ledger ${what} identity is invalid`);
  }
  return { pid: value.pid, startCoordinate: value.startCoordinate, bootId: value.bootId };
}
export function parseLedger(value) {
  if (!isRecord(value) || value.version !== 1) throw ownershipError("Ownership ledger is invalid");
  validateLedgerId(value.id);
  if (typeof value.token !== "string" || typeof value.bootId !== "string") {
    throw ownershipError("Ownership ledger is missing its token or boot id");
  }
  if (value.lifetime !== "leased" && value.lifetime !== "until-stop") {
    throw ownershipError("Ownership ledger lifetime is invalid");
  }
  if (!Array.isArray(value.groups) || !Array.isArray(value.paths) || !isRecord(value.meta)) {
    throw ownershipError("Ownership ledger is incomplete");
  }
  const groups = value.groups.map((group) => {
    if (!isRecord(group) || typeof group.key !== "string" || !Number.isSafeInteger(group.pid)) {
      throw ownershipError("Ownership ledger group is invalid");
    }
    if (group.kill !== "graceful" && group.kill !== "immediate") {
      throw ownershipError("Ownership ledger group kill mode is invalid");
    }
    return {
      key: group.key,
      pid: group.pid,
      identity: group.identity === null ? null : parseOwnedProcessIdentity(group.identity),
      kill: group.kill,
      ...(typeof group.label === "string" ? { label: group.label } : {}),
      ...(isRecord(group.oom) ? { oom: group.oom } : {}),
      ...(group.outlives === true ? { outlives: true } : {}),
    };
  });
  const paths = value.paths.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !path.isAbsolute(entry.path) ||
      (entry.kind !== "scratch" && entry.kind !== "path")
    ) {
      throw ownershipError("Ownership ledger path is invalid");
    }
    return {
      path: entry.path,
      kind: entry.kind,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
    };
  });
  return {
    version: 1,
    id: value.id,
    token: value.token,
    bootId: value.bootId,
    lifetime: value.lifetime,
    state: value.state === "ready" ? "ready" : "claimed",
    owner: parseProcessStart(value.owner, "owner"),
    reaper: parseProcessStart(value.reaper, "reaper"),
    groups,
    paths,
    meta: value.meta,
  };
}
function readLedgerFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return parseLedger(JSON.parse(raw));
}
export function readLedger(dir, id) {
  return readLedgerFile(ledgerFile(dir, id));
}
export function listLedgers(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const ledger = readLedgerFile(file);
    if (ledger) entries.push({ file, ledger });
  }
  return entries;
}
/** Atomic replace: a reader sees the old or the new record, never a torn one. */
export function writeLedger(file, ledger) {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
function serializeFailure(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error?.code === undefined ? {} : { code: String(error.code) }),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}
function flattenFailures(errors) {
  return errors.flatMap((error) => (error instanceof AggregateError ? error.errors : [error]));
}
export function readResult(dir, id) {
  let raw;
  try {
    raw = fs.readFileSync(resultFile(dir, id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw);
  if (!isRecord(value) || !Array.isArray(value.failures)) {
    throw ownershipError(`Ownership result for ${id} is invalid`);
  }
  return { id: String(value.id), failures: value.failures };
}
export function failureError(result) {
  const errors = result.failures.map((failure) =>
    Object.assign(new Error(failure.message), {
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.stack ? { stack: failure.stack } : {}),
    })
  );
  return Object.assign(new AggregateError(errors, `Ownership retirement of ${result.id} failed`), {
    code: "EOWNERSHIP",
    ledgerId: result.id,
  });
}

export function ledgerLiveness(ledger) {
  return observeProcessStart(ledger.reaper);
}

// ---------------------------------------------------------------------------
// Claim

function tryExclusiveCreate(file, ledger) {
  // link() is an exclusive create (EEXIST) whose content is complete from the
  // first instant, unlike open(O_EXCL) followed by a write.
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function claimLedger(dir, ledger) {
  const file = ledgerFile(dir, ledger.id);
  for (;;) {
    if (tryExclusiveCreate(file, ledger)) return { claimed: true };
    const holder = readLedgerFile(file);
    if (!holder) continue; // removed between our create and read
    if (ledgerLiveness(holder) === "live") return { claimed: false, holder };
    // Stale: its reaper is gone. The rename is the takeover; exactly one racer
    // wins it and the others see ENOENT and look again.
    const tombstone = path.join(dir, `${ledger.id}.stale-${randomBytes(6).toString("hex")}.json`);
    try {
      fs.renameSync(file, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const taken = readLedgerFile(tombstone);
    if (taken && taken.token !== holder.token) {
      // Between our read and our rename another racer retired the stale claim
      // and claimed afresh; we moved its live ledger. Put it back (exclusive:
      // if a third claimant slipped into the gap we must not overwrite it).
      try {
        fs.linkSync(tombstone, file);
        fs.rmSync(tombstone, { force: true });
      } catch (error) {
        throw ownershipError(
          `Ownership claim ${ledger.id} raced a concurrent takeover and could not restore it`,
          { cause: error, tombstone }
        );
      }
      continue;
    }
    if (taken) await retireLedger(taken, { dir, file: tombstone });
    else fs.rmSync(tombstone, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Retirement

function groupObserver(identity) {
  return () => observeOwnedProcessGroupReceipt(identity);
}

function signalLeader(identity, signal) {
  // A group's children belong to its leader until the leader has exited, so a
  // graceful request goes to the leader alone and only after the identity is
  // proven.
  const observation = observeOwnedProcessGroupReceipt(identity);
  if (observation.status !== "owned") return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/**
 * Retire one process group by identity. A pid that no longer names the
 * recorded leader means the group is gone (the kernel does not reuse a pid
 * still serving as a process-group id), so nothing is signalled.
 */
export async function retireGroup(group, { escalated = () => false } = {}) {
  if (group.identity === null) return retireWindowsLeader(group);
  const identity = group.identity;
  if (identity.platform !== process.platform) {
    throw ownedProcessFailure(
      ownershipError("Process receipt belongs to another platform"),
      identity
    );
  }
  const observe = groupObserver(identity);
  const state = () => {
    const observation = observe();
    // The recorded leader's pid now names a different process incarnation.
    // The kernel never reuses a pid that still serves as a group id, so the
    // recorded group is gone and whatever holds the pid now is not ours.
    if (observation.leader.status === "reused") return { ...observation, status: "absent" };
    if (observation.status === "unknown") {
      throw ownedProcessFailure(
        ownershipError("Exact process-group ownership can no longer be proven"),
        identity,
        observation
      );
    }
    return observation;
  };
  try {
    if (state().status === "absent") return;
    if (group.kill === "immediate") {
      signalOwnedProcessIdentity(identity, "SIGKILL");
    } else {
      signalLeader(identity, "SIGTERM");
      // The leader's exit is the event; remnants are unsupervised orphans.
      while (state().status === "owned") {
        if (escalated()) {
          signalOwnedProcessIdentity(identity, "SIGKILL");
          break;
        }
        await observeAgain();
      }
    }
    if (state().status !== "absent") signalOwnedProcessIdentity(identity, "SIGKILL");
    while (state().status !== "absent") await observeAgain();
  } catch (cause) {
    if (cause?.code === "EOWNERSHIP" && "ownedProcessIdentity" in cause) throw cause;
    throw ownedProcessFailure(cause, identity);
  }
}

/**
 * Windows has no process-group identity here. While the reaper holds the lease
 * the leader is the process it was told about, and `taskkill /T /F` retires
 * the leader's descendant tree. Processes that outlive their leader are
 * unreachable (documented gap), and a ledger found by a later sweep carries no
 * identity to prove, so it is never signalled.
 */
function retireWindowsLeader(group) {
  if (process.platform !== "win32") return Promise.resolve();
  const result = spawnSync("taskkill", ["/pid", String(group.pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
  // 128: the process was already gone.
  if (result.status !== 0 && result.status !== 128) {
    return Promise.reject(
      ownedProcessFailure(ownershipError(`taskkill failed: ${result.stderr?.trim()}`), null)
    );
  }
  return Promise.resolve();
}

function ownsFile(file, ledger) {
  try {
    return readLedgerFile(file)?.token === ledger.token;
  } catch {
    return false;
  }
}

export async function retireLedger(ledger, options) {
  const file = options.file ?? ledgerFile(options.dir, ledger.id);
  const resultPath = resultFileOfLedgerFile(file);
  const foreignBoot = ledger.bootId !== bootId();
  const failures = [];
  const remaining = { groups: [...ledger.groups], paths: [...ledger.paths] };
  const retire =
    options.retireGroup ??
    ((group) => retireGroup(group, options.escalated ? { escalated: options.escalated } : {}));

  // A group registered with `outlives` was deliberately handed to a successor
  // owner (`Ownership.spawnDetached`): it is forgotten here, never signalled.
  remaining.groups = remaining.groups.filter((group) => group.outlives !== true);
  const mine = ledger.groups.filter((group) => group.outlives !== true);
  let groupsFailed = false;
  if (!foreignBoot) {
    // Groups are independent; each is joined before any path is touched.
    const outcomes = await Promise.allSettled(mine.map((group) => retire(group)));
    outcomes.forEach((outcome, index) => {
      const group = mine[index];
      if (outcome.status === "fulfilled") {
        remaining.groups = remaining.groups.filter((entry) => entry !== group);
        options.onRetired?.({ group });
      } else {
        groupsFailed = true;
        failures.push(outcome.reason);
      }
    });
  } else {
    // PIDs recorded before a reboot name nothing; signal nothing.
    remaining.groups = [];
  }
  // Scratch and owned paths are removed only once every group is proven gone.
  // A path may be in use by any registered group (the ledger does not record
  // which workload uses which path), so a group that could not be retired
  // keeps all of them, and the ledger, for the next sweep or `stop` to retry.
  for (const entry of groupsFailed ? [] : [...ledger.paths].reverse()) {
    try {
      if (!path.isAbsolute(entry.path) || path.parse(entry.path).root === entry.path) {
        throw ownershipError(`Refusing to remove ${entry.path}`);
      }
      removeSealedTree(entry.path);
      remaining.paths = remaining.paths.filter((candidate) => candidate !== entry);
      options.onRetired?.({ path: entry });
    } catch (error) {
      failures.push(error);
    }
  }

  const flat = flattenFailures(failures);
  if (flat.length === 0) {
    if (ownsFile(file, ledger)) fs.rmSync(file, { force: true });
    fs.rmSync(resultPath, { force: true });
    return;
  }
  // Keep the ledger (reduced to what is left) and the evidence; the next
  // sweep or `stop` retries and surfaces it.
  try {
    if (ownsFile(file, ledger)) {
      writeLedger(file, { ...ledger, groups: remaining.groups, paths: remaining.paths });
    }
    const result = { id: ledger.id, failures: flat.map(serializeFailure) };
    const temp = `${resultPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, resultPath);
  } catch (error) {
    flat.push(error);
  }
  throw Object.assign(new AggregateError(flat, `Ownership retirement of ${ledger.id} failed`), {
    code: "EOWNERSHIP",
    ledgerId: ledger.id,
  });
}

export async function sweep(dir) {
  const report = { retired: [], skippedLive: [] };
  const failures = [];
  let entries;
  try {
    entries = listLedgers(dir);
  } catch (error) {
    throw Object.assign(new AggregateError([error], "Ownership ledger directory is unreadable"), {
      code: "EOWNERSHIP",
      report,
    });
  }
  await Promise.all(
    entries.map(async ({ file, ledger }) => {
      if (ledgerLiveness(ledger) === "live") {
        report.skippedLive.push(ledger.id);
        return;
      }
      try {
        await retireLedger(ledger, { dir, file });
        report.retired.push(ledger.id);
      } catch (error) {
        failures.push(...flattenFailures([error]));
      }
    })
  );
  if (failures.length) {
    throw Object.assign(new AggregateError(failures, "Ownership sweep could not retire a ledger"), {
      code: "EOWNERSHIP",
      report,
    });
  }
  return report;
}

export async function awaitRetirement(dir, id, { token } = {}) {
  for (;;) {
    const ledger = readLedger(dir, id);
    if (!ledger) return;
    // The id was reused: the claim the caller meant ended, and what is here is
    // a successor's. Waiting on it would wait on someone else's life.
    if (token !== undefined && ledger.token !== token) return;
    if (ledgerLiveness(ledger) === "live") {
      await observeAgain();
      continue;
    }
    // The reaper is gone but the ledger is not: it failed (its `.result` says
    // why) or died. Retry in-process; that rethrows the original failures.
    const result = readResult(dir, id);
    try {
      await retireLedger(ledger, { dir });
    } catch (error) {
      throw result ? failureError(result) : error;
    }
    return;
  }
}

export async function awaitReady(dir, id) {
  for (;;) {
    const ledger = readLedger(dir, id);
    if (!ledger) throw ownershipError(`Ownership claim ${id} ended before it was ready`);
    if (ledger.state === "ready") return ledger;
    if (ledgerLiveness(ledger) !== "live") {
      throw ownershipError(`Ownership claim ${id} died before it was ready`, { ledger });
    }
    await observeAgain();
  }
}

/**
 * Diagnostic only: observation of a group that is dying or already dead is a
 * fact about the instant, so any failure to observe contributes nothing and
 * never throws.
 */
export function summarizeLedger(ledger) {
  const groups = ledger.groups.map((group) => {
    let members = [];
    let truncated = false;
    let observed = false;
    let rssKb = 0;
    if (group.identity && group.identity.platform === process.platform) {
      try {
        const receipt = observeOwnedProcessGroupReceipt(group.identity);
        members = receipt.snapshot.members.filter(
          (member) => member.state !== "Z" && member.state !== "X"
        );
        truncated = receipt.snapshot.truncated;
        observed = receipt.status !== "unknown";
      } catch {
        members = [];
      }
    }
    for (const member of members) {
      try {
        rssKb += readRssKb(member.pid) ?? 0;
      } catch {
        // The member exited or became unreadable between the two reads.
      }
    }
    return {
      key: group.key,
      ...(group.label === undefined ? {} : { label: group.label }),
      pid: group.pid,
      rssKb,
      members: members.length,
      truncated,
      observed,
    };
  });
  return { rssKb: groups.reduce((sum, group) => sum + group.rssKb, 0), groups };
}
