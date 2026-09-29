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
 * Observe a durable group receipt. `retained` means the original leader has
 * exited while its PGID still has live descendants. The creation receipt
 * remains authoritative for those descendants; unreaped zombies cannot work.
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
    if (
      current.processGroupId !== identity.processGroupId ||
      current.startCoordinate !== identity.startCoordinate
    ) return "unknown";
    // A zombie retains its PID/PGID but cannot execute or hold workspace state.
    // Its live descendants still belong to the original creation receipt.
    return current.state === "Z" || current.state === "X"
      ? processGroupExists(identity.processGroupId) ? "retained" : "absent"
      : "owned";
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "linux") {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const member = linuxStat(Number(entry));
        if (member.processGroupId === processGroupId && member.state !== "Z" && member.state !== "X")
          return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return false;
  }
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) throw ownershipError("Cannot observe native process-group members");
  return result.stdout.split(/\r?\n/u).some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/u);
    return match !== null && Number(match[1]) === processGroupId && !/^[ZX]/u.test(match[2]!);
  });
}

function ownershipError(message: string): Error {
  return Object.assign(new Error(message), { code: "EOWNERSHIP" });
}

function linuxStat(pid: number): { processGroupId: number; startCoordinate: string; state: string } {
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
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !startCoordinate) {
    throw new Error(`Process ${pid} has an incomplete /proc identity`);
  }
  return { processGroupId, startCoordinate, state: fields[0]! };
}

function darwinStat(pid: number): { processGroupId: number; startCoordinate: string; state: string } {
  const result = spawnSync(
    "ps",
    ["-o", "pid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-p", String(pid)],
    { encoding: "utf8" }
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw Object.assign(new Error(`Process ${pid} does not exist`), { code: "ESRCH" });
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
  if (!match || Number(match[1]) !== pid) {
    throw new Error(`Process ${pid} has a malformed ps identity`);
  }
  return { processGroupId: Number(match[2]), startCoordinate: match[4]!, state: match[3]![0]! };
}
