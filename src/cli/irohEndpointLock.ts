import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cliConfigRoot } from "./configPaths.js";

interface LockOwner {
  pid: number;
  startedAt: number;
}
export interface IrohEndpointLockOptions {
  timeoutMs?: number;
  onWait?: (owner: LockOwner | null) => void;
}

export async function acquireIrohEndpointLock(
  endpointSecret: string,
  options: IrohEndpointLockOptions = {}
): Promise<() => void> {
  const key = createHash("sha256").update(endpointSecret).digest("hex").slice(0, 24);
  const lockPath = path.join(cliConfigRoot(), "iroh-endpoint-locks", key);
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let announced = false;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        { mode: 0o600 }
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = readOwner(lockPath);
    if (!owner || !processAlive(owner.pid)) {
      const stale = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        fs.renameSync(lockPath, stale);
        fs.rmSync(stale, { recursive: true, force: true });
        continue;
      } catch {
        // Another contender recovered it first.
      }
    }
    if (!announced) {
      announced = true;
      options.onWait?.(owner);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Iroh endpoint owned by process ${owner?.pid ?? "?"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")
    ) as LockOwner;
    return Number.isInteger(value.pid) && Number.isFinite(value.startedAt) ? value : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
