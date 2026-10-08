import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe.runIf(process.env["VIBESTUDIO_RUN_COOKIE_ELECTRON_NATIVE"] === "1")(
  "native cookie import",
  () => {
    it("applies a session cookie without reloading pages and restores it after an Electron restart", async () => {
      const root = await mkdtemp(
        path.join(process.env["HOME"]!, ".cache", "vibestudio-cookie-native-")
      );
      try {
        const main = path.join(root, "main.cjs");
        await build({
          entryPoints: ["tests/fixtures/browser-cookie-import-native.ts"],
          outfile: main,
          bundle: true,
          platform: "node",
          format: "cjs",
          external: ["electron"],
        });
        for (const phase of ["import", "restart"]) {
          const executable =
            process.env["VIBESTUDIO_COOKIE_ELECTRON"] ?? createRequire(import.meta.url)("electron");
          const child = spawn(executable, [main], {
            detached: true,
            env: {
              ...process.env,
              VIBESTUDIO_COOKIE_NATIVE_ROOT: root,
              VIBESTUDIO_COOKIE_NATIVE_PHASE: phase,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          const output: Buffer[] = [];
          const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              // The test runner bounds diagnostics and joins the child; production recovery uses lifecycle events.
              const deadline = setTimeout(() => {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
              }, 20_000);
              child.stdout.on("data", (chunk) => output.push(chunk));
              child.stderr.on("data", (chunk) => output.push(chunk));
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
          const evidence = Buffer.concat(output).toString();
          expect(result, evidence).toEqual({ code: 0, signal: null });
          expect(evidence).toContain(
            JSON.stringify({
              phase,
              authenticated: true,
              sourceReads: phase === "import" ? 1 : 0,
              isolated: true,
            })
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 50_000);
  }
);
