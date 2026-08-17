import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const POLL_MS = 100;

export function processTreeAlive(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }
  // A child spawned without `detached` is not a group leader, so no group bears
  // its pid and group liveness alone reports it as already gone. Ask about the
  // process itself first.
  if (pidAlive(pid)) return true;
  return [...ownedProcessGroups(pid, platform)].some((group) => processGroupAlive(group));
}

export async function terminateOwnedProcessTree(
  pid,
  { termTimeoutMs = 12_000, killTimeoutMs = 5_000, platform = process.platform } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid owned process-tree PID: ${pid}`);
  }
  if (!processTreeAlive(pid, platform)) {
    return { gone: true, escalated: false };
  }

  if (platform === "win32") {
    const result = await runTaskkill(pid);
    if (!result.ok && processTreeAlive(pid, platform)) {
      return { gone: false, escalated: true, detail: result.detail };
    }
    const gone = await waitUntilGone(pid, killTimeoutMs, platform);
    return { gone, escalated: true, ...(gone ? {} : { detail: result.detail }) };
  }

  // The hub and its workspace children intentionally use separate POSIX
  // process groups. Signal the hub first so it can perform its ordered
  // graceful shutdown, but remember every descendant group while the owner
  // is still alive. If graceful shutdown stalls, SIGKILL every group we
  // observed; killing only the owner's group would orphan a detached child.
  const ownedGroups = new Set();
  refreshOwnedProcessGroups(pid, platform, ownedGroups);
  // Signal the process as well as its groups: a non-detached child leads no
  // group, so the group signal alone is an ESRCH that retires nothing.
  signalGroup(pid, "SIGTERM");
  signalPid(pid, "SIGTERM");
  if (await waitUntilOwnedGroupsGone(pid, termTimeoutMs, platform, ownedGroups)) {
    return { gone: true, escalated: false };
  }
  refreshOwnedProcessGroups(pid, platform, ownedGroups);
  for (const group of ownedGroups) signalGroup(group, "SIGKILL");
  signalPid(pid, "SIGKILL");
  const gone = await waitUntilOwnedGroupsGone(pid, killTimeoutMs, platform, ownedGroups);
  return {
    gone,
    escalated: true,
    ...(gone ? {} : { detail: `Process group ${pid} survived SIGKILL` }),
  };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupAlive(group) {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function refreshOwnedProcessGroups(rootPid, platform, groups) {
  for (const group of ownedProcessGroups(rootPid, platform)) groups.add(group);
}

function ownedProcessGroups(rootPid, platform) {
  if (platform === "win32") return new Set([rootPid]);
  const table = readProcessTable(platform);
  if (!table) return new Set([rootPid]);

  const children = new Map();
  for (const process of table.values()) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }

  const owned = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const child of children.get(parent) ?? []) {
      if (owned.has(child)) continue;
      owned.add(child);
      pending.push(child);
    }
  }

  const groups = new Set([rootPid]);
  for (const pid of owned) {
    const entry = table.get(pid);
    if (entry) groups.add(entry.pgid);
  }
  // Never signal the group we are ourselves in. A child spawned without
  // `detached` stays in its parent's process group, so its pgid is *ours*;
  // SIGKILLing that group takes down the caller and everything else sharing it.
  // The exit then looks like an external kill rather than a bug in here, which
  // is how this hid: a cleanup loop that reliably killed its own run. What we
  // own is a group we created, never the one we were born into.
  const self = table.get(process.pid);
  if (self) groups.delete(self.pgid);
  return groups;
}

function readProcessTable(platform) {
  if (platform === "linux") {
    try {
      const table = new Map();
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) continue;
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        const pid = Number(entry);
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
          table.set(pid, { pid, ppid, pgid });
        }
      }
      return table;
    } catch {
      // Fall through to ps for non-/proc POSIX environments and restricted
      // containers where a transient /proc entry disappeared while scanning.
    }
  }

  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const table = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, ppidText, pgidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      table.set(pid, { pid, ppid, pgid });
    }
  }
  return table;
}

async function waitUntilGone(pid, timeoutMs, platform) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processTreeAlive(pid, platform)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  return !processTreeAlive(pid, platform);
}

async function waitUntilOwnedGroupsGone(rootPid, timeoutMs, platform, groups) {
  const deadline = Date.now() + timeoutMs;
  // The root leads no group when it was spawned without `detached`, so its own
  // liveness is the only evidence that it retired.
  const settled = () =>
    !pidAlive(rootPid) && ![...groups].some((group) => processGroupAlive(group));
  do {
    refreshOwnedProcessGroups(rootPid, platform, groups);
    if (settled()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  refreshOwnedProcessGroups(rootPid, platform, groups);
  return settled();
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_096);
    });
    child.stderr?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_096);
    });
    child.once("error", (error) => resolve({ ok: false, detail: error.message }));
    child.once("exit", (code) => {
      const missing = /not found|no running instance|cannot find/i.test(output);
      resolve({ ok: code === 0 || missing, detail: output.trim() });
    });
  });
}
