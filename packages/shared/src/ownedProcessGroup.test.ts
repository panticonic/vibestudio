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
  let fixtureOwner: OwnedProcessGroup | null = null;

  afterEach(async () => {
    await fixtureOwner?.retire("SIGKILL");
    fixtureOwner = null;
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
    fixtureOwner = created;
    const receipt = JSON.parse(JSON.stringify(created.identity)) as unknown;
    await once(fixture, "exit");

    const recovered = OwnedProcessGroup.adopt(receipt);
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
    fixtureOwner = owner;
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

  it("joins when permission denial races with the last executor retiring", async () => {
    fixture = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    let live = true;
    const owner = OwnedProcessGroup.create(fixture, {
      groupExists: () => live,
      signalGroup: () => {
        live = false;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    });
    fixtureOwner = owner;
    await expect(owner.join()).resolves.toBeUndefined();
    expect(live).toBe(false);
  });

  it("preserves permission denial while live executors remain", async () => {
    fixture = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    const closed = once(fixture, "close");
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const owner = OwnedProcessGroup.create(fixture, {
      groupExists: () => true,
      signalGroup: () => { throw denied; },
    });
    await expect(owner.join()).rejects.toMatchObject({ code: "EOWNERSHIP", cause: denied });
    // The real fixture's sole process has exited and its producer is closed;
    // the injected live-membership observation exists only for this assertion.
    await closed;
    fixture = null;
  });

  it("preserves both signal denial and failed terminal observation", async () => {
    fixture = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    const closed = once(fixture, "close");
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const observation = new Error("Cannot observe owned members");
    let signals = 0;
    const owner = OwnedProcessGroup.create(fixture, {
      groupExists: () => { if (signals) throw observation; return true; },
      signalGroup: () => { signals++; throw denied; },
    });
    await expect(owner.join()).rejects.toMatchObject({
      code: "EOWNERSHIP",
      cause: { errors: [denied, observation], cause: denied },
    });
    await closed;
    fixture = null;
  });

  async function heldLeader() {
    const resistant = `
      process.on('SIGTERM', () => process.send({kind:'child-term'}));
      process.send({kind:'child-ready'});
      setInterval(() => {}, 1000);
    `;
    const leader = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(resistant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.on('message',event=>process.send({...event,childPid:child.pid}));
      process.on('SIGTERM',()=>process.send({kind:'leader-stop'}));
      process.on('message',event=>{if(event.kind==='release')process.exit(0);});
      setInterval(()=>{},1000);
    `;
    fixture = spawn(process.execPath, ["-e", leader], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore", "ipc"],
    });
    fixtureOwner = OwnedProcessGroup.create(fixture);
    const messages: { kind: string; childPid?: number }[] = [];
    fixture.on("message", (message) => messages.push(message as (typeof messages)[number]));
    const [ready] = await once(fixture, "message");
    expect(ready).toMatchObject({ kind: "child-ready" });
    return {
      child: fixture,
      owner: fixtureOwner,
      messages,
      childPid: (ready as { childPid: number }).childPid,
    };
  }

  it("requests stop only from the live leader and waits for its actual exit before reaping its child", async () => {
    const { child, owner, messages, childPid } = await heldLeader();
    const stopped = once(child, "message");
    let joined = false;
    const retirement = owner.retire().then(() => {
      joined = true;
    });
    expect((await stopped)[0]).toEqual({ kind: "leader-stop" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    expect(observeOwnedProcessGroup(owner.identity!)).toBe("owned");
    expect(() => process.kill(childPid, 0)).not.toThrow();
    expect(messages.some((message) => message.kind === "child-term")).toBe(false);
    child.send({ kind: "release" });
    await retirement;
    expect(joined).toBe(true);
    expect(observeOwnedProcessGroup(owner.identity!)).toBe("absent");
  }, 10_000);

  it("lets an explicit force request preempt a pending graceful retirement", async () => {
    const { child, owner } = await heldLeader();
    const stopped = once(child, "message");
    const graceful = owner.retire();
    expect((await stopped)[0]).toEqual({ kind: "leader-stop" });
    await Promise.all([owner.retire("SIGKILL"), graceful]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(observeOwnedProcessGroup(owner.identity!)).toBe("absent");
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
