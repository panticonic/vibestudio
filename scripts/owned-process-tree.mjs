import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  ownedProcessDescendsFrom,
  signalOwnedProcessIdentity,
} from "./owned-process-identity.mjs";

const POLL_MS = 100;

/** A detached native service cannot outlive the IPC owner that launched it.
 * Install before bootstrap. Owner loss revokes the whole execution tree,
 * including descendants that started their own process groups. It is a
 * lifecycle edge, not an idle timer or a graceful-drain deadline. */
export function bindProcessLifetimeToParent() {
  if (!process.send || !process.connected)
    throw new Error("Parent-owned process requires a live inherited IPC channel");
  const onDisconnect = () => {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(process.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      process.exit(1);
    }
    const table = readProcessTable(process.platform);
    const self = table?.get(process.pid);
    if (!self || self.pgid !== process.pid)
      throw new Error("Parent-owned service must lead its own process group");
    // Snapshot while this owner is alive: after its exit the kernel reparents
    // children and ancestry no longer proves which detached groups it owned.
    for (const group of ownedProcessGroups(process.pid, process.platform))
      signalGroup(group, "SIGKILL");
    // ownedProcessGroups deliberately excludes the caller's group. This
    // service is that group's leader and owns it, so retire it last.
    signalGroup(process.pid, "SIGKILL");
  };
  process.once("disconnect", onDisconnect);
  return () => process.off("disconnect", onDisconnect);
}

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

export function processTreeContains(rootPid, candidatePid, platform = process.platform) {
  if (platform === "win32") return false;
  return ownedProcessDescendsFrom(rootPid, candidatePid);
}

export async function terminateOwnedProcessTree(
  pid,
  { termTimeoutMs = 12_000, killTimeoutMs = 5_000, platform = process.platform, identity } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid owned process-tree PID: ${pid}`);
  }
  if (identity) {
    const ownership = observeOwnedProcessGroup(identity);
    if (ownership === "absent") return { gone: true, escalated: false };
    if (!["owned", "retained"].includes(ownership) || identity.pid !== pid) {
      throw Object.assign(new Error("Exact process-tree ownership can no longer be proven"), {
        code: "EOWNERSHIP",
      });
    }
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

  // Retain birth coordinates while ancestry is still observable. Once a
  // leader exits, only those receipts may authorize its surviving groups;
  // a reused PID must never become a new ancestry root or receive a signal.
  const groups = new Map();
  const processes = new Map();
  if (identity) groups.set(identity.processGroupId, identity);
  const root = readProcessTable(platform)?.get(pid);
  if (root && root.state !== "Z" && root.state !== "X") processes.set(pid, root);
  const refresh = () => {
    const table = readProcessTable(platform);
    if (!table)
      throw Object.assign(new Error("Cannot observe owned process tree"), { code: "EOWNERSHIP" });
    const originalRoot = processes.get(pid);
    const currentRoot = table.get(pid);
    if (
      !originalRoot ||
      !currentRoot ||
      originalRoot.birth !== currentRoot.birth ||
      currentRoot.state === "Z" ||
      currentRoot.state === "X"
    )
      return;
    const pending = [pid];
    const visited = new Set();
    while (pending.length) {
      const memberPid = pending.pop();
      if (visited.has(memberPid)) continue;
      visited.add(memberPid);
      const member = table.get(memberPid);
      if (!member || member.state === "Z" || member.state === "X") continue;
      processes.set(memberPid, member);
      if (member.pgid === memberPid && !groups.has(memberPid)) {
        try {
          groups.set(memberPid, captureOwnedProcessIdentity(memberPid));
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      for (const entry of table.values()) if (entry.ppid === memberPid) pending.push(entry.pid);
    }
  };
  const liveProcesses = () => {
    const table = readProcessTable(platform);
    if (!table)
      throw Object.assign(new Error("Cannot observe owned process tree"), { code: "EOWNERSHIP" });
    return [...processes.values()].filter((receipt) => {
      const current = table.get(receipt.pid);
      return (
        current && current.birth === receipt.birth && current.state !== "Z" && current.state !== "X"
      );
    });
  };
  const settled = () => {
    const observations = [...groups.values()].map((receipt) => observeOwnedProcessGroup(receipt));
    if (observations.includes("unknown"))
      throw Object.assign(new Error("Exact process-tree ownership can no longer be proven"), {
        code: "EOWNERSHIP",
      });
    return liveProcesses().length === 0 && observations.every((value) => value === "absent");
  };
  const signal = (value) => {
    for (const receipt of groups.values()) signalOwnedProcessIdentity(receipt, value);
    for (const receipt of liveProcesses()) {
      // Group signals already cover these members. Independently born children
      // sharing their caller's group are signalled individually, never by PGID.
      if (!groups.has(receipt.pgid)) signalPid(receipt.pid, value);
    }
  };
  const wait = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      refresh();
      if (settled()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  refresh();
  // Only the root receives TERM initially: its own shutdown owns the ordered
  // drain. Capture the tree continuously until that native owner has exited.
  if (identity) signalOwnedProcessIdentity(identity, "SIGTERM");
  else if (groups.has(pid)) signalOwnedProcessIdentity(groups.get(pid), "SIGTERM");
  else if (liveProcesses().some((receipt) => receipt.pid === pid)) signalPid(pid, "SIGTERM");
  if (await wait(termTimeoutMs)) return { gone: true, escalated: false };
  refresh();
  signal("SIGKILL");
  const gone = await wait(killTimeoutMs);
  return {
    gone,
    escalated: true,
    ...(gone ? {} : { detail: `Owned process tree ${pid} survived SIGKILL` }),
  };
}

function signalGroup(pid, signal) {
  if (!processGroupAlive(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!processGroupAlive(pid)) return;
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
  const table = readProcessTable(process.platform);
  if (table) {
    const entry = table.get(pid);
    return entry !== undefined && entry.state !== "Z" && entry.state !== "X";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function processGroupAlive(group) {
  const table = readProcessTable(process.platform);
  if (table) {
    // Zombies retain a PID/group until their new parent reaps them, but no
    // longer own memory, sockets or executable work. kill(group, 0) alone
    // mistakes them for a live runtime and can stall confirmed retirement.
    return [...table.values()].some((entry) => entry.pgid === group && entry.state !== "Z");
  }
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
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
    if (entry && entry.state !== "Z" && entry.pgid > 0) groups.add(entry.pgid);
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
        let stat;
        try {
          stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
          throw error;
        }
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
          table.set(pid, { pid, ppid, pgid, state: fields[0], birth: fields[19] });
        }
      }
      return table;
    } catch {
      // Fall through to ps for non-/proc POSIX environments and restricted
      // containers where a transient /proc entry disappeared while scanning.
    }
  }

  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const table = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, ppidText, pgidText, stateText, ...start] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      table.set(pid, { pid, ppid, pgid, state: stateText?.slice(0, 1), birth: start.join(" ") });
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
