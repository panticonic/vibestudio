import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe.runIf(process.env["VIBESTUDIO_RUN_CDP_ELECTRON_NATIVE"] === "1")(
  "native Electron compositor readiness",
  () => {
    it("delivers exactly one trusted click before and after covered-panel navigation", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "vibestudio-cdp-electron-"));
      try {
        const main = path.join(root, "main.cjs");
        await build({
          entryPoints: ["tests/fixtures/cdp-electron-native.ts"],
          outfile: main,
          bundle: true,
          platform: "node",
          format: "cjs",
          external: ["electron"],
        });
        const require = createRequire(import.meta.url);
        const executable = process.env["VIBESTUDIO_CDP_ELECTRON"] ?? require("electron");
        const output: Buffer[] = [];
        const child = spawn(executable, [main], {
          detached: process.platform !== "win32",
          env: { ...process.env, VIBESTUDIO_CDP_NATIVE_PROFILE: path.join(root, "profile") },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            const deadline = setTimeout(() => {
              if (process.platform === "win32") child.kill("SIGKILL");
              else if (child.pid) process.kill(-child.pid, "SIGKILL");
            }, 20_000);
            child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
            child.once("error", (error) => {
              clearTimeout(deadline);
              reject(error);
            });
            child.once("close", (code, signal) => {
              clearTimeout(deadline);
              resolve({ code, signal });
            });
          }
        );
        expect(result, Buffer.concat(output).toString()).toEqual({ code: 0, signal: null });
        expect(Buffer.concat(output).toString()).toContain(
          JSON.stringify({ initialTrustedClicks: 1, rebuiltTrustedClicks: 1 })
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
);
