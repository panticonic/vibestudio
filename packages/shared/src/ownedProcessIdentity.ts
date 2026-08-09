import { spawnSync } from "node:child_process";
import fs from "node:fs";

export interface OwnedProcessIdentity {
  version: 1;
  platform: "linux" | "darwin";
  pid: number;
  processGroupId: number;
  startCoordinate: string;
}

export type OwnedProcessObservation = "owned" | "absent" | "unknown";
export type OwnedProcessGroupObservation = OwnedProcessObservation | "retained";

/** Parse a durable process receipt without weakening or repairing it. */
export function parseOwnedProcessIdentity(value: unknown): OwnedProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ownershipError("Owned process identity must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["pid", "platform", "processGroupId", "startCoordinate", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw ownershipError("Owned process identity has unknown or missing fields");
  }
  const { version, platform, pid, processGroupId, startCoordinate } = record;
  if (
    version !== 1 ||
    (platform !== "linux" && platform !== "darwin") ||
    !Number.isSafeInteger(pid) ||
    (pid as number) <= 0 ||
    processGroupId !== pid ||
    typeof startCoordinate !== "string" ||
    startCoordinate.length === 0
  ) {
    throw ownershipError("Owned process identity is invalid");
  }
  return { version, platform, pid: pid as number, processGroupId: pid as number, startCoordinate };
}

/** Capture a PID-reuse-resistant coordinate for a freshly spawned group leader. */
export function captureOwnedProcessIdentity(pid: number): OwnedProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Owned process PID is invalid");
  if (process.platform === "linux") {
    const stat = linuxStat(pid);
    if (stat.processGroupId !== pid) {
      throw new Error(`Owned process ${pid} is not its detached process-group leader`);
    }
    return {
      version: 1,
      platform: "linux",
      pid,
      processGroupId: stat.processGroupId,
      startCoordinate: stat.startCoordinate,
    };
  }
  if (process.platform === "darwin") {
    const stat = darwinStat(pid);
    if (stat.processGroupId !== pid) {
      throw new Error(`Owned process ${pid} is not its detached process-group leader`);
    }
    return {
      version: 1,
      platform: "darwin",
      pid,
      processGroupId: stat.processGroupId,
      startCoordinate: stat.startCoordinate,
    };
  }
  throw Object.assign(new Error("Durable process ownership is unavailable on this platform"), {
    code: "EEXECUTOR_UNAVAILABLE",
  });
}

/**
 * Observe a durable group receipt. `retained` means the exact original leader
 * is gone while its PGID still has descendants. POSIX retains that PGID until
 * its last member exits, so the creation receipt remains authoritative.
 */
export function observeOwnedProcessGroup(
  value: OwnedProcessIdentity
): OwnedProcessGroupObservation {
  let identity: OwnedProcessIdentity;
  try {
    identity = parseOwnedProcessIdentity(value);
  } catch {
    return "unknown";
  }
  if (identity.platform !== process.platform) return "unknown";
  try {
    const current =
      identity.platform === "linux" ? linuxStat(identity.pid) : darwinStat(identity.pid);
    return current.processGroupId === identity.processGroupId &&
      current.startCoordinate === identity.startCoordinate
      ? "owned"
      : "unknown";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown";
    return processGroupExists(identity.processGroupId) ? "retained" : "absent";
  }
}

export function observeOwnedProcess(identity: OwnedProcessIdentity): OwnedProcessObservation {
  const observation = observeOwnedProcessGroup(identity);
  return observation === "retained" ? "unknown" : observation;
}

export function signalOwnedProcessIdentity(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals
): void {
  const observation = observeOwnedProcessGroup(identity);
  if (observation === "absent") return;
  if (observation !== "owned" && observation !== "retained") {
    throw ownershipError("Exact process-group ownership can no longer be proven");
  }
  try {
    process.kill(-identity.processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function ownershipError(message: string): Error {
  return Object.assign(new Error(message), { code: "EOWNERSHIP" });
}

function linuxStat(pid: number): { processGroupId: number; startCoordinate: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`Process ${pid} does not exist`), { code: "ESRCH" });
    }
    throw error;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error(`Process ${pid} has a malformed /proc stat record`);
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startCoordinate = fields[19];
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !startCoordinate) {
    throw new Error(`Process ${pid} has an incomplete /proc identity`);
  }
  return { processGroupId, startCoordinate };
}

function darwinStat(pid: number): { processGroupId: number; startCoordinate: string } {
  const result = spawnSync(
    "ps",
    ["-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
    { encoding: "utf8" }
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw Object.assign(new Error(`Process ${pid} does not exist`), { code: "ESRCH" });
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
  if (!match || Number(match[1]) !== pid) {
    throw new Error(`Process ${pid} has a malformed ps identity`);
  }
  return { processGroupId: Number(match[2]), startCoordinate: match[3]! };
}
