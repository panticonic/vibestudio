import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ownership } from "@vibestudio/shared/ownership";
import { attachDeviceDrivers, type DeviceExecutorSpec } from "./deviceExecutors.js";

let root: string;
let ownership: Ownership;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "device-executors-"));
  ownership = await Ownership.open({ profileDir: path.join(root, "profile"), lifetime: "leased" });
});
afterEach(async () => {
  await ownership.release();
  fs.rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function script(name: string, body: string): string {
  fs.writeFileSync(path.join(root, name), body);
  return name;
}

const ready = (kind: string) => ({ script: "", ready: new RegExp(`${kind} ready`, "u") });

describe("attachDeviceDrivers", () => {
  it("returns once every driver announced itself and stops them on request", async () => {
    const serve = (kind: string) =>
      script(
        `${kind}.mjs`,
        `process.on("SIGTERM", () => process.exit(0)); console.log("${kind} ready"); setInterval(() => {}, 1 << 30);`
      );
    const specs = {
      terminal: { ...ready("terminal"), script: serve("terminal") },
      desktop: { ...ready("desktop"), script: serve("desktop") },
    } satisfies Record<string, DeviceExecutorSpec>;
    const lines: string[] = [];
    const attached = await attachDeviceDrivers({
      ownership,
      repoRoot: root,
      instanceId: "x",
      kinds: ["terminal", "desktop"],
      specs,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes("terminal ready"))).toBe(true);
    await attached.stop();
  });

  it("fails with the driver's output when it exits before registering, and stops the others", async () => {
    const specs = {
      terminal: {
        ...ready("terminal"),
        script: script(
          "ok.mjs",
          `process.on("SIGTERM", () => process.exit(0)); console.log("terminal ready"); setInterval(() => {}, 1 << 30);`
        ),
      },
      desktop: {
        ...ready("desktop"),
        script: script("bad.mjs", `console.error("no display"); process.exit(3);`),
      },
    };
    await expect(
      attachDeviceDrivers({
        ownership,
        repoRoot: root,
        instanceId: "x",
        kinds: ["terminal", "desktop"],
        specs,
        log: () => undefined,
      })
    ).rejects.toThrow(/desktop device driver exited before it registered \(3\)[\s\S]*no display/u);
  });

  it("kills a driver at once, even one that ignores the request to stop", async () => {
    const pidFile = path.join(root, "stubborn.pid");
    const specs = {
      terminal: {
        ...ready("terminal"),
        script: script(
          "stubborn.mjs",
          `import fs from "node:fs"; process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log("terminal ready"); setInterval(() => {}, 1 << 30);`
        ),
      },
      desktop: ready("desktop"),
    };
    const attached = await attachDeviceDrivers({
      ownership,
      repoRoot: root,
      instanceId: "x",
      kinds: ["terminal"],
      specs,
      log: () => undefined,
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    await attached.stop();
    expect(alive(pid)).toBe(false);
  });

  it("reports a driver that ended on its own after registering", async () => {
    const pidFile = path.join(root, "dying.pid");
    const specs = {
      terminal: {
        ...ready("terminal"),
        script: script(
          "dying.mjs",
          `import fs from "node:fs"; console.log("terminal ready"); setTimeout(() => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.exit(7); }, 50);`
        ),
      },
      desktop: ready("desktop"),
    };
    const attached = await attachDeviceDrivers({
      ownership,
      repoRoot: root,
      instanceId: "x",
      kinds: ["terminal"],
      specs,
      log: () => undefined,
    });
    await expect.poll(() => fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await expect.poll(() => alive(pid)).toBe(false);
    await expect(attached.stop()).rejects.toThrow(/ended on its own \(7\)/u);
  });
});
