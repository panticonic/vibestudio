import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import {
  ownBoundedLaunchLog,
  parseClaudeLaunchRecord,
  recoverMaterializedLaunch,
  type ClaudeLaunchRecord,
} from "./launchOwnership.js";

describe.skipIf(process.platform === "win32")("Claude durable launch ownership", () => {
  let root: string | null = null;
  let fixture: ChildProcess | null = null;

  afterEach(() => {
    if (fixture?.pid) {
      try {
        process.kill(-fixture.pid, "SIGKILL");
      } catch {
        // The focused ownership assertion normally proves this group absent.
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
    fixture = null;
    root = null;
  });

  it("recovers a leaderless receipt, drains resistant descendants, then releases bounded logs", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "claude-owned-launch-"));
    const launchId = "generation-real-owner";
    const profilesRoot = path.join(root, "agent-launch");
    const profileDir = path.join(
      profilesRoot,
      `${Buffer.from(launchId).toString("base64url")}.11111111-1111-4111-8111-111111111111`
    );
    mkdirSync(path.join(profileDir, "claude-config"), { recursive: true });
    const resistant = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(resistant)}], { stdio: "ignore" });
      process.stdout.write("x".repeat(32_768));
      setTimeout(() => process.exit(0), 50);
    `;
    fixture = spawn(process.execPath, ["-e", leader], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const created = OwnedProcessGroup.create(fixture);
    const logPath = path.join(profileDir, "headless.log");
    const log = ownBoundedLaunchLog(fixture, logPath, 4_096);
    const record: ClaudeLaunchRecord = {
      version: 2,
      launchId,
      entityId: "entity-1",
      contextId: "context-1",
      channelId: "channel-1",
      vesselRef: "vessel-1",
      ownerKind: "extension-headless",
      phase: "active",
      agentId: "agent-1",
      preparedAt: new Date().toISOString(),
      materialization: { profileDir, logPath, credentialState: null },
      process: created.identity,
    };
    const persisted = parseClaudeLaunchRecord(JSON.parse(JSON.stringify(record)), "fixture");
    expect(recoverMaterializedLaunch(persisted, profilesRoot)?.profileDir).toBe(profileDir);
    await once(fixture, "exit");

    await OwnedProcessGroup.adopt(persisted.process, {
      termTimeoutMs: 100,
      killTimeoutMs: 2_000,
    }).retire();
    log.close();

    expect(() => process.kill(-persisted.process!.processGroupId, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
    expect(statSync(logPath).size).toBeLessThanOrEqual(4_096);
    expect(readFileSync(logPath).length).toBeGreaterThan(0);
    expect(existsSync(profileDir)).toBe(true);
    rmSync(profileDir, { recursive: true });
    expect(existsSync(profileDir)).toBe(false);
  });

  it("rejects corrupt records and profile receipts outside the owned root", () => {
    expect(() => parseClaudeLaunchRecord({ version: 2 }, "broken.json")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" })
    );
    const record = parseClaudeLaunchRecord(
      {
        version: 2,
        launchId: "generation",
        entityId: "entity",
        contextId: "context",
        channelId: "channel",
        vesselRef: "vessel",
        ownerKind: "extension-headless",
        phase: "active",
        agentId: null,
        preparedAt: new Date().toISOString(),
        materialization: {
          profileDir: "/tmp/foreign-profile",
          logPath: "/tmp/foreign-profile/headless.log",
          credentialState: null,
        },
        process: null,
      },
      "foreign.json"
    );
    expect(() => recoverMaterializedLaunch(record, "/tmp/exact-root")).toThrow(
      expect.objectContaining({ code: "EOWNERSHIP" })
    );
  });
});
