import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  computeHostBuildFingerprint,
  DESKTOP_HOST_BUILD_FINGERPRINT_PATH,
  readHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "./host-build-fingerprint.mjs";

const HOST_BUILD_LOCK_PATH = path.resolve("dist/host-build.lock");

async function acquireHostBuildLock() {
  fs.mkdirSync(path.dirname(HOST_BUILD_LOCK_PATH), { recursive: true });
  const token = randomUUID();
  let announced = false;

  for (;;) {
    try {
      fs.writeFileSync(
        HOST_BUILD_LOCK_PATH,
        JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 }
      );
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(HOST_BUILD_LOCK_PATH, "utf8"));
          if (owner.token === token) fs.rmSync(HOST_BUILD_LOCK_PATH);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(HOST_BUILD_LOCK_PATH, "utf8"));
    } catch {
      // The owner may be between the atomic create and its first readable
      // write. Poll once more before considering an ownerless lock stale.
    }

    const ownerPid = Number(owner?.pid);
    let ownerAlive = false;
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }

    const lockAgeMs = (() => {
      try {
        return Date.now() - fs.statSync(HOST_BUILD_LOCK_PATH).mtimeMs;
      } catch {
        return 0;
      }
    })();
    if ((!owner || !ownerAlive) && lockAgeMs >= 1_000) {
      try {
        fs.rmSync(HOST_BUILD_LOCK_PATH);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }

    if (!announced) {
      announced = true;
      console.log(
        `[host-build] Waiting for host build${ownerAlive ? ` from process ${ownerPid}` : ""}...`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let exitCode = 0;
let releaseLock;
try {
  releaseLock = await acquireHostBuildLock();

  // Recompute after waiting: source files may have changed while another
  // process was producing the artifacts we just acquired.
  const expected = computeHostBuildFingerprint();
  // A source-server prerequisite build does not produce the Electron bundle.
  // Its host identity marker must not make a desktop launch reuse stale output.
  const current = readHostBuildFingerprint(process.cwd(), DESKTOP_HOST_BUILD_FINGERPRINT_PATH);

  if (sameHostBuildFingerprint(current, expected)) {
    console.log(`[host-build] Reusing current ${expected.mode} artifacts.`);
  } else {
    console.log(`[host-build] Inputs changed; building ${expected.mode} artifacts.`);
    const result = spawnSync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    exitCode = result.status ?? 1;
  }
} finally {
  releaseLock?.();
}

process.exitCode = exitCode;
