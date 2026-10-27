import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ownership } from "@vibestudio/shared/ownership";
import { ownedEntry, retireOnAbort, withOwnership } from "../scripts/lib/owned-entry.mjs";

const linux = process.platform === "linux";
const ENTRY_URL = pathToFileURL(path.resolve("scripts/lib/owned-entry.mjs")).href;

let profile: string;
let runner: Ownership | undefined;
beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "owned-entry-test-"));
});
afterEach(async () => {
  try {
    await runner?.release();
  } finally {
    runner = undefined;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

function running(pid: number): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2, raw.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** The kernel decides when a retirement is observable; the test runner bounds this. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 25));
}

interface Ready {
  workPid: number;
  scratchRoot: string;
  appRoot: string;
}

/** Run an `ownedEntry` script as an owned child of the test, in its own profile. */
async function launchEntry(body: string) {
  const script = path.join(profile, "entry.mjs");
  fs.writeFileSync(
    script,
    `
    import { once } from "node:events";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { ownedEntry } from ${JSON.stringify(ENTRY_URL)};
    await ownedEntry(async ({ signal, ownership, scratchRoot }) => {
      ${body}
    }, { appRoot: ${JSON.stringify(path.resolve("."))}, scratchPrefix: "oe-" });
  `
  );
  runner = await Ownership.open({ profileDir: path.join(profile, "runner"), lifetime: "leased" });
  const run = runner.spawn(process.execPath, [script], {
    kill: "immediate",
    env: { ...process.env, VIBESTUDIO_PROFILE_ROOT: path.join(profile, "entry-profile") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  run.child.stdout!.on("data", (chunk) => (output += chunk));
  let errors = "";
  run.child.stderr!.on("data", (chunk) => (errors += chunk));
  const ready = new Promise<Ready>((resolve, reject) => {
    run.child.stdout!.on("data", () => {
      const line = output.split("\n").find((entry) => entry.startsWith('{"ready":true'));
      if (line) resolve(JSON.parse(line));
    });
    run.child.once("exit", (code) => reject(new Error(`Entry exited ${code}: ${errors}`)));
  });
  return { run, ready, output: () => output, errors: () => errors };
}

const READY_BODY = `
      const work = ownership.spawn(
        process.execPath,
        ["-e", "console.log('up'); setInterval(() => {}, 1000)"],
        { kill: "immediate", stdio: ["ignore", "pipe", "inherit"] }
      );
      await once(work.child.stdout, "data");
      writeFileSync(join(scratchRoot, "state"), "owned");
      console.log(JSON.stringify({ ready: true, workPid: work.child.pid, scratchRoot, appRoot: process.env.VIBESTUDIO_APP_ROOT }));
`;

describe.skipIf(!linux)("ownedEntry as a script entry", () => {
  it("keeps repeated stop signals actionable throughout release", async () => {
    const entry = await launchEntry(`
      const work = ownership.spawn(process.execPath, ["-e", \
        "process.on('SIGTERM', () => console.log('stopping')); console.log('ready'); setInterval(() => {}, 1000)"],
        { kill: "graceful", stdio: ["ignore", "pipe", "inherit"] });
      await once(work.child.stdout, "data");
      work.child.stdout.on("data", () => console.log("retirement-started"));
      console.log(JSON.stringify({ ready: true, workPid: work.child.pid, scratchRoot }));
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
    `);
    const ready = await entry.ready;
    const exited = once(entry.run.child, "exit");
    entry.run.child.kill("SIGTERM");
    await until(() => entry.output().includes("retirement-started"));
    entry.run.child.kill("SIGINT");
    expect(await exited).toEqual([143, null]);
    expect(running(ready.workPid)).toBe(false);
    expect(fs.existsSync(ready.scratchRoot)).toBe(false);
  });

  it("turns SIGTERM into an abort, then retires children and scratch before exiting 143", async () => {
    const entry = await launchEntry(`${READY_BODY}
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      console.log("main saw " + signal.reason.code + " " + signal.reason.signal);
    `);
    const ready = await entry.ready;
    expect(ready.appRoot).toBe(path.resolve("."));
    // Scratch lives under the profile (disk-backed), never in /tmp.
    expect(ready.scratchRoot.startsWith(path.join(profile, "entry-profile", "ownership"))).toBe(
      true
    );
    expect(fs.readFileSync(path.join(ready.scratchRoot, "state"), "utf8")).toBe("owned");
    const exited = once(entry.run.child, "exit");
    entry.run.child.kill("SIGTERM");
    expect(await exited).toEqual([143, null]);
    expect(entry.output()).toContain("main saw ESTOP SIGTERM");
    expect(running(ready.workPid)).toBe(false);
    expect(fs.existsSync(ready.scratchRoot)).toBe(false);
  });

  it("retires children and scratch through its own reaper after SIGKILL", async () => {
    const entry = await launchEntry(`${READY_BODY}
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
    `);
    const ready = await entry.ready;
    const exited = once(entry.run.child, "exit");
    entry.run.child.kill("SIGKILL");
    await exited;
    await until(() => !running(ready.workPid) && !fs.existsSync(ready.scratchRoot));
    expect(running(ready.workPid)).toBe(false);
  });

  it("reports the original failure of main after retiring", async () => {
    const entry = await launchEntry(`${READY_BODY}
      throw new Error("the original failure");
    `);
    const ready = await entry.ready.catch(() => undefined);
    const [code] = (await once(entry.run.child, "exit")) as [number];
    expect(code).toBe(1);
    expect(entry.errors()).toContain("the original failure");
    if (ready) expect(fs.existsSync(ready.scratchRoot)).toBe(false);
  });
});

describe("ownedEntry in process", () => {
  it("resolves with main's value and removes its scratch", async () => {
    let scratch = "";
    const value = await ownedEntry(
      async ({ scratchRoot, ownership }) => {
        scratch = scratchRoot!;
        fs.writeFileSync(path.join(scratch, "file"), "x");
        expect(ownership.profileDir).toBe(profile);
        return 42;
      },
      { profileDir: profile, scratchPrefix: "inproc-" }
    );
    expect(value).toBe(42);
    expect(scratch.startsWith(path.join(profile, "ownership", "scratch"))).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("propagates the original error of main", async () => {
    const original = new Error("main failed");
    await expect(
      ownedEntry(
        async () => {
          throw original;
        },
        { profileDir: profile }
      )
    ).rejects.toBe(original);
  });

  it.skipIf(!linux)("retireOnAbort retires an owned child when the signal aborts", async () => {
    await withOwnership(
      async (ownership) => {
        const owned = ownership.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          kill: "immediate",
          stdio: "ignore",
        });
        await owned.registered;
        const controller = new AbortController();
        retireOnAbort(ownership, controller.signal, owned);
        expect(running(owned.child.pid!)).toBe(true);
        controller.abort();
        await once(owned.child, "exit");
        await owned.join();
        expect(running(owned.child.pid!)).toBe(false);
      },
      { profileDir: profile }
    );
  });
});
