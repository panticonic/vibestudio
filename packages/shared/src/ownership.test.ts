import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootId,
  captureOwnedProcessIdentity,
  captureProcessStart,
  type OwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";
import {
  buildReaperSpawn,
  OwnedScope,
  Ownership,
  OwnershipClaimedError,
  watchLease,
} from "./ownership.mjs";
import { OWNERSHIP_CLIENT_FILES, OWNERSHIP_REAPER_FILES } from "./ownershipFiles.mjs";
import {
  awaitRetirement,
  claimLedger,
  failureError,
  ledgerDirOf,
  ledgerFile,
  readLedger,
  readResult,
  resultFile,
  retireLedger,
  summarizeLedger,
  sweep,
  type Ledger,
} from "./ownershipLedger.mjs";

const OWNERSHIP_URL = new URL("./ownership.mjs", import.meta.url).href;
// Linux only: observation here reads /proc. macOS shares the code paths, not these assertions.
const linux = process.platform === "linux";

const cleanups: Array<() => void> = [];
let profile: string;
beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-test-"));
  cleanups.push(() => {
    fs.chmodSync(profile, 0o700);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      // Best-effort fixture teardown; assertions already ran.
    }
  }
});

/** Poll a kernel observation; the test runner's own deadline bounds it. */
async function until(condition: () => boolean, _what: string): Promise<void> {
  for (;;) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function running(pid: number): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2, raw.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
function track(child: ChildProcess): ChildProcess {
  cleanups.push(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  });
  return child;
}
function detachedSleep(): { child: ChildProcess; identity: OwnedProcessIdentity } {
  const child = track(spawn("sleep", ["600"], { detached: true, stdio: "ignore" }));
  return { child, identity: captureOwnedProcessIdentity(child.pid!) };
}

/** A real owner process: runs `body` with `Ownership` and `config` in scope, reports JSON lines. */
interface OwnerProcess {
  child: ChildProcess;
  next(type: string): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}
function startOwner(body: string, config: Record<string, unknown> = {}): OwnerProcess {
  const source = `
    import { Ownership, OwnershipClaimedError, watchLease } from ${JSON.stringify(OWNERSHIP_URL)};
    const config = JSON.parse(process.env.OWNER_CONFIG);
    const emit = (type, data = {}) => process.stdout.write(JSON.stringify({ type, ...data }) + "\\n");
    ${body}
  `;
  const child = track(
    spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, OWNER_CONFIG: JSON.stringify({ profileDir: profile, ...config }) },
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    })
  );
  const seen: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      seen.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
    waiters.splice(0).forEach((wake) => wake());
  });
  return {
    child,
    exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    kill: (signal) => child.kill(signal),
    async next(type) {
      for (;;) {
        const index = seen.findIndex((event) => event["type"] === type);
        if (index >= 0) return seen.splice(index, 1)[0]!;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const ledgerDir = () => ledgerDirOf(profile);

describe.skipIf(!linux)("ownership library", () => {
  it("retires the group, grandchild, scratch and ledger when the owner is SIGKILLed", async () => {
    const owner = startOwner(`
      const ownership = await Ownership.open({ profileDir: config.profileDir, id: "killed", lifetime: "leased" });
      const scratch = await ownership.scratch("killed-");
      const proc = ownership.spawn("sh", ["-c", "sleep 600 & echo $!; wait"], { kill: "immediate", stdio: ["ignore", "pipe", "inherit"] });
      const grandchild = await new Promise((resolve) => proc.child.stdout.once("data", (d) => resolve(Number(d.toString()))));
      await proc.registered;
      emit("ready", { scratch, leader: proc.child.pid, grandchild });
      setInterval(() => {}, 1000);
    `);
    const ready = await owner.next("ready");
    const leader = ready["leader"] as number;
    const grandchild = ready["grandchild"] as number;
    const ledger = readLedger(ledgerDir(), "killed")!;
    expect(ledger.groups.map((group) => group.pid)).toEqual([leader]);
    expect(running(grandchild)).toBe(true);

    owner.kill("SIGKILL");

    await until(() => !running(leader) && !running(grandchild), "workload retired");
    await until(() => !running(ledger.reaper.pid), "reaper exit");
    expect(fs.existsSync(ready["scratch"] as string)).toBe(false);
    expect(readLedger(ledgerDir(), "killed")).toBeNull();
    expect(readResult(ledgerDir(), "killed")).toBeNull();
  });

  it("joins retirement after app data was removed without recreating it", async () => {
    const ownership = await Ownership.open({ profileDir: profile, lifetime: "leased" });
    try {
      const proc = ownership.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
      await proc.registered;
      fs.rmSync(ledgerDir(), { recursive: true });
      await proc.retire();
      expect(running(proc.child.pid!)).toBe(false);
      expect(fs.existsSync(ledgerDir())).toBe(false);
    } finally {
      await ownership.release();
    }
    expect(fs.existsSync(ledgerDir())).toBe(false);
  });

  it("accepts explicit escalation while release is joining a graceful process", async () => {
    const ownership = await Ownership.open({ profileDir: profile, lifetime: "leased" });
    const proc = ownership.spawn(
      process.execPath,
      [
        "-e",
        `
      process.on("SIGTERM", () => console.log("stopping"));
      console.log("ready");
      setInterval(() => {}, 1000);
    `,
      ],
      { kill: "graceful", stdio: ["ignore", "pipe", "inherit"] }
    );
    await new Promise((resolve) => proc.child.stdout!.once("data", resolve));
    await proc.registered;
    const stopped = new Promise((resolve) => proc.child.stdout!.once("data", resolve));
    const releasing = ownership.release();
    await stopped;
    await ownership.escalate();
    await releasing;
    expect(running(proc.child.pid!)).toBe(false);
    expect(readLedger(ledgerDir(), ownership.id)).toBeNull();
  });

  it("does not overwrite a successor claim when retiring an earlier process", async () => {
    const original = await Ownership.open({
      profileDir: profile,
      id: "replaced",
      lifetime: "leased",
    });
    let successor: Ownership | undefined;
    try {
      const proc = original.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
      await proc.registered;
      fs.rmSync(ledgerFile(ledgerDir(), original.id));
      successor = await Ownership.open({
        profileDir: profile,
        id: original.id,
        lifetime: "leased",
      });
      const claimed = readLedger(ledgerDir(), successor.id);
      await proc.retire();
      await original.release();
      expect(running(proc.child.pid!)).toBe(false);
      expect(readLedger(ledgerDir(), successor.id)).toEqual(claimed);
    } finally {
      await original.release();
      await successor?.release();
    }
  });

  it("closes normally, reports RSS and OOM adjustment as data, and removes everything", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "normal",
      lifetime: "until-stop",
    });
    const scratch = await ownership.scratch("normal-");
    fs.writeFileSync(path.join(scratch, "file"), "x");
    const proc = ownership.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
    await proc.registered;
    await ownership.annotate({ role: "test" });
    await ownership.markReady();

    const ledger = readLedger(ledgerDir(), "normal")!;
    expect(ledger).toMatchObject({
      lifetime: "until-stop",
      state: "ready",
      meta: { role: "test" },
    });
    expect(ledger.bootId).toBe(bootId());
    expect(ledger.groups[0]!.oom).toBeDefined();
    if (process.platform === "linux" && ledger.groups[0]!.oom!.ok) {
      expect(fs.readFileSync(`/proc/${proc.child.pid}/oom_score_adj`, "utf8").trim()).toBe("500");
    }
    expect(summarizeLedger(ledger).rssKb).toBeGreaterThan(0);

    await ownership.close();
    expect(running(proc.child.pid!)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(readLedger(ledgerDir(), "normal")).toBeNull();
    await expect(ownership.release()).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    "rejects release with the original failure and keeps the ledger and result",
    async () => {
      const ownership = await Ownership.open({
        profileDir: profile,
        id: "failing",
        lifetime: "leased",
      });
      const sealed = path.join(profile, "sealed");
      fs.mkdirSync(path.join(sealed, "inner"), { recursive: true });
      await ownership.own(path.join(sealed, "inner"), "sealed");
      fs.chmodSync(sealed, 0o500);
      cleanups.push(() => fs.chmodSync(sealed, 0o700));
      const scratch = await ownership.scratch("failing-");

      const failure = await ownership.release().then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as NodeJS.ErrnoException[];
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("EACCES");
      expect((failure as { code?: string }).code).toBe("EOWNERSHIP");
      // Scratch was still removed; only the failing path is retained.
      expect(fs.existsSync(scratch)).toBe(false);
      const kept = readLedger(ledgerDir(), "failing")!;
      expect(kept.paths.map((entry) => entry.path)).toEqual([path.join(sealed, "inner")]);
      expect(readResult(ledgerDir(), "failing")!.failures[0]).toMatchObject({ code: "EACCES" });

      // The retained ledger is retried by the next sweep once the cause is repaired.
      fs.chmodSync(sealed, 0o700);
      await sweep(ledgerDir());
      expect(readLedger(ledgerDir(), "failing")).toBeNull();
      expect(fs.existsSync(resultFile(ledgerDir(), "failing"))).toBe(false);
    }
  );

  it("waits for a graceful leader to finish its shutdown, then kills only leftovers", async () => {
    const receipt = path.join(profile, "receipt");
    const script = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      spawn("sleep", ["600"], { stdio: "ignore" });
      process.on("SIGTERM", async () => {
        fs.appendFileSync(${JSON.stringify(receipt)}, "term\\n");
        for (let step = 0; step < 5; step += 1) await fs.promises.appendFile(${JSON.stringify(receipt)}, "step\\n");
        fs.appendFileSync(${JSON.stringify(receipt)}, "done\\n");
        process.exit(0);
      });
      fs.appendFileSync(${JSON.stringify(receipt)}, "started\\n");
      setInterval(() => {}, 1000);
    `;
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "graceful",
      lifetime: "leased",
    });
    const proc = ownership.spawn(process.execPath, ["-e", script], {
      kill: "graceful",
      stdio: "ignore",
    });
    await proc.registered;
    await until(
      () => fs.existsSync(receipt) && fs.readFileSync(receipt, "utf8").includes("started"),
      "workload start"
    );
    const grandchild = childrenOf(proc.child.pid!);
    expect(grandchild.length).toBeGreaterThan(0);

    await ownership.release();

    expect(fs.readFileSync(receipt, "utf8")).toBe(
      "started\nterm\nstep\nstep\nstep\nstep\nstep\ndone\n"
    );
    expect(grandchild.some(running)).toBe(false);
    expect(proc.child.exitCode).toBe(0);
  });

  it("kills an immediate resource without a shutdown request", async () => {
    const receipt = path.join(profile, "receipt");
    const script = `
      process.on("SIGTERM", () => require("node:fs").appendFileSync(${JSON.stringify(receipt)}, "term\\n"));
      require("node:fs").appendFileSync(${JSON.stringify(receipt)}, "started\\n");
      setInterval(() => {}, 1000);
    `;
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "immediate",
      lifetime: "leased",
    });
    const proc = ownership.spawn(process.execPath, ["-e", script], {
      kill: "immediate",
      stdio: "ignore",
    });
    await proc.registered;
    await until(() => fs.existsSync(receipt), "workload start");
    await ownership.release();
    expect(fs.readFileSync(receipt, "utf8")).toBe("started\n");
    expect(proc.child.signalCode).toBe("SIGKILL");
  });

  it("retires a group whose ledger became unreadable, without rewriting that file", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "unreadable",
      lifetime: "leased",
    });
    try {
      const proc = ownership.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
      await proc.registered;
      const file = ledgerFile(ledgerDir(), ownership.id);
      fs.writeFileSync(file, "{ torn");
      await proc.retire();
      await proc.retire();
      expect(running(proc.child.pid!)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("{ torn");
    } finally {
      await ownership.release();
    }
  });

  it("retires one resource early with retire() and join()", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "early",
      lifetime: "leased",
    });
    const long = ownership.spawn("sleep", ["600"], { kill: "graceful", stdio: "ignore" });
    const short = ownership.spawn("sh", ["-c", "sleep 600 & exit 0"], {
      kill: "graceful",
      stdio: "ignore",
    });
    await Promise.all([long.registered, short.registered]);
    await short.join(); // leader exits by itself; its leftover member is retired
    await long.retire();
    expect(running(long.child.pid!)).toBe(false);
    expect(readLedger(ledgerDir(), "early")!.groups).toEqual([]);
    await ownership.release();
  });

  it("runs retirement in-process and rejects waiters when the reaper is SIGKILLed", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "reaperdeath",
      lifetime: "leased",
    });
    const scratch = await ownership.scratch("reaperdeath-");
    const proc = ownership.spawn("sleep", ["600"], { kill: "graceful", stdio: "ignore" });
    await proc.registered;
    const reaperPid = readLedger(ledgerDir(), "reaperdeath")!.reaper.pid;

    process.kill(reaperPid, "SIGKILL");
    const waiter = ownership.scratch("late-");

    await expect(waiter).rejects.toMatchObject({ code: "EOWNERSHIP" });
    const lost = await new Promise<{ reaperStatus: { signal: string } }>((resolve) =>
      ownership.signal.aborted
        ? resolve(ownership.signal.reason)
        : ownership.signal.addEventListener("abort", () => resolve(ownership.signal.reason))
    );
    expect(lost.reaperStatus.signal).toBe("SIGKILL");
    await expect(ownership.release()).rejects.toMatchObject({ code: "EOWNERSHIP" });
    expect(running(proc.child.pid!)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(readLedger(ledgerDir(), "reaperdeath")).toBeNull();
  });

  it("lets a fresh sweep retire an owner and reaper that both died", async () => {
    const owner = startOwner(`
      const ownership = await Ownership.open({ profileDir: config.profileDir, id: "bothdead", lifetime: "leased" });
      const scratch = await ownership.scratch("bothdead-");
      const proc = ownership.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
      await proc.registered;
      emit("ready", { scratch, leader: proc.child.pid });
      setInterval(() => {}, 1000);
    `);
    const ready = await owner.next("ready");
    const ledger = readLedger(ledgerDir(), "bothdead")!;
    // Freeze the owner so it cannot react to the reaper's death.
    owner.kill("SIGSTOP");
    process.kill(ledger.reaper.pid, "SIGKILL");
    await until(() => !running(ledger.reaper.pid), "reaper death");
    owner.kill("SIGKILL");
    await owner.exited;
    expect(running(ready["leader"] as number)).toBe(true);

    const report = await sweep(ledgerDir());

    expect(report.retired).toEqual(["bothdead"]);
    await until(() => !running(ready["leader"] as number), "workload retired");
    expect(fs.existsSync(ready["scratch"] as string)).toBe(false);
    expect(readLedger(ledgerDir(), "bothdead")).toBeNull();
  });

  function plantLedger(id: string, patch: Partial<Ledger>): string {
    const dir = ledgerDir();
    fs.mkdirSync(dir, { recursive: true });
    const dead = spawn("true", { stdio: "ignore" });
    const gone = captureProcessStart(process.pid);
    const ledger: Ledger = {
      version: 1,
      id,
      token: `token-${id}`,
      bootId: bootId(),
      lifetime: "leased",
      state: "claimed",
      owner: gone,
      reaper: { ...gone, pid: dead.pid!, startCoordinate: "1" },
      groups: [],
      paths: [],
      meta: {},
      ...patch,
    };
    fs.writeFileSync(ledgerFile(dir, id), JSON.stringify(ledger));
    return ledgerFile(dir, id);
  }

  it("signals nothing when the recorded start coordinate no longer matches", async () => {
    const { identity } = detachedSleep();
    const target = path.join(profile, "stale-scratch");
    fs.mkdirSync(target);
    plantLedger("wrongstart", {
      groups: [
        {
          key: `${identity.pid}:1`,
          pid: identity.pid,
          identity: { ...identity, startCoordinate: "1" },
          kill: "immediate",
        },
      ],
      paths: [{ path: target, kind: "scratch" }],
    });

    await sweep(ledgerDir());

    expect(running(identity.pid)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(readLedger(ledgerDir(), "wrongstart")).toBeNull();
  });

  it("removes only paths when the ledger predates a reboot", async () => {
    const { identity } = detachedSleep();
    const target = path.join(profile, "foreign-scratch");
    fs.mkdirSync(target);
    plantLedger("foreignboot", {
      bootId: "another-boot",
      reaper: { pid: 1, startCoordinate: "1", bootId: "another-boot" },
      groups: [{ key: `${identity.pid}`, pid: identity.pid, identity, kill: "immediate" }],
      paths: [{ path: target, kind: "scratch" }],
    });

    await sweep(ledgerDir());

    expect(running(identity.pid)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(readLedger(ledgerDir(), "foreignboot")).toBeNull();
  });

  const RACE = `
    try {
      const ownership = await Ownership.open({ profileDir: config.profileDir, id: "race", lifetime: "leased" });
      emit("won");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
      await ownership.release();
      emit("released");
    } catch (error) {
      if (error instanceof OwnershipClaimedError) emit("lost");
      else { emit("error", { message: String(error) }); }
    }
  `;
  async function race(): Promise<void> {
    const racers = Array.from({ length: 8 }, () => startOwner(RACE));
    const outcomes = await Promise.all(
      racers.map(async (racer) => {
        const first = await Promise.race([
          racer.next("won").then(() => "won"),
          racer.next("lost").then(() => "lost"),
          racer.next("error").then(() => "error"),
        ]);
        return first;
      })
    );
    expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "lost")).toHaveLength(7);
    const winner = racers[outcomes.indexOf("won")]!;
    winner.child.stdin!.end();
    await winner.next("released");
    await Promise.all(racers.map((racer) => racer.exited));
  }

  it("grants a contended claim to exactly one of eight processes", async () => {
    await race();
    expect(readLedger(ledgerDir(), "race")).toBeNull();
  });

  it("grants a contended stale takeover to exactly one of eight processes", async () => {
    const target = path.join(profile, "stale-claim-scratch");
    fs.mkdirSync(target);
    plantLedger("race", { paths: [{ path: target, kind: "scratch" }] });
    await race();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("claimLedger reports a live holder to an attacher", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "held",
      lifetime: "until-stop",
    });
    const error = await Ownership.open({
      profileDir: profile,
      id: "held",
      lifetime: "leased",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnershipClaimedError);
    expect((error as OwnershipClaimedError).holder).toMatchObject({
      id: "held",
      lifetime: "until-stop",
    });
    const probe = readLedger(ledgerDir(), "held")!;
    await expect(claimLedger(ledgerDir(), probe)).resolves.toMatchObject({ claimed: false });
    await ownership.release();
  });

  it("lets a lessee see the lease end when its owner is SIGKILLed", async () => {
    const receipt = path.join(profile, "lease-receipt");
    const lessee = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      import(${JSON.stringify(new URL("./ownershipLease.mjs", import.meta.url).href)}).then(({ watchLease }) => {
        const signal = watchLease();
        signal.addEventListener("abort", () => {
          fs.writeFileSync(${JSON.stringify(receipt)}, "lost:" + signal.reason.code);
          process.exit(0);
        });
        fs.writeFileSync(${JSON.stringify(receipt + ".ready")}, "ready");
        setInterval(() => {}, 1000);
      });
    `;
    const owner = startOwner(
      `
      const ownership = await Ownership.open({ profileDir: config.profileDir, id: "lease", lifetime: "leased" });
      const proc = ownership.spawn(process.execPath, ["-e", config.lessee], { kill: "graceful", lease: true, stdio: "ignore" });
      await proc.registered;
      emit("ready", { pid: proc.child.pid });
      setInterval(() => {}, 1000);
    `,
      { lessee }
    );
    const ready = await owner.next("ready");
    await until(() => fs.existsSync(receipt + ".ready"), "lessee watching");

    owner.kill("SIGKILL");

    await until(() => fs.existsSync(receipt), "lease loss observed");
    expect(fs.readFileSync(receipt, "utf8")).toBe("lost:EOWNERSHIP");
    await until(() => !running(ready["pid"] as number), "lessee exit");
    await until(() => readLedger(ledgerDir(), "lease") === null, "ledger retired");
  });

  it("refuses a lease watch in a process that holds none", () => {
    expect(() => watchLease()).toThrow(/no lease/);
    expect(watchLease({ optional: true }).aborted).toBe(false);
  });

  it("never leaves a plain-file shipment: the reaper imports only relative sibling .mjs files", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const graph = (entry: string): Set<string> => {
      const seen = new Set<string>();
      const visit = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        const source = fs.readFileSync(path.join(here, name), "utf8");
        expect(source, `${name} must not require()`).not.toMatch(/\brequire\s*\(/u);
        const specifiers = [
          ...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gu),
          ...source.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/gu),
          ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/gu),
        ].map((match) => match[2]!);
        for (const specifier of specifiers) {
          if (specifier.startsWith("node:")) continue;
          expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\/[A-Za-z0-9]+\.mjs$/u);
          visit(specifier.slice(2));
        }
      };
      visit(entry);
      return seen;
    };
    expect([...graph("reaper.mjs")].sort()).toEqual([...OWNERSHIP_REAPER_FILES].sort());
    expect([...graph("ownership.mjs")].sort()).toEqual(
      [...OWNERSHIP_CLIENT_FILES].filter((name) => name !== "reaper.mjs").sort()
    );
    for (const name of OWNERSHIP_CLIENT_FILES) {
      expect(fs.existsSync(path.join(here, name)), name).toBe(true);
    }
  });

  describe("reaper spawn plan", () => {
    const base = { reaperPath: "/shipped/reaper.mjs", config: { id: "x" } };
    const env = {
      PATH: "/bin",
      NODE_OPTIONS: "--import tsx",
      VIBESTUDIO_LEASE_FD: "3",
      ELECTRON_RUN_AS_NODE: "stale",
    };

    it("runs the reaper as Node under Electron, in the reaper's environment only", () => {
      const plan = buildReaperSpawn({
        ...base,
        execPath: "/opt/App/electron",
        versions: { electron: "40.0.0" },
        platform: "linux",
        env,
      });
      expect(plan.command).toBe("/opt/App/electron");
      expect(plan.args).toEqual(["/shipped/reaper.mjs", JSON.stringify({ id: "x" })]);
      expect(plan.options.env).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
      expect(plan.options).toMatchObject({
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      // The owner's own environment (what workloads inherit) is untouched.
      expect(env.ELECTRON_RUN_AS_NODE).toBe("stale");
    });

    it("does not set the Electron flag for plain Node, and is not detached on Windows", () => {
      const plan = buildReaperSpawn({
        ...base,
        execPath: "/usr/bin/node",
        versions: {},
        platform: "win32",
        env,
      });
      expect(plan.command).toBe("/usr/bin/node");
      expect(plan.options.env).toEqual({ PATH: "/bin" });
      expect(plan.options.detached).toBe(false);
    });

    it("does not leak the flag into workload children spawned by an owner", async () => {
      const ownership = await Ownership.open({
        profileDir: profile,
        id: "envleak",
        lifetime: "leased",
      });
      const receipt = path.join(profile, "env-receipt");
      const proc = ownership.spawn(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([process.env.ELECTRON_RUN_AS_NODE ?? null, process.env.VIBESTUDIO_LEASE_FD ?? null]))`,
        ],
        { kill: "graceful", stdio: "ignore", env: { ...process.env, VIBESTUDIO_LEASE_FD: "9" } }
      );
      await proc.join();
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual([
        process.env["ELECTRON_RUN_AS_NODE"] ?? null,
        null,
      ]);
      await ownership.release();
    });

    it("fails clearly when the reaper is not shipped where it is expected", async () => {
      await expect(
        Ownership.open({
          profileDir: profile,
          id: "noreaper",
          lifetime: "leased",
          reaperPath: path.join(profile, "missing", "reaper.mjs"),
        })
      ).rejects.toMatchObject({ code: "EOWNERSHIP", message: /not at .*reaper\.mjs/u });
    });
  });

  it("spawnDetached registers a group that outlives release, owner death and sweeps", async () => {
    const owner = startOwner(`
      const ownership = await Ownership.open({ profileDir: config.profileDir, id: "handoff", lifetime: "leased" });
      const proc = ownership.spawnDetached("sleep", ["600"]);
      await proc.registered;
      emit("ready", { leader: proc.child.pid, token: ownership.token });
      setInterval(() => {}, 1000);
    `);
    const ready = await owner.next("ready");
    const leader = ready["leader"] as number;
    cleanups.push(() => {
      try {
        process.kill(-leader, "SIGKILL");
      } catch {
        // already gone
      }
    });
    const ledger = readLedger(ledgerDir(), "handoff")!;
    expect(ledger.groups).toMatchObject([{ pid: leader, outlives: true }]);
    expect(ledger.groups[0]!.oom).toBeUndefined();

    owner.kill("SIGKILL");
    await until(() => readLedger(ledgerDir(), "handoff") === null, "reaper retired the ledger");

    expect(running(leader)).toBe(true);
    await sweep(ledgerDir());
    expect(running(leader)).toBe(true);
  });

  it("spawnDetached survives an orderly release and is not awaited by it", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "handoff-release",
      lifetime: "until-stop",
    });
    const handedOver = ownership.spawnDetached("sleep", ["600"]);
    const workload = ownership.spawn("sleep", ["600"], { kill: "immediate", stdio: "ignore" });
    await Promise.all([handedOver.registered, workload.registered]);
    cleanups.push(() => process.kill(-handedOver.child.pid!, "SIGKILL"));
    expect(() => ownership.spawnDetached("sleep", ["1"], { lease: true } as never)).toThrow(
      /lease/u
    );

    await ownership.release();

    expect(running(workload.child.pid!)).toBe(false);
    expect(running(handedOver.child.pid!)).toBe(true);
    expect(readLedger(ledgerDir(), "handoff-release")).toBeNull();
  });

  it("awaitRetirement with a token does not wait on a successor that reused the id", async () => {
    const first = await Ownership.open({ profileDir: profile, id: "reused", lifetime: "leased" });
    const token = first.token;
    expect(readLedger(ledgerDir(), "reused")!.token).toBe(token);
    await first.release();
    const second = await Ownership.open({ profileDir: profile, id: "reused", lifetime: "leased" });
    expect(second.token).not.toBe(token);

    await expect(awaitRetirement(ledgerDir(), "reused", { token })).resolves.toBeUndefined();
    const unfenced = await Promise.race([
      awaitRetirement(ledgerDir(), "reused").then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 300)),
    ]);
    expect(unfenced).toBe("still waiting");

    const retired = awaitRetirement(ledgerDir(), "reused", { token: second.token });
    await second.release();
    await expect(retired).resolves.toBeUndefined();
  });

  it("adopts a running detached child so release retires its group", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "adopt",
      lifetime: "leased",
    });
    const foreign = track(
      spawn("sh", ["-c", "sleep 600 & echo $!; wait"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
    const grandchild = await new Promise<number>((resolve) =>
      foreign.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString())))
    );
    const adopted = ownership.adopt(foreign, { kill: "immediate", label: "foreign" });
    await adopted.registered;
    expect(adopted.identity).toMatchObject({ pid: foreign.pid });
    expect(readLedger(ledgerDir(), "adopt")!.groups).toMatchObject([
      { pid: foreign.pid, label: "foreign" },
    ]);

    await ownership.release();

    expect(running(foreign.pid!)).toBe(false);
    expect(running(grandchild)).toBe(false);
    expect(readLedger(ledgerDir(), "adopt")).toBeNull();
  });

  it("refuses to adopt a child that is not its own group leader, registering and killing nothing", async () => {
    const ownership = await Ownership.open({
      profileDir: profile,
      id: "adopt-refused",
      lifetime: "leased",
    });
    const attached = track(spawn("sleep", ["600"], { stdio: "ignore" }));
    expect(() => ownership.adopt(attached, { kill: "immediate" })).toThrow(/process-group leader/u);
    expect(running(attached.pid!)).toBe(true);
    expect(readLedger(ledgerDir(), "adopt-refused")!.groups).toEqual([]);
    await ownership.release();
  });

  /** A real, unprovable retirement failure: a receipt from another platform. */
  function foreignPlatformGroup(): Ledger["groups"][number] {
    const { identity } = detachedSleep();
    const foreign = { ...identity, platform: process.platform === "linux" ? "darwin" : "linux" };
    return {
      key: `${identity.pid}:foreign`,
      pid: identity.pid,
      identity: foreign as unknown as OwnedProcessIdentity,
      kill: "immediate",
    };
  }

  it("keeps scratch, ledger and failure when a group cannot be retired", async () => {
    const scratch = path.join(profile, "kept-scratch");
    const owned = path.join(profile, "kept-owned");
    fs.mkdirSync(scratch);
    fs.mkdirSync(owned);
    const group = foreignPlatformGroup();
    const file = plantLedger("stuck", {
      groups: [group],
      paths: [
        { path: scratch, kind: "scratch" },
        { path: owned, kind: "path" },
      ],
    });

    const failure = await sweep(ledgerDir()).then(
      () => null,
      (error: unknown) => error as AggregateError
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(fs.existsSync(scratch)).toBe(true);
    expect(fs.existsSync(owned)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    const kept = readLedger(ledgerDir(), "stuck")!;
    expect(kept.groups.map((entry) => entry.key)).toEqual([group.key]);
    expect(kept.paths.map((entry) => entry.path)).toEqual([scratch, owned]);
    const result = readResult(ledgerDir(), "stuck")!;
    expect(result.failures[0]).toMatchObject({ code: "EOWNERSHIP" });
    expect(running(group.pid)).toBe(true);
    // `stop` (awaitRetirement) rethrows the recorded failure.
    await expect(awaitRetirement(ledgerDir(), "stuck")).rejects.toMatchObject({
      code: "EOWNERSHIP",
      ledgerId: "stuck",
    });
    expect(failureError(result).errors).toHaveLength(result.failures.length);
  });

  it("removes paths of a ledger only after its groups are proven gone, retrying later", async () => {
    const scratch = path.join(profile, "later-scratch");
    fs.mkdirSync(scratch);
    const failing = foreignPlatformGroup();
    const fine = detachedSleep();
    const fineGroup = {
      key: `${fine.identity.pid}:${fine.identity.startCoordinate}`,
      pid: fine.identity.pid,
      identity: fine.identity,
      kill: "immediate" as const,
    };
    const ledger: Ledger = {
      ...(JSON.parse(fs.readFileSync(plantLedger("later", {}), "utf8")) as Ledger),
      groups: [failing, fineGroup],
      paths: [{ path: scratch, kind: "scratch" }],
    };

    await expect(retireLedger(ledger, { dir: ledgerDir() })).rejects.toMatchObject({
      code: "EOWNERSHIP",
    });
    await until(() => !running(fine.identity.pid), "healthy group retired");
    expect(fs.existsSync(scratch)).toBe(true);
    // Only the group that failed remains recorded.
    expect(readLedger(ledgerDir(), "later")!.groups.map((entry) => entry.key)).toEqual([
      failing.key,
    ]);

    // Repair (the failing group's process ends), then a retry removes everything.
    const repaired: Ledger = { ...ledger, groups: [] };
    fs.writeFileSync(ledgerFile(ledgerDir(), "later"), JSON.stringify(repaired));
    await retireLedger(repaired, { dir: ledgerDir() });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(readLedger(ledgerDir(), "later")).toBeNull();
    expect(readResult(ledgerDir(), "later")).toBeNull();
  });

  it("does not signal a group marked outlives when retiring a ledger", async () => {
    const { identity } = detachedSleep();
    const scratch = path.join(profile, "outlives-scratch");
    fs.mkdirSync(scratch);
    plantLedger("outlives", {
      groups: [
        {
          key: `${identity.pid}:${identity.startCoordinate}`,
          pid: identity.pid,
          identity,
          kill: "immediate",
          outlives: true,
        },
      ],
      paths: [{ path: scratch, kind: "scratch" }],
    });

    await sweep(ledgerDir());

    expect(running(identity.pid)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(readLedger(ledgerDir(), "outlives")).toBeNull();
  });

  it("reports a spawn that never starts once: to its observer, else at release", async () => {
    const observed = await Ownership.open({
      profileDir: profile,
      id: "nostart-observed",
      lifetime: "leased",
    });
    const missing = observed.spawn("/nonexistent/vibestudio-binary", [], {
      kill: "immediate",
      stdio: "ignore",
    });
    await expect(missing.registered).rejects.toMatchObject({ code: "ENOENT" });
    await expect(observed.release()).resolves.toBeUndefined();

    const unobserved = await Ownership.open({
      profileDir: profile,
      id: "nostart-unobserved",
      lifetime: "leased",
    });
    unobserved.spawn("/nonexistent/vibestudio-binary", [], { kill: "immediate", stdio: "ignore" });
    const failure = await unobserved.release().then(
      () => null,
      (error: unknown) => error as AggregateError
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure!.errors).toHaveLength(1);
    expect((failure!.errors[0] as NodeJS.ErrnoException).code).toBe("ENOENT");

    const joined = await Ownership.open({
      profileDir: profile,
      id: "nostart-joined",
      lifetime: "leased",
    });
    const gone = joined.spawn("/nonexistent/vibestudio-binary", [], {
      kill: "immediate",
      stdio: "ignore",
    });
    await expect(gone.join()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(joined.release()).resolves.toBeUndefined();
  });

  it("summarizeLedger never throws for a group that died, is dying or cannot be observed", async () => {
    const dead = detachedSleep();
    const live = detachedSleep();
    const ledger = (identity: OwnedProcessIdentity): Ledger =>
      ({
        ...(JSON.parse(fs.readFileSync(plantLedger("summary", {}), "utf8")) as Ledger),
        groups: [
          { key: `${identity.pid}`, pid: identity.pid, identity, kill: "immediate" },
          {
            key: "foreign",
            pid: 1,
            identity: {
              ...identity,
              platform: "darwin",
              pid: 1,
            } as unknown as OwnedProcessIdentity,
            kill: "immediate",
          },
          { key: "none", pid: 2, identity: null, kill: "immediate" },
        ],
      }) as Ledger;
    process.kill(-dead.child.pid!, "SIGKILL");
    await until(() => !running(dead.child.pid!), "death");
    const summary = summarizeLedger(ledger(dead.identity));
    expect(summary.rssKb).toBe(0);
    expect(summary.groups.map((group) => group.observed)).toEqual([true, false, false]);

    // Summaries taken while the group is being killed never throw.
    const racing = ledger(live.identity);
    setTimeout(() => process.kill(-live.child.pid!, "SIGKILL"), 5);
    for (let round = 0; round < 200; round += 1) {
      expect(() => summarizeLedger(racing)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("OwnedScope runs every cleanup and aggregates the original failures", async () => {
    const scope = new OwnedScope();
    const order: string[] = [];
    const first = new Error("first");
    const second = new Error("second");
    const tracked = new Error("tracked");
    scope.defer(() => order.push("a"));
    scope.defer(() => {
      throw first;
    });
    scope.defer(async () => {
      order.push("c");
      throw second;
    });
    void scope.track(Promise.reject(tracked));
    const failure = await scope.close().then(
      () => null,
      (error: unknown) => error as AggregateError & { code: string }
    );
    expect(order).toEqual(["c", "a"]);
    expect(failure!.code).toBe("EOWNERSHIP");
    expect(failure!.errors).toEqual(expect.arrayContaining([first, second, tracked]));
    await expect(scope.close()).rejects.toBe(failure);
  });
});

/** Pids whose parent is `pid` (the workload's own children). */
function childrenOf(pid: number): number[] {
  return fs
    .readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((candidate) => {
      try {
        const raw = fs.readFileSync(`/proc/${candidate}/stat`, "utf8");
        return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[1]) === pid;
      } catch {
        return false;
      }
    });
}
