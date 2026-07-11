// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  privateLanIpv4,
  relayOnlyServerEnv,
  requiresLocalTurn,
  signalingTurnVars,
  startLocalTurnRelay,
} from "../scripts/cli/lib/local-turn.mjs";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, "SIGTERM");
    return true;
  });
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("mobile script platform and relay guarantees", () => {
  it("fails iOS smoke explicitly instead of reporting install/launch as a pass", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"), "--platform", "ios"],
      { encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /iOS end-to-end smoke is unsupported[\s\S]*Refusing to report a partial install\/launch/u
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("installed and launched");
  });

  it("selects a private host address and requires TURN for launched or selected emulators", () => {
    expect(
      privateLanIpv4({
        docker: [{ family: "IPv4", internal: false, address: "172.20.0.1" }],
        wifi: [{ family: "IPv4", internal: false, address: "192.168.1.5" }],
      })
    ).toBe("192.168.1.5");
    expect(requiresLocalTurn({ launchedEmulator: true })).toBe(true);
    expect(requiresLocalTurn({ device: "emulator-5554" })).toBe(true);
    expect(requiresLocalTurn({ device: "R5CT123" })).toBe(false);
    expect(relayOnlyServerEnv({})).toEqual({ VIBESTUDIO_WEBRTC_ICE: "relay" });
    expect(relayOnlyServerEnv(null)).toEqual({});
  });

  it("starts one strict coturn configuration and exposes the signaling variables", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-turn-test-"));
    roots.push(tempDir);
    const child = new FakeChild();
    const spawnManaged = vi.fn(() => child);
    const waitForSpawn = vi.fn(async () => undefined);
    const turn = await startLocalTurnRelay({
      spawnManaged,
      waitForSpawn,
      sleep: async () => undefined,
      networkInterfaces: {
        wifi: [{ family: "IPv4", internal: false, address: "10.10.0.5" }],
      },
      tempDir,
      pid: 123,
    });

    expect(spawnManaged).toHaveBeenCalledWith(
      "turnserver",
      ["-c", turn.configPath],
      { label: "coturn" }
    );
    expect(waitForSpawn).toHaveBeenCalledWith(child, "turnserver", ["-c", turn.configPath]);
    const config = fs.readFileSync(turn.configPath, "utf8");
    expect(config).toContain("listening-ip=10.10.0.5");
    expect(config).toContain("relay-ip=10.10.0.5");
    expect(config).toContain("no-tls\nno-dtls");
    expect(config).toContain(`user=${turn.user}:${turn.pass}`);
    expect(turn.user).toMatch(/^vs-[A-Za-z0-9_-]{12}$/);
    expect(turn.pass).toMatch(/^[A-Za-z0-9_-]{32}$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(turn.configPath).mode & 0o777).toBe(0o600);
    }
    expect(signalingTurnVars(turn)).toEqual([
      "--var",
      "VIBESTUDIO_LOCAL_TURN_HOST:10.10.0.5",
      "--var",
      "VIBESTUDIO_LOCAL_TURN_PORT:47000",
      "--var",
      `VIBESTUDIO_LOCAL_TURN_USER:${turn.user}`,
      "--var",
      `VIBESTUDIO_LOCAL_TURN_PASS:${turn.pass}`,
    ]);

    await turn.cleanupArtifacts();
    expect(fs.existsSync(turn.configPath)).toBe(false);
  });

  it("fails loud and removes relay artifacts when coturn cannot start", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-turn-fail-test-"));
    roots.push(tempDir);
    const child = new FakeChild();
    await expect(
      startLocalTurnRelay({
        spawnManaged: () => child,
        waitForSpawn: async () => {
          throw new Error("spawn ENOENT");
        },
        sleep: async () => undefined,
        networkInterfaces: {
          wifi: [{ family: "IPv4", internal: false, address: "192.168.5.10" }],
        },
        tempDir,
        pid: 456,
      })
    ).rejects.toThrow(/Local TURN relay is required[\s\S]*spawn ENOENT/u);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
