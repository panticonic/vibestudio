import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPnpmInvocation } from "./cli/lib/package-manager.mjs";

const dependencyContracts = [
  {
    packageName: "@number0/iroh",
    smoke:
      'const path = require("node:path"); const manifest = require.resolve("@number0/iroh/package.json"); const mod = require(path.join(path.dirname(manifest), "index.js")); if (typeof mod.Endpoint !== "function" || typeof mod.SecretKey !== "function" || typeof mod.RelayMode !== "function") throw new Error("Iroh native endpoint exports are unavailable"); const key = mod.SecretKey.generate(); if (!key.public().toString()) throw new Error("Iroh native key derivation failed");',
  },
  {
    packageName: "node-pty",
    smoke: `const mod = require("node-pty");
       console.error("PTY probe: native module loaded; spawning child");
       const terminal = mod.spawn(process.execPath, ["-e", "process.stdout.write('native-pty-ready')"], {
         name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env
       });
       console.error("PTY probe: child spawned; awaiting output and exit");
       let output = "";
       let exited = false;
       const timer = setTimeout(() => {
         console.error("PTY startup timed out: childExited=" + exited + ", markerReceived=" + output.includes("native-pty-ready"));
         terminal.kill(); process.exit(1);
       }, 5000);
       const complete = () => {
         if (exited && output.includes("native-pty-ready")) {
           clearTimeout(timer); process.exit(0);
         }
       };
       terminal.onData(data => { output = (output + data).slice(-4096); complete(); });
       terminal.onExit(({exitCode}) => {
         if (exitCode !== 0) {
           console.error("PTY child exited unsuccessfully: " + exitCode); process.exit(1);
         }
         exited = true;
         complete();
       });`,
  },
  {
    packageName: "@vscode/ripgrep",
    smoke:
      'const { spawnSync } = require("node:child_process"); const { rgPath } = require("@vscode/ripgrep"); const result = spawnSync(rgPath, ["--version"], { encoding: "utf8" }); if (result.status !== 0 || !result.stdout.startsWith("ripgrep ")) throw new Error(result.stderr || "ripgrep executable is unavailable");',
  },
];

/** Restore executable metadata on node-pty's trusted macOS helper payload.
 * Its 1.1.0 prebuild archive ships spawn-helper without executable bits. The
 * package loader executes this file directly; its bytes need no modification.
 * Run this in developer preparation and before packaging the target payload. */
export function prepareNativeDependencyFiles({
  cwd = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "darwin") return;
  const require = createRequire(path.join(cwd, "package.json"));
  const root = path.dirname(require.resolve("node-pty/package.json"));
  for (const relative of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(root, relative, "spawn-helper");
    let metadata;
    try {
      metadata = statSync(helper);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) throw new Error(`Native PTY helper is not a file: ${helper}`);
    if ((metadata.mode & 0o111) !== 0o111) chmodSync(helper, 0o755);
  }
}

function failureText(result) {
  return String(
    result.stderr || result.stdout || result.error?.message || "unknown load failure"
  ).trim();
}

export function inspectHostNativeDependencies({
  cwd = process.cwd(),
  env = process.env,
  run = spawnSync,
} = {}) {
  return dependencyContracts.map((contract) => {
    const result = run(process.execPath, ["-e", contract.smoke], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    return {
      packageName: contract.packageName,
      ok: result.status === 0 && !result.error,
      ...(result.status === 0 && !result.error ? {} : { error: failureText(result) }),
    };
  });
}

/** Verify every contract, returning how many were confirmed. */
export function assertHostNativeDependencies(options = {}) {
  const failures = inspectHostNativeDependencies(options).filter((result) => !result.ok);
  if (failures.length === 0) return dependencyContracts.length;
  throw new Error(
    `Host native dependencies are unavailable:\n${failures
      .map((failure) => `- ${failure.packageName}: ${failure.error}`)
      .join("\n")}\nRun pnpm check:native-host-dependencies --repair.`
  );
}

export function ensureHostNativeDependencies({
  cwd = process.cwd(),
  env = process.env,
  run = spawnSync,
  log = console.log,
} = {}) {
  prepareNativeDependencyFiles({ cwd });
  const failures = inspectHostNativeDependencies({ cwd, env, run }).filter((result) => !result.ok);
  if (failures.length === 0) {
    log(`[native-dependencies] ${dependencyContracts.length} host runtime contracts verified.`);
    return;
  }

  const packages = failures.map(({ packageName }) => packageName);
  log(`[native-dependencies] Rebuilding unavailable host dependencies: ${packages.join(", ")}`);
  const pnpm = createPnpmInvocation(["rebuild", ...packages]);
  const rebuild = run(pnpm.command, pnpm.args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (rebuild.status !== 0 || rebuild.error) {
    throw new Error(
      `Failed to rebuild host native dependencies ${packages.join(", ")}: ${failureText(rebuild)}`
    );
  }
  prepareNativeDependencyFiles({ cwd });
  assertHostNativeDependencies({ cwd, env, run });
  log("[native-dependencies] Host runtime dependencies repaired and verified.");
}

async function main() {
  if (process.argv.includes("--repair")) {
    ensureHostNativeDependencies();
  } else {
    const verified = assertHostNativeDependencies();
    console.log(`[native-dependencies] ${verified} host runtime contracts verified.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
