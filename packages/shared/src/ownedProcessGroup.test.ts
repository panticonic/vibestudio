import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedProcessGroup } from "./ownedProcessGroup.js";
import { parseOwnedProcessIdentity } from "./ownedProcessIdentity.js";

describe.skipIf(process.platform === "win32")("durable owned process groups", () => {
  let fixture: ChildProcess | null = null;

  afterEach(() => {
    if (!fixture?.pid) return;
    try {
      process.kill(-fixture.pid, "SIGKILL");
    } catch {
      // The ownership assertion normally proves this exact group absent.
    }
    fixture = null;
  });

  it("adopts a persisted receipt and drains resistant descendants after the leader exits", async () => {
    const resistant = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(resistant)}], { stdio: "ignore" });
      setTimeout(() => process.exit(0), 50);
    `;
    fixture = spawn(process.execPath, ["-e", leader], {
      detached: true,
      stdio: "ignore",
    });
    const created = OwnedProcessGroup.create(fixture);
    const receipt = JSON.parse(JSON.stringify(created.identity)) as unknown;
    await once(fixture, "exit");

    const recovered = OwnedProcessGroup.adopt(receipt, {
      termTimeoutMs: 100,
      killTimeoutMs: 2_000,
    });
    await Promise.all([recovered.retire(), recovered.retire()]);

    expect(() => process.kill(-recovered.identity!.processGroupId, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
  });

  it("rejects incomplete and extended durable receipts", () => {
    expect(() => parseOwnedProcessIdentity({ version: 1, pid: 42 })).toThrow(/fields/);
    expect(() =>
      parseOwnedProcessIdentity({
        version: 1,
        platform: process.platform,
        pid: 42,
        processGroupId: 42,
        startCoordinate: "1",
        extra: true,
      })
    ).toThrow(/fields/);
  });
});
