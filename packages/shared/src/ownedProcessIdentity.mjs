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
function observeOwnedProcessGroupReceipt(value) {
  let identity;
  try {
    identity = parseOwnedProcessIdentity(value);
  } catch {
    return {
      status: "unknown",
      activeMemberCount: 0,
      snapshot: emptyGroupSnapshot(),
      leader: { status: "unknown" },
    };
  }
  if (identity.platform !== process.platform)
    return {
      status: "unknown",
      activeMemberCount: 0,
      snapshot: emptyGroupSnapshot(),
      leader: { status: "unknown" },
    };
  const snapshot =
    identity.platform === "linux"
      ? linuxProcessGroupSnapshot(identity.processGroupId, identity.pid)
      : darwinProcessGroupSnapshot(identity.processGroupId, identity.pid);
  const leader = snapshot.leader;
  if (
    leader &&
    (leader.pgid !== identity.processGroupId || leader.startCoordinate !== identity.startCoordinate)
  ) {
    return {
      status: "unknown",
      activeMemberCount: snapshot.activeMemberCount,
      snapshot: publicGroupSnapshot(snapshot),
      leader: { status: "reused", current: publicLeader(leader) },
    };
  }
  const hasActiveMembers = snapshot.activeMemberCount > 0;
  const status =
    leader && leader.state !== "Z" && leader.state !== "X"
      ? "owned"
      : hasActiveMembers
        ? "retained"
        : "absent";
  return {
    status,
    activeMemberCount: snapshot.activeMemberCount,
    snapshot: publicGroupSnapshot(snapshot),
    leader: leader
      ? {
          status: leader.state === "Z" || leader.state === "X" ? "exited" : "matched",
          current: publicLeader(leader),
        }
      : { status: "missing" },
  };
}
function observeOwnedProcessGroup(value) {
  return observeOwnedProcessGroupReceipt(value).status;
}
function observeOwnedProcess(identity) {
  const observation = observeOwnedProcessGroupReceipt(identity).status;
  return observation === "retained" ? "unknown" : observation;
}
function emptyGroupSnapshot() {
  return { members: [], truncated: false, commandBasenameTruncated: false };
}
function publicGroupSnapshot(snapshot) {
  return {
    members: snapshot.members.map(({ pid, ppid, pgid, uid, state, command }) => ({
      pid,
      ppid,
      pgid,
      uid,
      state,
      command,
    })),
    truncated: snapshot.truncated,
    commandBasenameTruncated: snapshot.commandBasenameTruncated,
  };
}
function publicLeader(leader) {
  return {
    pid: leader.pid,
    processGroupId: leader.pgid,
    ...(leader.startCoordinate === undefined ? {} : { startCoordinate: leader.startCoordinate }),
    state: leader.state,
  };
}
function ownedProcessFailure(cause, identity, observation) {
  if (identity === null) {
    return Object.assign(new Error("Owned process-group retirement failed", { cause }), {
      code: "EOWNERSHIP",
      ownedProcessIdentity: null,
    });
  }
  return Object.assign(new Error("Owned process-group retirement failed", { cause }), {
    code: "EOWNERSHIP",
    ownedProcessIdentity: identity,
    ...(observation === undefined ? {} : { ownedProcessGroupObservation: observation }),
  });
}
function signalOwnedProcessIdentity(value, signal, options = {}) {
  const identity = parseOwnedProcessIdentity(value);
  const observe = options.observeGroup ?? (() => observeOwnedProcessGroupReceipt(identity));
  let observation;
  try {
    observation = observe();
  } catch (cause) {
    throw ownedProcessFailure(cause, identity);
  }
  if (observation.status === "absent") return;
  if (observation.status !== "owned" && observation.status !== "retained") {
    throw ownedProcessFailure(
      ownershipError("Exact process-group ownership can no longer be proven"),
      identity,
      observation
    );
  }
  try {
    if (options.signalGroup) options.signalGroup(identity.processGroupId, signal);
    else process.kill(-identity.processGroupId, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM") {
      let afterSignal;
      try {
        afterSignal = observe();
      } catch (observationError) {
        throw ownedProcessFailure(
          new AggregateError(
            [error, observationError],
            "Process signal and terminal ownership observation failed",
            { cause: error }
          ),
          identity,
          observation
        );
      }
      if (afterSignal.status === "absent") return;
      throw ownedProcessFailure(error, identity, afterSignal);
    }
    throw ownedProcessFailure(error, identity, observation);
  }
}
function linuxProcessGroupSnapshot(processGroupId, leaderPid) {
  const members = [];
  let leader = null;
  let activeMemberCount = 0;
  let truncated = false;
  let commandBasenameTruncated = false;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      if (close < 0) throw new Error(`Process ${pid} has a malformed /proc stat record`);
      const command = raw.slice(raw.indexOf("(") + 1, close);
      const fields = raw
        .slice(close + 1)
        .trim()
        .split(/\s+/u);
      const state = fields[0];
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      const startCoordinate = fields[19];
      const belongsToGroup = pgid === processGroupId;
      if (!belongsToGroup && pid !== leaderPid) continue;
      if (!Number.isSafeInteger(ppid) || !state) {
        throw new Error(`Process ${pid} has an incomplete /proc group record`);
      }
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
      if (uid === undefined) throw new Error(`Process ${pid} has no real UID record`);
      const boundedCommand = boundedBasename(command);
      commandBasenameTruncated ||= boundedCommand.truncated;
      const member = {
        pid,
        ppid,
        pgid,
        uid: Number(uid),
        state,
        startCoordinate,
        command: boundedCommand.value,
      };
      if (pid === leaderPid) leader = member;
      if (!belongsToGroup) continue;
      if (state !== "Z" && state !== "X") activeMemberCount += 1;
      if (members.length === 64) {
        truncated = true;
        continue;
      }
      members.push(member);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return { members, leader, activeMemberCount, truncated, commandBasenameTruncated };
}
function darwinProcessGroupSnapshot(processGroupId, leaderPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart=,comm="], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw ownershipError("Cannot inspect exact process-group members");
  const members = [];
  let leader = null;
  let activeMemberCount = 0;
  let truncated = false;
  let commandBasenameTruncated = false;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const prefix = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s|$)/u);
    if (!prefix) continue;
    const pid = Number(prefix[1]);
    const pgid = Number(prefix[3]);
    if (pgid !== processGroupId && pid !== leaderPid) continue;
    const match = trimmed.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/u
    );
    if (!match) throw new Error("Owned process-group member has a malformed ps record");
    const boundedCommand = boundedBasename(match[7]);
    commandBasenameTruncated ||= boundedCommand.truncated;
    const member = {
      pid,
      ppid: Number(match[2]),
      pgid,
      uid: Number(match[4]),
      state: match[5][0],
      startCoordinate: match[6],
      command: boundedCommand.value,
    };
    if (pid === leaderPid) leader = member;
    if (pgid !== processGroupId) continue;
    if (member.state !== "Z" && member.state !== "X") activeMemberCount += 1;
    if (members.length === 64) {
      truncated = true;
      continue;
    }
    members.push(member);
  }
  return { members, leader, activeMemberCount, truncated, commandBasenameTruncated };
}
function boundedBasename(command) {
  const value = command.split(/[\\/]/u).at(-1) || command;
  return { value: value.slice(0, 128), truncated: value.length > 128 };
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
  observeOwnedProcessGroupReceipt,
  ownedProcessFailure,
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
