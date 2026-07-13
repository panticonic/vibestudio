import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWebRtcConnectionLock, webRtcConnectionLockPath } from "./webrtcConnectionLock.js";

describe("CLI WebRTC connection lock", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-webrtc-lock-"));
    vi.stubEnv("XDG_CONFIG_HOME", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("queues a second connection until the first closes", async () => {
    const releaseFirst = await acquireWebRtcConnectionLock("room-shared");
    const onWait = vi.fn();
    let acquiredSecond = false;
    const second = acquireWebRtcConnectionLock("room-shared", {
      timeoutMs: 1_000,
      pollMs: 5,
      onWait,
    }).then((release) => {
      acquiredSecond = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquiredSecond).toBe(false);
    expect(onWait).toHaveBeenCalledOnce();

    releaseFirst();
    const releaseSecond = await second;
    expect(acquiredSecond).toBe(true);
    releaseSecond();
  });

  it("recovers a lock whose owning process no longer exists", async () => {
    const lockPath = webRtcConnectionLockPath("room-stale");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() - 60_000 })
    );

    const release = await acquireWebRtcConnectionLock("room-stale", {
      timeoutMs: 100,
      pollMs: 5,
    });
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    release();
  });
});
