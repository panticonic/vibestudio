import { execFileSync } from "node:child_process";

/**
 * Whether processes are alive, as a test should ask it.
 *
 * Signalling a process with signal 0 succeeds for one that has died but not been
 * reaped: a zombie answers until its parent, or init once the parent is gone,
 * collects it, and on a loaded machine that can take a moment. A process that has
 * exited is not running, so these read the process table and ignore zombies.
 */

interface ProcessRow {
  pid: number;
  pgid: number;
  state: string;
}

function processTable(): ProcessRow[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 3)
    .map(([pid, pgid, state]) => ({ pid: Number(pid), pgid: Number(pgid), state: state! }));
}

const alive = (row: ProcessRow): boolean => !row.state.startsWith("Z");

/** Whether the process exists and has not exited. */
export function processIsRunning(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  return processTable().some((row) => row.pid === pid && alive(row));
}

/** The running members (`pid:state`) of a process group; empty when it is gone. */
export function liveGroupMembers(pgid: number): string[] {
  return processTable()
    .filter((row) => row.pgid === pgid && alive(row))
    .map((row) => `${row.pid}:${row.state}`);
}
