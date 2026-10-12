#!/usr/bin/env node
// Manual npm publish helper for the headless server package.
// Real publishes require a granular token with bypass 2FA enabled.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatRpcFailure } from "@vibestudio/rpc";
import { tsImport } from "tsx/esm/api";
import { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";
import { spawnResultFailure } from "./lib/spawn-result-failure.mjs";
import {
  packNpmPackageCandidate,
  readVerifiedNpmPackageCandidate,
  validateNpmPackageManifest,
} from "./lib/npm-package-candidate.mjs";

export { validateNpmPackageManifest };

export { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";

const { createDevelopmentClientLifetime } = await tsImport(
  "./development-client-lifecycle.ts",
  import.meta.url
);

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPkg = readJson(path.join(repoRoot, "package.json"));
let announcedTokenEnv = false;
let tokenUserConfigPath = null;
let tokenUserConfigDirectory = null;
let resolvedAuthToken = undefined;
let candidateScratchDirectory = null;
const serverPackage = {
  name: "@panticonic/vibestudio-server",
  dir: path.join(repoRoot, "dist-packages", "server"),
  smokePrefix: path.join(os.tmpdir(), "vibestudio-npm-server-check"),
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runWithOwnedCleanup(
      () => main(),
      cleanupPublisherScratch,
      "npm publish operation and auth-config cleanup failed"
    );
  } catch (error) {
    console.error(`\n[publish-npm] ${formatSafeRpcFailure(error)}`);
    process.exitCode = 1;
  }
}

export { spawnResultFailure };

function redactAuthToken(value) {
  const token = resolvedAuthToken?.value;
  const text = String(value);
  return token ? text.split(token).join("[redacted]") : text;
}

function formatSafeRpcFailure(error) {
  return redactAuthToken(formatRpcFailure(error));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const publishToken = getAuthToken();
  if (!options.dryRunOnly && !publishToken) {
    throw new Error(
      "npm publish requires a saved token. Run pnpm setup:npm-token, or export NPM_TOKEN/NODE_AUTH_TOKEN for this shell."
    );
  }

  if (options.dryRunOnly) {
    const whoami = capture("npm", ["whoami"], { cwd: repoRoot });
    if (whoami.status !== 0) {
      console.warn("[publish-npm] npm is not logged in; continuing because --dry-run-only is set.");
    }
  } else if (publishToken) {
    const npmUser = ensureTokenAuth();
    if (npmUser !== "panticonic") {
      console.warn(`[publish-npm] npm token authenticates as ${npmUser}; expected panticonic.`);
    }
  }

  if (options.candidateReceipt) {
    if (options.skipBuild || options.skipStage || options.candidateOutput) {
      throw new Error(
        "--candidate-receipt cannot be combined with build, stage, or candidate-output options"
      );
    }
  } else {
    if (!options.skipBuild) run("pnpm", ["build"], { cwd: repoRoot });
    if (!options.skipStage)
      run("node", ["scripts/build-server-npm-package.mjs"], { cwd: repoRoot });
  }

  const manifests = options.candidateReceipt
    ? [validateCandidateIdentity(serverPackage)]
    : [validateStagedPackage(serverPackage)];
  const entry = manifests[0];
  const sourceSha = currentSourceSha();
  let candidate;
  if (options.candidateReceipt) {
    candidate = await readVerifiedNpmPackageCandidate(options.candidateReceipt, {
      sourceSha,
      packageName: entry.pkg.name,
      packageVersion: entry.version,
    });
  } else {
    candidateScratchDirectory = options.candidateOutput
      ? null
      : fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-candidate-"));
    candidate = await packNpmPackageCandidate({
      packageRoot: entry.pkg.dir,
      outputDirectory: options.candidateOutput ?? candidateScratchDirectory,
      sourceSha,
    });
  }

  const registryVersions = new Map();
  for (const entry of manifests) {
    const existing = npmView(entry.pkg.name, entry.version);
    if (existing === entry.version) {
      console.log(
        `[publish-npm] ${entry.pkg.name}@${entry.version} is already published; skipping.`
      );
    } else if (existing) {
      console.log(
        `[publish-npm] ${entry.pkg.name} exists, but ${entry.version} is not published yet.`
      );
    }
    registryVersions.set(entry.pkg.name, existing);
  }
  const publishQueue = manifests.filter(
    (entry) => registryVersions.get(entry.pkg.name) !== entry.version
  );

  for (const entry of manifests) {
    console.log(`\n[publish-npm] Dry-run ${entry.pkg.name}@${entry.version}`);
    run(
      "npm",
      publishArgs({ packagePath: candidate.tarballPath, dryRun: true, tag: options.tag }),
      { cwd: repoRoot }
    );
  }

  for (const entry of manifests) {
    await runInstallSmoke(entry, candidate.tarballPath, "Candidate install smoke");
  }

  if (options.dryRunOnly) {
    console.log("\n[publish-npm] Dry-run complete. No packages were published.");
    return;
  }

  if (!publishQueue.length) {
    console.log("\n[publish-npm] All selected package versions are already published.");
  }

  for (const entry of publishQueue) {
    console.log(`\n[publish-npm] Publishing ${entry.pkg.name}@${entry.version}`);
    console.log("[publish-npm] Using the configured npm publish token.");
    const result = spawnSync(
      "npm",
      publishArgs({ packagePath: candidate.tarballPath, dryRun: false, tag: options.tag }),
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: npmEnv(),
      }
    );
    const failure = spawnResultFailure(result, "npm publish");
    if (failure) {
      throw new Error(
        `Publish failed for ${entry.pkg.name}. After addressing the npm error above, rerun: pnpm publish:server-npm:staged`,
        { cause: failure }
      );
    }
  }

  console.log("\n[publish-npm] Registry verification");
  for (const entry of manifests) {
    const published = await verifyPublished(entry);
    console.log(`  ${entry.pkg.name}@${published}`);
  }

  for (const entry of manifests) {
    await runInstallSmoke(entry, `${entry.pkg.name}@${entry.version}`, "Registry install smoke");
  }
}

function parseArgs(argv) {
  const options = {
    dryRunOnly: false,
    candidateOutput: null,
    candidateReceipt: null,
    help: false,
    skipBuild: false,
    skipStage: false,
    tag: "latest",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run-only") {
      options.dryRunOnly = true;
    } else if (arg === "--candidate-output") {
      options.candidateOutput = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === "--candidate-receipt") {
      options.candidateReceipt = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--skip-stage") {
      options.skipStage = true;
    } else if (arg === "--tag") {
      options.tag = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.tag) throw new Error("--tag must not be empty");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function currentSourceSha() {
  const result = capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const failure = spawnResultFailure(result, "git rev-parse HEAD");
  if (failure) throw failure;
  const sourceSha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("Current Git HEAD is not a full commit SHA");
  }
  return sourceSha;
}

function cleanupPublisherScratch() {
  const failures = [];
  for (const ownedPath of [candidateScratchDirectory, tokenUserConfigDirectory]) {
    if (!ownedPath) continue;
    try {
      fs.rmSync(ownedPath, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  candidateScratchDirectory = null;
  tokenUserConfigDirectory = null;
  tokenUserConfigPath = null;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Could not retire npm publisher scratch paths", {
      cause: failures[0],
    });
  }
}

function printUsage() {
  console.log(`Usage: pnpm publish:server-npm [-- options]

Build, stage, dry-run, publish, verify, and install-smoke the headless server npm package.

Options:
  --skip-build              Reuse the current dist/ build
  --skip-stage              Reuse dist-packages/
  --dry-run-only            Build/stage/check only; do not publish
  --candidate-output <dir>  Retain the verified archive and receipt in this directory
  --candidate-receipt <file> Reuse an archive whose receipt matches this Git commit
  --tag <tag>               npm dist-tag. Default: latest

Common reruns:
  pnpm publish:server-npm:staged

Auth:
  For direct publish, npm requires a TOTP code or a granular access token with
  bypass 2FA enabled. This repo uses the token path. Run this once:

    pnpm setup:npm-token

  This stores the token at ${npmTokenFilePath()} with mode 0600. You can also
  export NPM_TOKEN or NODE_AUTH_TOKEN for one shell instead.
`);
}

function publishArgs({ packagePath, dryRun, tag }) {
  const args = ["publish", packagePath, "--access", "public", "--tag", tag];
  if (dryRun) args.push("--dry-run", "--silent");
  return args;
}

export function validateStagedPackage(pkg) {
  const manifestPath = path.join(pkg.dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing staged package: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  validateNpmPackageManifest(manifest, { name: pkg.name, version: rootPkg.version }, manifestPath);

  return { pkg, manifest, version: manifest.version };
}

function validateCandidateIdentity(pkg) {
  if (pkg.name !== "@panticonic/vibestudio-server") {
    throw new Error(`Unexpected npm candidate package: ${pkg.name}`);
  }
  return {
    pkg,
    manifest: { name: pkg.name, version: rootPkg.version, publishConfig: { access: "public" } },
    version: rootPkg.version,
  };
}

function npmView(name, version) {
  const result = capture("npm", ["view", `${name}@${version}`, "version"], { cwd: repoRoot });
  if (result.status === 0) return result.stdout.trim();
  if (/E404|404 Not Found|is not in this registry/.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  const failure = spawnResultFailure(result, `npm view ${name}@${version}`);
  if (failure) {
    throw new Error(
      redactAuthToken(
        `Could not check npm registry for ${name}@${version}: ${result.stderr.trim() || result.stdout.trim()}`
      ),
      { cause: failure }
    );
  }
  throw new Error(`Could not check npm registry for ${name}@${version}`);
}

async function verifyPublished(entry) {
  // npm acknowledges an accepted upload before its processing makes it public.
  // A missing version is still pending; only registry readiness or an actual
  // registry error can settle verification.
  for (;;) {
    const published = npmView(entry.pkg.name, entry.version);
    if (published === entry.version) return published;
    if (published !== null) {
      throw new Error(
        `Unexpected registry version for ${entry.pkg.name}@${entry.version}: ${published}`
      );
    }
    console.log(`[publish-npm] Waiting for ${entry.pkg.name}@${entry.version} to appear on npm...`);
    await delay(5000);
  }
}

function ensureTokenAuth() {
  const whoami = capture("npm", ["whoami"], { cwd: repoRoot });
  if (whoami.status !== 0) {
    const detail = redactAuthToken(whoami.stderr.trim() || whoami.stdout.trim());
    const failure = spawnResultFailure(whoami, "npm whoami");
    throw new Error(
      [
        "Saved npm publish token did not authenticate with npm.",
        "Create a granular token with read/write package access and bypass 2FA enabled, then run:",
        "  pnpm setup:npm-token",
        detail ? `npm said: ${detail}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: failure }
    );
  }
  return whoami.stdout.trim();
}

async function runInstallSmoke(entry, packageSpec, label) {
  const root = fs.mkdtempSync(`${entry.pkg.smokePrefix}-`);
  let lifetime;
  return runWithOwnedCleanup(
    async () => {
      lifetime = createDevelopmentClientLifetime(root);
      const prefix = path.join(root, "install");
      const launchDirectory = path.join(root, "launch");
      fs.mkdirSync(launchDirectory);
      console.log(`\n[publish-npm] ${label} ${entry.pkg.name}@${entry.version}`);
      run("npm", ["install", "-g", "--prefix", prefix, packageSpec], {
        cwd: launchDirectory,
      });
      const packageDirectory = path.join(
        prefix,
        ...(process.platform === "win32" ? [] : ["lib"]),
        "node_modules",
        ...entry.pkg.name.split("/")
      );
      validateNpmPackageManifest(
        readJson(path.join(packageDirectory, "package.json")),
        { name: entry.pkg.name, version: entry.version },
        "Installed candidate package"
      );
      run(path.join(prefix, "bin", "vibestudio"), ["--version"], { cwd: launchDirectory });
      run(path.join(prefix, "bin", "vibestudio"), ["--help"], { cwd: launchDirectory });
      run(path.join(prefix, "bin", "vibestudio"), ["remote", "serve", "--help"], {
        cwd: launchDirectory,
      });
      run(path.join(prefix, "bin", "vibestudio"), ["remote", "doctor", "--json"], {
        cwd: launchDirectory,
      });
      run(path.join(prefix, "bin", "vibestudio-server"), ["--help"], {
        cwd: launchDirectory,
      });
      await runServerStartupSmoke(
        path.join(prefix, "bin", "vibestudio-server"),
        launchDirectory,
        lifetime.acquire
      );
    },
    () => {
      if (lifetime) return lifetime.close();
      return fs.promises.rm(root, { recursive: true, force: true });
    },
    "npm install smoke and owned process cleanup failed"
  );
}

async function runServerStartupSmoke(serverBinary, launchDirectory, acquire) {
  const readyFile = path.join(launchDirectory, "hub-ready.json");
  const env = { ...process.env };
  for (const key of [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
  ]) {
    delete env[key];
  }
  env.XDG_CONFIG_HOME = path.join(launchDirectory, "config");
  const child = acquire(() =>
    spawn(serverBinary, ["--bootstrap-workspace", "npm-install-smoke", "--ready-file", readyFile], {
      cwd: launchDirectory,
      stdio: "inherit",
      env,
      detached: process.platform !== "win32",
    })
  );
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(readyFile)) {
    if (startupError) throw startupError;
    if (exit) {
      throw new Error(
        `Installed server exited before readiness (code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"})`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error("Installed server did not become ready within 60 seconds");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // The caller's finally joins retirement of the entire acquired group before
  // deleting the installed package or its server state, on success or failure.
}

function run(command, args, options) {
  console.log(`\n[publish-npm] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: npmEnv(),
  });
  const failure = spawnResultFailure(result, `${command} ${args.join(" ")}`);
  if (failure) throw failure;
}

function capture(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: npmEnv(),
  });
}

function npmEnv() {
  const env = { ...process.env };
  const token = getAuthToken();
  if (token) {
    env.NODE_AUTH_TOKEN = token.value;
    const userConfig = tokenUserConfig();
    env.NPM_CONFIG_USERCONFIG = userConfig;
    env.npm_config_userconfig = userConfig;
    if (!announcedTokenEnv) {
      console.log(`[publish-npm] Using npm publish token from ${token.source}.`);
      announcedTokenEnv = true;
    }
  }
  return env;
}

function getAuthToken() {
  if (resolvedAuthToken !== undefined) return resolvedAuthToken;

  const envToken = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (envToken?.trim()) {
    resolvedAuthToken = {
      source: process.env.NODE_AUTH_TOKEN ? "NODE_AUTH_TOKEN" : "NPM_TOKEN",
      value: envToken.trim(),
    };
    return resolvedAuthToken;
  }

  const tokenFile = npmTokenFilePath();
  if (!fs.existsSync(tokenFile)) {
    resolvedAuthToken = null;
    return resolvedAuthToken;
  }

  secureTokenFileMode(tokenFile);
  const value = parseStoredToken(fs.readFileSync(tokenFile, "utf8"));
  if (!value) {
    throw new Error(`npm token file is empty: ${tokenFile}`);
  }

  resolvedAuthToken = { source: tokenFile, value };
  return resolvedAuthToken;
}

function npmTokenFilePath() {
  if (process.env.VIBESTUDIO_NPM_TOKEN_FILE) {
    return path.resolve(expandHome(process.env.VIBESTUDIO_NPM_TOKEN_FILE));
  }
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(process.env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "vibestudio", "npm-publish-token");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseStoredToken(contents) {
  const line =
    contents
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith("#")) ?? "";
  const match = /^(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*=\s*(.*)$/.exec(line);
  const value = match ? match[1].trim() : line;
  return value.replace(/^['"]|['"]$/g, "");
}

function secureTokenFileMode(file) {
  if (process.platform === "win32") return;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`npm token path is not a file: ${file}`);
  if ((stat.mode & 0o077) === 0) return;

  fs.chmodSync(file, 0o600);
}

function tokenUserConfig() {
  if (tokenUserConfigPath) return tokenUserConfigPath;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-auth-"));
  tokenUserConfigDirectory = dir;
  tokenUserConfigPath = path.join(dir, ".npmrc");
  fs.writeFileSync(
    tokenUserConfigPath,
    [
      "registry=https://registry.npmjs.org/",
      "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  return tokenUserConfigPath;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
