import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dependencyContracts = [
  {
    packageName: "@number0/iroh",
    smoke:
      'const path = require("node:path"); const manifest = require.resolve("@number0/iroh/package.json"); const mod = require(path.join(path.dirname(manifest), "index.js")); if (typeof mod.Endpoint !== "function" || typeof mod.SecretKey !== "function" || typeof mod.RelayMode !== "function") throw new Error("Iroh native endpoint exports are unavailable"); const key = mod.SecretKey.generate(); if (!key.public().toString()) throw new Error("Iroh native key derivation failed");',
  },
  {
    packageName: "node-pty",
    smoke:
      'const mod = require("node-pty"); if (typeof mod.spawn !== "function") throw new Error("spawn export is unavailable");',
  },
  {
    packageName: "@vscode/ripgrep",
    smoke:
      'const { spawnSync } = require("node:child_process"); const { rgPath } = require("@vscode/ripgrep"); const result = spawnSync(rgPath, ["--version"], { encoding: "utf8" }); if (result.status !== 0 || !result.stdout.startsWith("ripgrep ")) throw new Error(result.stderr || "ripgrep executable is unavailable");',
  },
];

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
      .join("\n")}\nRun pnpm rebuild ${failures.map(({ packageName }) => packageName).join(" ")}.`
  );
}

export function ensureHostNativeDependencies({
  cwd = process.cwd(),
  env = process.env,
  run = spawnSync,
  log = console.log,
} = {}) {
  const failures = inspectHostNativeDependencies({ cwd, env, run }).filter((result) => !result.ok);
  if (failures.length === 0) {
    log(`[native-dependencies] ${dependencyContracts.length} host runtime contracts verified.`);
    return;
  }

  const packages = failures.map(({ packageName }) => packageName);
  log(`[native-dependencies] Rebuilding unavailable host dependencies: ${packages.join(", ")}`);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const rebuild = run(pnpm, ["rebuild", ...packages], {
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
