import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ownership } from "@vibestudio/shared/ownership";
import { describe, expect, it } from "vitest";
import { IROH_CONCURRENT_BI_STREAM_WINDOW } from "../packages/iroh-transport/src/nodeEndpoint.js";

const RUN = process.env["VIBESTUDIO_RUN_IROH_E2E"] === "1" && process.platform === "linux";
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const fixturePath = fileURLToPath(new URL("./fixtures/iroh-electron-native.cjs", import.meta.url));

interface FixtureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

async function runElectronFixture(): Promise<FixtureResult> {
  // The fixture's group is registered with a reaper before anything else runs,
  // so even a killed test run leaves no Electron behind.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-iroh-electron-"));
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  try {
    return await new Promise<FixtureResult>((resolve, reject) => {
      // The fixture's Xvfb process owns its X11 display. An inherited Wayland
      // session can otherwise strand Electron before app readiness.
      const env = { ...process.env };
      delete env["WAYLAND_DISPLAY"];
      delete env["XDG_SESSION_TYPE"];
      const owned = ownership.spawn("xvfb-run", ["-a", electronPath, "--no-sandbox", fixturePath], {
        cwd: process.cwd(),
        kill: "immediate",
        env: {
          ...env,
          ELECTRON_DISABLE_GPU: "1",
          ELECTRON_DISABLE_SANDBOX: "1",
          VIBESTUDIO_TEST_IROH_STREAM_WINDOW: IROH_CONCURRENT_BI_STREAM_WINDOW.toString(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const child = owned.child;
      const output: Buffer[] = [];
      let timeoutError: Error | null = null;
      child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      // The test runner bounds this investigation; the deadline retires the
      // whole fixture group and the close event below joins it.
      const timeout = setTimeout(() => {
        timeoutError = new Error(
          `Electron Iroh fixture timed out\n${Buffer.concat(output).toString("utf8")}`
        );
        owned.retire("immediate").catch(reject);
      }, 30_000);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (timeoutError) {
          reject(timeoutError);
          return;
        }
        resolve({ code, signal, output: Buffer.concat(output).toString("utf8") });
      });
    });
  } finally {
    try {
      await ownership.close();
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

describe.runIf(RUN)("Iroh Electron native transport", () => {
  it("keeps the Electron allocator healthy beside production startup fan-out", async () => {
    const result = await runElectronFixture();
    expect(result, result.output).toMatchObject({ code: 0, signal: null });
    expect(result.output).toContain(
      JSON.stringify({
        streamWindow: IROH_CONCURRENT_BI_STREAM_WINDOW.toString(),
        heldStreams: 320,
      })
    );
  }, 35_000);
});
