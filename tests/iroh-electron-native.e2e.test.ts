import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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

function runElectronFixture(): Promise<FixtureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("xvfb-run", ["-a", electronPath, "--no-sandbox", fixturePath], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: "1",
        ELECTRON_DISABLE_SANDBOX: "1",
        VIBESTUDIO_TEST_IROH_STREAM_WINDOW: IROH_CONCURRENT_BI_STREAM_WINDOW.toString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let timeoutError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    const timeout = setTimeout(() => {
      timeoutError = new Error(
        `Electron Iroh fixture timed out\n${Buffer.concat(output).toString("utf8")}`,
      );
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      }
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
