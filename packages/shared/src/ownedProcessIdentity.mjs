import { spawnSync } from "node:child_process";
import fs from "node:fs";
function parseOwnedProcessIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ownershipError("Owned process identity must be an object");
  }
  const record = value;
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
    pid <= 0 ||
    processGroupId !== pid ||
    typeof startCoordinate !== "string" ||
    startCoordinate.length === 0
  ) {
    throw ownershipError("Owned process identity is invalid");
  }
  return { version, platform, pid, processGroupId: pid, startCoordinate };
}
function captureOwnedProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Owned process PID is invalid");
  if (process.platform === "linux") {
    const stat = linuxStat(pid);
    if (!stat.startCoordinate) throw new Error(`Process ${pid} has an incomplete /proc identity`);
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
function observeOwnedProcessGroup(value) {
  let identity;
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
    )
      return "unknown";
    return current.state === "Z" || current.state === "X"
      ? processGroupExists(identity.processGroupId)
        ? "retained"
        : "absent"
      : "owned";
  } catch (error) {
    if (error.code !== "ESRCH") return "unknown";
    return processGroupExists(identity.processGroupId) ? "retained" : "absent";
  }
}
function observeOwnedProcess(identity) {
  const observation = observeOwnedProcessGroup(identity);
  return observation === "retained" ? "unknown" : observation;
}
function signalOwnedProcessIdentity(identity, signal) {
  const observation = observeOwnedProcessGroup(identity);
  if (observation === "absent") return;
  if (observation !== "owned" && observation !== "retained") {
    throw ownershipError("Exact process-group ownership can no longer be proven");
  }
  try {
    process.kill(-identity.processGroupId, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function processGroupExists(processGroupId) {
  if (process.platform === "linux") {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const member = linuxStat(Number(entry));
        if (
          member.processGroupId === processGroupId &&
          member.state !== "Z" &&
          member.state !== "X"
        )
          return true;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    return false;
  }
  // macOS reports EPERM for `kill(-pgid, 0)` once a group contains only
  // zombies, even when the caller owns the processes. The process table is the
  // authoritative observation here and also lets us exclude those zombies.
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) throw ownershipError("Cannot observe native process-group members");
  return result.stdout.split(/\r?\n/u).some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/u);
    return match !== null && Number(match[1]) === processGroupId && !/^[ZX]/u.test(match[2]);
  });
}
function ownershipError(message) {
  return Object.assign(new Error(message), { code: "EOWNERSHIP" });
}
function linuxStat(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
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
  // Group membership requires only state and PGID. A /proc scan includes
  // unrelated processes and must not require their birth coordinate. The
  // leader capture and receipt comparison still require that exact coordinate.
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !fields[0]) {
    throw new Error(`Process ${pid} has an incomplete /proc group record`);
  }
  return { processGroupId, startCoordinate, state: fields[0] };
}
function darwinStat(pid) {
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
  return { processGroupId: Number(match[2]), startCoordinate: match[4], state: match[3][0] };
}
export {
  captureOwnedProcessIdentity,
  observeOwnedProcess,
  observeOwnedProcessGroup,
  parseOwnedProcessIdentity,
  signalOwnedProcessIdentity,
};

/** Test membership while the native group owner is still alive. */
export function ownedProcessDescendsFrom(rootPid, candidatePid) {
  const parents = new Map();
  if (process.platform === "linux") {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const raw = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = raw
          .slice(raw.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/u);
        parents.set(Number(entry), Number(fields[1]));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
  } else {
    const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    if (result.status !== 0) throw ownershipError("Cannot observe native process ancestry");
    for (const line of result.stdout.split("\n")) {
      const [pid, parent] = line.trim().split(/\s+/u).map(Number);
      if (pid > 0 && parent >= 0) parents.set(pid, parent);
    }
  }
  const visited = new Set();
  let pid = candidatePid;
  while (parents.has(pid) && !visited.has(pid)) {
    if (pid === rootPid) return true;
    visited.add(pid);
    pid = parents.get(pid);
  }
  return false;
}
