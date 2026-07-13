import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cliConfigRoot } from "./configPaths.js";

interface LockOwner {
  pid: number;
  startedAt: number;
}

export interface WebRtcConnectionLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
  onWait?: (owner: LockOwner | null) => void;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60_000;

export function webRtcConnectionLockPath(room: string): string {
  const key = createHash("sha256").update(room).digest("hex").slice(0, 24);
  return path.join(cliConfigRoot(), "webrtc-locks", key);
}

/**
 * Serialize CLI processes that share one WebRTC offerer room. A signaling room
 * owns one live peer negotiation, so overlapping processes would otherwise
 * supersede each other and corrupt both SDP exchanges.
 */
export async function acquireWebRtcConnectionLock(
  room: string,
  options: WebRtcConnectionLockOptions = {}
): Promise<() => void> {
  const lockPath = webRtcConnectionLockPath(room);
  const parent = path.dirname(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + timeoutMs;
  let announcedWait = false;

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const owner: LockOwner = { pid: process.pid, startedAt: Date.now() };
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
        encoding: "utf8",
        mode: 0o600,
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const owner = readOwner(lockPath);
    if (isStale(lockPath, owner, staleAfterMs)) {
      const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        fs.renameSync(lockPath, quarantine);
        fs.rmSync(quarantine, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (!isMissing(error)) {
          // Another contender may have recovered it first; retry normally.
        }
      }
    }

    if (!announcedWait) {
      announcedWait = true;
      options.onWait?.(owner);
    }
    if (Date.now() >= deadline) {
      const detail = owner ? ` held by process ${owner.pid}` : "";
      throw new Error(
        `Timed out waiting for another Vibestudio CLI WebRTC connection${detail} to close`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    return Number.isInteger(parsed.pid) && Number.isFinite(parsed.startedAt)
      ? { pid: parsed.pid as number, startedAt: parsed.startedAt as number }
      : null;
  } catch {
    return null;
  }
}

function isStale(lockPath: string, owner: LockOwner | null, staleAfterMs: number): boolean {
  if (!owner) {
    // The owner file is written immediately after mkdir. Give that tiny creation
    // window room before treating an ownerless directory left by a crash as stale.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  if (Date.now() - owner.startedAt > staleAfterMs) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
