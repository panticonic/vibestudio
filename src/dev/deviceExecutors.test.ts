import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachDeviceDrivers, type DeviceExecutorSpec } from "./deviceExecutors.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "device-executors-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

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
        repoRoot: root,
        instanceId: "x",
        kinds: ["terminal", "desktop"],
        specs,
        log: () => undefined,
      })
    ).rejects.toThrow(/desktop device driver exited before it registered \(3\)[\s\S]*no display/u);
  });

  it("reports a driver that stops uncleanly", async () => {
    const specs = {
      terminal: {
        ...ready("terminal"),
        script: script(
          "stubborn.mjs",
          `process.on("SIGTERM", () => process.exit(7)); console.log("terminal ready"); setInterval(() => {}, 1 << 30);`
        ),
      },
      desktop: ready("desktop"),
    };
    const attached = await attachDeviceDrivers({
      repoRoot: root,
      instanceId: "x",
      kinds: ["terminal"],
      specs,
      log: () => undefined,
    });
    await expect(attached.stop()).rejects.toThrow(/did not stop cleanly \(7\)/u);
  });
});
