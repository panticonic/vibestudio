import fs from "node:fs";
import path from "node:path";
import { E2E_CLEANUP_LEDGER_ENV, E2E_TEMP_ROOT_ENV } from "./e2eRun.js";

type CleanupLedgerEvent =
  | "run-started"
  | "path-registered"
  | "path-released"
  | "run-cleanup-started"
  | "run-cleanup-complete";

interface CleanupLedgerEntry {
  event: CleanupLedgerEvent;
  timestamp: string;
  path?: string;
  coordinatorPid?: number;
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

export function cleanupRunTempRoot(
  runTempRoot: string,
  removeRoot: (root: string) => void = (root) => fs.rmSync(root, { recursive: true, force: true })
): void {
  const resolvedRoot = path.resolve(runTempRoot);
  appendCleanupLedger({
    event: "run-cleanup-started",
    timestamp: new Date().toISOString(),
    path: resolvedRoot,
  });
  removeRoot(resolvedRoot);
  appendCleanupLedger({
    event: "run-cleanup-complete",
    timestamp: new Date().toISOString(),
    path: resolvedRoot,
  });
}
