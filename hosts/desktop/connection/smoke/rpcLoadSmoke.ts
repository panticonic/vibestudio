/**
 * Measures the Electron main process's event-loop delay while client windows
 * drive RPCs through their ports (docs/client-hosts-and-clients-plan.md
 * section 5.1.1; budget: main-loop p99 <= 5 ms under RPC load).
 *
 *   pnpm exec tsx hosts/desktop/connection/smoke/rpcLoadSmoke.ts
 *
 * It runs the production path end to end (preload port transport, the port
 * broker, the control channel, the connection process's renderer sessions) with
 * an echoing server in place of a hub, in a real Electron under a virtual
 * display when none is present. The temporary bundle directory it creates is
 * removed before it exits, whatever the outcome.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const require = createRequire(import.meta.url);

const P99_BUDGET_MS = 5;
const WINDOWS = 3;
const RPCS_PER_WINDOW = 20_000;
const PAYLOAD_BYTES = 16 * 1024;
const IN_FLIGHT = 32;

function bundle(entry: string, outfile: string): Promise<unknown> {
  return esbuild.build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron", "esbuild", "@number0/iroh"],
    tsconfig: path.join(repoRoot, "tsconfig.json"),
    logLevel: "error",
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rpc-load-"));
  try {
    const utilityEntry = path.join(scratch, "utility.cjs");
    const mainEntry = path.join(scratch, "main.cjs");
    const preload = path.join(scratch, "preload.cjs");
    const resultPath = path.join(scratch, "result.json");
    await Promise.all([
      bundle("hosts/desktop/connection/smoke/loadHarnessConnection.ts", utilityEntry),
      bundle("hosts/desktop/connection/smoke/loadHarnessMain.ts", mainEntry),
      bundle("hosts/desktop/preload/clientPreload.ts", preload),
    ]);
    fs.copyFileSync(path.join(here, "loadHarnessPage.html"), path.join(scratch, "page.html"));
    fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ main: "main.cjs" }));
    const plan = {
      utilityEntry,
      preload,
      page: path.join(scratch, "page.html"),
      windows: WINDOWS,
      rpcsPerWindow: RPCS_PER_WINDOW,
      payloadBytes: PAYLOAD_BYTES,
      inFlight: IN_FLIGHT,
      resultPath,
    };
    const electron = require("electron") as string;
    const hasDisplay = Boolean(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]);
    const electronArgs = ["--no-sandbox", scratch];
    const env = { ...process.env, RPC_LOAD_PLAN: JSON.stringify(plan) };
    const code = hasDisplay
      ? await run(electron, electronArgs, env)
      : await run("xvfb-run", ["-a", electron, ...electronArgs], env);
    if (code !== 0 || !fs.existsSync(resultPath)) {
      throw new Error(`The Electron smoke exited with code ${code} without a result`);
    }
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      electron: string;
      idle: { p50: number; p99: number; max: number; samples: number };
      loaded: { p50: number; p99: number; max: number; samples: number };
      perWindow: { rpcs: number; elapsedMs: number; p50: number; p99: number }[];
    };
    const total = result.perWindow.reduce((sum, window) => sum + window.rpcs, 0);
    console.log(
      JSON.stringify(
        {
          electron: result.electron,
          windows: WINDOWS,
          totalRpcs: total,
          payloadBytes: PAYLOAD_BYTES,
          mainLoopLagMs: { idle: result.idle, underRpcLoad: result.loaded },
          perWindowRpc: result.perWindow,
          budgetP99Ms: P99_BUDGET_MS,
        },
        null,
        2
      )
    );
    if (result.loaded.p99 > P99_BUDGET_MS) {
      throw new Error(
        `Main-loop p99 ${result.loaded.p99} ms exceeds the ${P99_BUDGET_MS} ms budget under RPC load`
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
