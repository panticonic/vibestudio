#!/usr/bin/env node
// npm publish helper for the public @panticonic packages.
// Real publishes require a granular token with bypass 2FA enabled.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPkg = readJson(path.join(repoRoot, "package.json"));
let announcedTokenEnv = false;
let tokenUserConfigPath = null;
let resolvedAuthToken = undefined;
const packages = [
  {
    id: "server",
    name: "@panticonic/vibestudio-server",
    dir: path.join(repoRoot, "dist-packages", "server"),
    smokePrefix: path.join(os.tmpdir(), "vibestudio-npm-server-check"),
  },
  {
    id: "app",
    name: "@panticonic/vibestudio",
    dir: path.join(repoRoot, "dist-packages", "app"),
    smokePrefix: path.join(os.tmpdir(), "vibestudio-npm-app-check"),
  },
];

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[publish-npm] ${message}`);
  process.exit(1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const selected = selectPackages(options.package);
  if (!selected.length) {
    throw new Error(`No packages selected for --package=${options.package}`);
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

  if (!options.skipBuild) run("pnpm", ["build"], { cwd: repoRoot });
  if (!options.skipStage) run("node", ["scripts/build-npm-packages.mjs"], { cwd: repoRoot });

  const manifests = selected.map((pkg) => validateStagedPackage(pkg));
  const publishQueue = manifests.filter((entry) => {
    const existing = npmView(entry.pkg.name, entry.version);
    if (existing === entry.version) {
      console.log(
        `[publish-npm] ${entry.pkg.name}@${entry.version} is already published; skipping.`
      );
      return false;
    }
    if (existing) {
      console.log(
        `[publish-npm] ${entry.pkg.name} exists, but ${entry.version} is not published yet.`
      );
    }
    return true;
  });

  if (!options.skipDryRun) {
    for (const entry of publishQueue) {
      console.log(`\n[publish-npm] Dry-run ${entry.pkg.name}@${entry.version}`);
      run("npm", publishArgs({ dryRun: true, tag: options.tag }), { cwd: entry.pkg.dir });
    }
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
    const result = spawnSync("npm", publishArgs({ dryRun: false, tag: options.tag }), {
      cwd: entry.pkg.dir,
      stdio: "inherit",
      env: npmEnv(),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(twoFactorHelp());
      console.error(
        `\n[publish-npm] Publish failed for ${entry.pkg.name}. After fixing auth, rerun the staged flow:`
      );
      console.error(`  pnpm publish:npm:staged -- --package ${entry.pkg.id}`);
      process.exit(result.status ?? 1);
    }
  }

  console.log("\n[publish-npm] Registry verification");
  for (const entry of manifests) {
    const published = verifyPublished(entry);
    console.log(`  ${entry.pkg.name}@${published}`);
  }

  if (options.installSmoke) {
    for (const entry of manifests) {
      runInstallSmoke(entry);
    }
  }
}

function parseArgs(argv) {
  const options = {
    dryRunOnly: false,
    help: false,
    installSmoke: true,
    package: "both",
    skipBuild: false,
    skipDryRun: false,
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
    } else if (arg === "--install-smoke") {
      options.installSmoke = true;
    } else if (arg === "--skip-install-smoke") {
      options.installSmoke = false;
    } else if (arg === "--package") {
      options.package = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--package=")) {
      options.package = arg.slice("--package=".length);
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--skip-dry-run") {
      options.skipDryRun = true;
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

  if (!["both", "server", "app"].includes(options.package)) {
    throw new Error("--package must be one of: both, server, app");
  }
  if (!options.tag) throw new Error("--tag must not be empty");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printUsage() {
  console.log(`Usage: pnpm publish:npm [-- options]

Build, stage, dry-run, publish, verify, and install-smoke the public npm packages.

Options:
  --package both|server|app  Package(s) to publish. Default: both
  --skip-build              Reuse the current dist/ build
  --skip-stage              Reuse dist-packages/
  --skip-dry-run            Publish without npm publish --dry-run
  --dry-run-only            Build/stage/check only; do not publish
  --skip-install-smoke      Skip the default post-publish npm install smoke checks
  --tag <tag>               npm dist-tag. Default: latest

Common reruns:
  pnpm publish:npm:staged
  pnpm publish:npm:staged -- --package app

Auth:
  For direct publish, npm requires a TOTP code or a granular access token with
  bypass 2FA enabled. This repo uses the token path. Run this once:

    pnpm setup:npm-token

  This stores the token at ${npmTokenFilePath()} with mode 0600. You can also
  export NPM_TOKEN or NODE_AUTH_TOKEN for one shell instead.
`);
}

function selectPackages(selection) {
  if (selection === "both") return packages;
  return packages.filter((pkg) => pkg.id === selection);
}

function publishArgs({ dryRun, tag }) {
  const args = ["publish", "--access", "public", "--tag", tag];
  if (dryRun) args.push("--dry-run", "--silent");
  return args;
}

function validateStagedPackage(pkg) {
  const manifestPath = path.join(pkg.dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing staged package: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.name !== pkg.name) {
    throw new Error(`${manifestPath} name is ${manifest.name}; expected ${pkg.name}`);
  }
  if (manifest.version !== rootPkg.version) {
    throw new Error(
      `${manifestPath} version is ${manifest.version}; expected root version ${rootPkg.version}`
    );
  }
  if (manifest.private) throw new Error(`${manifestPath} must not be private`);
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${manifestPath} must declare publishConfig.access = public`);
  }

  return { pkg, manifest, version: manifest.version };
}

function npmView(name, version) {
  const result = capture("npm", ["view", `${name}@${version}`, "version"], { cwd: repoRoot });
  if (result.status === 0) return result.stdout.trim();
  if (/E404|404 Not Found|is not in this registry/.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  console.warn(`[publish-npm] Could not check npm registry for ${name}@${version}; continuing.`);
  if (result.stderr.trim()) console.warn(result.stderr.trim());
  return null;
}

function verifyPublished(entry) {
  const attempts = 12;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const published = npmView(entry.pkg.name, entry.version);
    if (published === entry.version) return published;

    if (attempt < attempts) {
      console.log(
        `[publish-npm] Waiting for ${entry.pkg.name}@${entry.version} to appear on npm (${attempt}/${attempts})...`
      );
      sleep(5000);
    }
  }

  throw new Error(`Could not verify ${entry.pkg.name}@${entry.version} on npm.`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureTokenAuth() {
  const whoami = capture("npm", ["whoami"], { cwd: repoRoot });
  if (whoami.status !== 0) {
    const detail = whoami.stderr.trim() || whoami.stdout.trim();
    throw new Error(
      [
        "Saved npm publish token did not authenticate with npm.",
        "Create a granular token with read/write package access and bypass 2FA enabled, then run:",
        "  pnpm setup:npm-token",
        detail ? `npm said: ${detail}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return whoami.stdout.trim();
}

function runInstallSmoke(entry) {
  const prefix = `${entry.pkg.smokePrefix}-${entry.version}`;
  console.log(`\n[publish-npm] Install smoke ${entry.pkg.name}@${entry.version}`);
  fs.rmSync(prefix, { recursive: true, force: true });
  run("npm", ["install", "-g", "--prefix", prefix, `${entry.pkg.name}@${entry.version}`], {
    cwd: repoRoot,
  });
  run(path.join(prefix, "bin", "vibestudio"), ["--version"], { cwd: repoRoot });
  run(path.join(prefix, "bin", "vibestudio"), ["--help"], { cwd: repoRoot });
  run(path.join(prefix, "bin", "vibestudio"), ["remote", "serve", "--help"], {
    cwd: repoRoot,
  });
  run(path.join(prefix, "bin", "vibestudio"), ["remote", "doctor", "--json"], {
    cwd: repoRoot,
  });
  run(path.join(prefix, "bin", "vibestudio-server"), ["--help"], { cwd: repoRoot });
}

function run(command, args, options) {
  console.log(`\n[publish-npm] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: npmEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

  process.once("exit", () => {
    if (tokenUserConfigPath) {
      fs.rmSync(path.dirname(tokenUserConfigPath), { recursive: true, force: true });
    }
  });

  return tokenUserConfigPath;
}

function twoFactorHelp() {
  return `
[publish-npm] npm rejected the write because publish-time 2FA was not satisfied.
[publish-npm] This release flow requires a granular npm access token with
[publish-npm] "bypass 2FA" enabled.
[publish-npm] For this repo, create a granular token with read/write package access
[publish-npm] for the @panticonic scope or all packages/scopes, then save it once:
[publish-npm]   pnpm setup:npm-token
[publish-npm]   pnpm publish:npm:staged -- --package server
[publish-npm] Do not paste the token into chat.`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
