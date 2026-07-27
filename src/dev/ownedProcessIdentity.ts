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

export function observeOwnedProcess(identity: OwnedProcessIdentity): OwnedProcessObservation {
  if (
    identity.version !== 1 ||
    identity.platform !== process.platform ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.processGroupId !== identity.pid ||
    !identity.startCoordinate
  ) {
    return "unknown";
  }
  try {
    const current =
      identity.platform === "linux" ? linuxStat(identity.pid) : darwinStat(identity.pid);
    if (
      current.processGroupId === identity.processGroupId &&
      current.startCoordinate === identity.startCoordinate
    ) {
      return "owned";
    }
    return "unknown";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown";
    try {
      process.kill(-identity.processGroupId, 0);
      return "unknown";
    } catch (groupError) {
      return (groupError as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
    }
  }
}

export function signalOwnedProcessIdentity(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals
): void {
  const observation = observeOwnedProcess(identity);
  if (observation === "absent") return;
  if (observation !== "owned") {
    throw Object.assign(new Error("Exact process-group ownership can no longer be proven"), {
      code: "EOWNERSHIP",
    });
  }
  try {
    process.kill(-identity.processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
    {
      encoding: "utf8",
    }
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
