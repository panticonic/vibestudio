import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedProcessGroup } from "./ownedProcessGroup.js";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  parseOwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";

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

    // Reparented zombies can retain a kernel PID until PID 1 reaps them;
    // the group contract is absence of live executors and retained resources.
    expect(observeOwnedProcessGroup(recovered.identity!)).toBe("absent");
  });

  it("joins the child close event after the leader has exited", async () => {
    // An independently detached child deliberately retains the stdout pipe.
    // Node emits exit for the leader while its close/producer boundary stays open.
    const keeper = `console.log("ready"); setInterval(() => {}, 1000);`;
    const leader = `
      const { spawn } = require("node:child_process");
      const keeper = spawn(process.execPath, ["-e", ${JSON.stringify(keeper)}], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
      process.send({ keeperPid: keeper.pid });
      setTimeout(() => process.exit(0), 100);
    `;
    fixture = spawn(process.execPath, ["-e", leader], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore", "ipc"],
    });
    const owner = OwnedProcessGroup.create(fixture);
    const closed = once(fixture, "close");
    const exited = once(fixture, "exit");
    const [message] = await once(fixture, "message");
    const keeperIdentity = captureOwnedProcessIdentity(
      (message as { keeperPid: number }).keeperPid
    );
    await exited;
    let retired = false;
    const retirement = owner.retire().then(() => {
      retired = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(observeOwnedProcessGroup(owner.identity!)).toBe("absent");
      expect(retired).toBe(false);
      await OwnedProcessGroup.adopt(keeperIdentity).retire();
      await closed;
      await retirement;
      expect(retired).toBe(true);
    } finally {
      await OwnedProcessGroup.adopt(keeperIdentity).retire("SIGKILL");
      await owner.retire("SIGKILL");
    }
  }, 10_000);

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
