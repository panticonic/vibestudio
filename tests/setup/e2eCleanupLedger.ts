import fs from "node:fs";
import path from "node:path";
import { E2E_CLEANUP_LEDGER_ENV, E2E_TEMP_ROOT_ENV } from "./e2eRun.js";

type CleanupLedgerEvent =
  | "run-started"
  | "path-registered"
  | "path-released"
  | "run-cleanup-started"
  | "run-cleanup-complete"
  | "unreleased-fixtures";

interface CleanupLedgerEntry {
  event: CleanupLedgerEvent;
  timestamp: string;
  path?: string;
  coordinatorPid?: number;
  pendingCount?: number;
  sample?: string[];
}

function appendCleanupLedger(entry: CleanupLedgerEntry): void {
  const ledgerPath = process.env[E2E_CLEANUP_LEDGER_ENV];
  if (!ledgerPath) return;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  });
}

export function assertRunOwnedPath(candidate: string, runTempRoot: string): string {
  const resolvedRoot = path.resolve(runTempRoot);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `E2E cleanup path must be a strict descendant of the run temp root: ${resolvedCandidate}`
    );
  }
  return resolvedCandidate;
}

export function recordRunStarted(runTempRoot: string): void {
  appendCleanupLedger({
    event: "run-started",
    timestamp: new Date().toISOString(),
    path: path.resolve(runTempRoot),
    coordinatorPid: process.pid,
  });
}

export function registerRunCleanupPath(candidate: string): boolean {
  const runTempRoot = process.env[E2E_TEMP_ROOT_ENV];
  if (!runTempRoot) return false;
  const ownedPath = assertRunOwnedPath(candidate, runTempRoot);
  appendCleanupLedger({
    event: "path-registered",
    timestamp: new Date().toISOString(),
    path: ownedPath,
  });
  return true;
}

/**
 * Mark a path ready for the run-level cleanup phase. This deliberately does
 * not unlink anything: process cleanup remains per test, filesystem cleanup is
 * one recursive removal of the exact run root during global teardown.
 */
export function releaseRunCleanupPath(candidate: string): boolean {
  const runTempRoot = process.env[E2E_TEMP_ROOT_ENV];
  if (!runTempRoot) return false;
  const ownedPath = assertRunOwnedPath(candidate, runTempRoot);
  appendCleanupLedger({
    event: "path-released",
    timestamp: new Date().toISOString(),
    path: ownedPath,
  });
  return true;
}

/** Fixture events are diagnostics, not a reason to preserve a dead worker's profile.
 * The supplied canonical owner joins all dependent resources before removing bytes. */
export async function cleanupRunTempRoot(
  runTempRoot: string,
  retire: () => Promise<void>
): Promise<void> {
  const resolvedRoot = path.resolve(runTempRoot),
    errors: unknown[] = [];
  try {
    const ledgerPath = process.env[E2E_CLEANUP_LEDGER_ENV];
    const pending = new Set<string>();
    if (ledgerPath && fs.existsSync(ledgerPath)) {
      for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as CleanupLedgerEntry;
        if (entry.event !== "path-registered" && entry.event !== "path-released") continue;
        if (!entry.path) throw new Error("E2E cleanup ledger contains a path event without a path");
        const ownedPath = assertRunOwnedPath(entry.path, resolvedRoot);
        if (entry.event === "path-registered") pending.add(ownedPath);
        else pending.delete(ownedPath);
      }
    }
    if (pending.size)
      appendCleanupLedger({
        event: "unreleased-fixtures",
        timestamp: new Date().toISOString(),
        path: resolvedRoot,
        pendingCount: pending.size,
        sample: [...pending].slice(0, 20),
      });
    appendCleanupLedger({
      event: "run-cleanup-started",
      timestamp: new Date().toISOString(),
      path: resolvedRoot,
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await retire();
    appendCleanupLedger({
      event: "run-cleanup-complete",
      timestamp: new Date().toISOString(),
      path: resolvedRoot,
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "E2E cleanup failed");
}
