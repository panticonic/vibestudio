#!/usr/bin/env node
// Manual npm publish helper for the headless server package.
// Real publishes require a granular token with bypass 2FA enabled.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { formatRpcFailure } from "@vibestudio/rpc";
import { compare as compareSemver, valid as validSemver } from "semver";
import { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";
import { ownedEntry, withOwnership } from "./lib/owned-entry.mjs";
import { spawnResultFailure } from "./lib/spawn-result-failure.mjs";
import { createNpmAuth, npmTokenFilePath } from "./lib/npm-auth.mjs";
import {
  packNpmPackageCandidate,
  readVerifiedNpmPackageCandidate,
  validateNpmPackageManifest,
} from "./lib/npm-package-candidate.mjs";

export { validateNpmPackageManifest };

export { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPkg = readJson(path.join(repoRoot, "package.json"));
let announcedTokenEnv = false;
let npmAuth;
const publicationStagingTag = "vibestudio-publication-candidate";
const serverPackage = {
  name: "@panticonic/vibestudio-server",
  dir: path.join(repoRoot, "dist-packages", "server"),
  smokePrefix: "vibestudio-npm-server-check-",
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runWithOwnedCleanup(
      () => ownedEntry(({ ownership, signal }) => main(ownership, signal)),
      closePublisherAuth,
      "npm publish operation and auth-config cleanup failed"
    );
  } catch (error) {
    console.error(`\n[publish-npm] ${formatSafeRpcFailure(error)}`);
    process.exitCode = 1;
  }
}

export { spawnResultFailure };

function redactAuthToken(value) {
  return npmAuth ? npmAuth.redact(value) : String(value);
}

function formatSafeRpcFailure(error) {
  return redactAuthToken(formatRpcFailure(error));
}

async function main(ownership, signal) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.dryRunOnly) {
    const whoami = capture("npm", ["whoami"], { cwd: repoRoot });
    if (whoami.status !== 0) {
      console.warn("[publish-npm] npm is not logged in; continuing because --dry-run-only is set.");
    }
  }

  if (options.candidateReceipt) {
    if (options.skipBuild || options.skipStage || options.candidateOutput) {
      throw new Error(
        "--candidate-receipt cannot be combined with build, stage, or candidate-output options"
      );
    }
    if (!options.candidateSourceSha || !options.candidateVersion) {
      throw new Error(
        "--candidate-receipt requires --candidate-source-sha and --candidate-version"
      );
    }
  } else {
    if (options.candidateSourceSha || options.candidateVersion) {
      throw new Error("--candidate-source-sha and --candidate-version require --candidate-receipt");
    }
    if (!options.skipBuild) run("pnpm", ["build"], { cwd: repoRoot });
    if (!options.skipStage)
      run("node", ["scripts/build-server-npm-package.mjs"], { cwd: repoRoot });
  }

  const manifests = options.candidateReceipt
    ? [validateCandidateIdentity(serverPackage, options.candidateVersion)]
    : [validateStagedPackage(serverPackage)];
  const entry = manifests[0];
  const sourceSha = options.candidateSourceSha ?? currentSourceSha();
  let candidate;
  if (options.candidateReceipt) {
    candidate = await readVerifiedNpmPackageCandidate(options.candidateReceipt, {
      sourceSha,
      packageName: entry.pkg.name,
      packageVersion: entry.version,
    });
  } else {
    candidate = await packNpmPackageCandidate({
      packageRoot: entry.pkg.dir,
      outputDirectory:
        options.candidateOutput ?? (await ownership.scratch("vibestudio-npm-candidate-")),
      sourceSha,
    });
  }

  const registryVersions = new Map();
  const payloadVerified = new Set();
  for (const entry of manifests) {
    const existing = npmView(entry.pkg.name, entry.version);
    if (existing === entry.version) {
      await verifyPublishedCandidate(entry, candidate.tarballPath);
      payloadVerified.add(entry.pkg.name);
      console.log(
        `[publish-npm] ${entry.pkg.name}@${entry.version} is already published with the same candidate payload; skipping.`
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

  // Only a version still to be published can be dry-run: the registry rejects
  // publishing over an existing version, even as a dry run, so resuming after
  // the publish itself succeeded must not repeat it.
  for (const entry of publishQueue) {
    console.log(`\n[publish-npm] Dry-run ${entry.pkg.name}@${entry.version}`);
    run(
      "npm",
      publishArgs({
        packagePath: candidate.tarballPath,
        dryRun: true,
        tag: publicationStagingTag,
      }),
      { cwd: repoRoot }
    );
  }

  for (const entry of manifests) {
    await runInstallSmoke(entry, candidate.tarballPath, "Candidate install smoke", signal);
  }

  if (options.dryRunOnly) {
    console.log("\n[publish-npm] Dry-run complete. No packages were published.");
    return;
  }

  if (!publishQueue.length) {
    console.log("\n[publish-npm] All selected package versions are already published.");
  }
  const publishToken = getAuthToken();
  if (!publishToken) {
    throw new Error(
      "npm publication requires a saved token. Run pnpm setup:npm-token, or export NPM_TOKEN/NODE_AUTH_TOKEN for this shell."
    );
  }
  const npmUser = ensureTokenAuth();
  if (npmUser !== "panticonic") {
    console.warn(`[publish-npm] npm token authenticates as ${npmUser}; expected panticonic.`);
  }

  for (const entry of publishQueue) {
    console.log(`\n[publish-npm] Publishing ${entry.pkg.name}@${entry.version}`);
    console.log("[publish-npm] Using the configured npm publish token.");
    const result = spawnSync(
      "npm",
      publishArgs({
        packagePath: candidate.tarballPath,
        dryRun: false,
        tag: publicationStagingTag,
      }),
      {
        cwd: repoRoot,
        stdio: ["inherit", "pipe", "pipe"],
        encoding: "utf8",
        env: npmEnv({ authenticated: true }),
      }
    );
    if (result.stdout) process.stdout.write(redactAuthToken(result.stdout));
    if (result.stderr) process.stderr.write(redactAuthToken(result.stderr));
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
    if (!payloadVerified.has(entry.pkg.name)) {
      await verifyPublishedCandidate(entry, candidate.tarballPath);
      payloadVerified.add(entry.pkg.name);
    }
    console.log(`  ${entry.pkg.name}@${published}`);
  }

  for (const entry of manifests) {
    await runInstallSmoke(
      entry,
      `${entry.pkg.name}@${entry.version}`,
      "Registry install smoke",
      signal
    );
  }

  for (const entry of manifests) {
    reconcileDistTag(entry, options.tag);
    retirePublicationStagingTag(entry);
  }
}

export function parseArgs(argv) {
  const options = {
    dryRunOnly: false,
    candidateOutput: null,
    candidateReceipt: null,
    candidateSourceSha: null,
    candidateVersion: null,
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
    } else if (arg === "--candidate-source-sha") {
      options.candidateSourceSha = requireValue(argv, ++i, arg);
    } else if (arg === "--candidate-version") {
      options.candidateVersion = requireValue(argv, ++i, arg);
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
  if (options.tag === publicationStagingTag) {
    throw new Error(`--tag ${publicationStagingTag} is reserved for atomic publication`);
  }
  if (options.candidateSourceSha && !/^[0-9a-f]{40}$/u.test(options.candidateSourceSha)) {
    throw new Error("--candidate-source-sha must be a full Git commit SHA");
  }
  if (options.candidateVersion && validSemver(options.candidateVersion) === null) {
    throw new Error("--candidate-version must be a valid semantic version");
  }
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

/** The npm auth configuration is the publisher's only state outside its ownership. */
function closePublisherAuth() {
  npmAuth?.close();
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
  --candidate-source-sha <sha> Exact release source attested by a reused receipt
  --candidate-version <version> Exact package version attested by a reused receipt
  --tag <tag>               Dist-tag promoted after registry smoke. Default: latest
                            latest advances monotonically and never moves backward

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

export function publishArgs({ packagePath, dryRun, tag }) {
  const args = ["publish", packagePath, "--access", "public", "--tag", tag];
  if (dryRun) args.push("--dry-run", "--silent");
  else args.push("--loglevel", "error");
  return args;
}

export function distTagPromotionDecision({ candidateVersion, currentVersion, tag }) {
  if (validSemver(candidateVersion) === null) {
    throw new Error(`Candidate version is not valid semantic version: ${candidateVersion}`);
  }
  if (currentVersion === candidateVersion) return "current";
  if (tag !== "latest" || currentVersion === null) return "promote";
  if (validSemver(currentVersion) === null) {
    throw new Error(`npm dist-tag ${tag} has invalid semantic version: ${currentVersion}`);
  }
  return compareSemver(candidateVersion, currentVersion) > 0 ? "promote" : "preserve-newer";
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

function validateCandidateIdentity(pkg, version) {
  if (pkg.name !== "@panticonic/vibestudio-server") {
    throw new Error(`Unexpected npm candidate package: ${pkg.name}`);
  }
  return {
    pkg,
    manifest: { name: pkg.name, version, publishConfig: { access: "public" } },
    version,
  };
}

function npmView(name, version) {
  const result = capture("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], {
    cwd: repoRoot,
  });
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

function npmDistTags(name) {
  const result = capture("npm", ["view", name, "dist-tags", "--json", "--prefer-online"], {
    cwd: repoRoot,
  });
  const failure = spawnResultFailure(result, `npm view ${name} dist-tags`);
  if (failure) throw failure;
  try {
    const tags = JSON.parse(result.stdout);
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
      throw new Error("expected an object");
    }
    return tags;
  } catch (error) {
    throw new Error(`npm returned invalid dist-tags for ${name}`, { cause: error });
  }
}

function reconcileDistTag(entry, tag) {
  const before = npmDistTags(entry.pkg.name);
  const currentVersion = typeof before[tag] === "string" ? before[tag] : null;
  const decision = distTagPromotionDecision({
    candidateVersion: entry.version,
    currentVersion,
    tag,
  });

  if (decision === "promote") {
    console.log(`\n[publish-npm] Promoting ${tag} to ${entry.pkg.name}@${entry.version}`);
    run("npm", ["dist-tag", "add", `${entry.pkg.name}@${entry.version}`, tag], {
      cwd: repoRoot,
      authenticated: true,
    });
  } else if (decision === "preserve-newer") {
    console.log(
      `\n[publish-npm] Preserving newer ${tag} pointer ${entry.pkg.name}@${currentVersion}.`
    );
  } else {
    console.log(`\n[publish-npm] ${tag} already points to ${entry.pkg.name}@${entry.version}.`);
  }

  const expectedVersion = decision === "preserve-newer" ? currentVersion : entry.version;
  const after = npmDistTags(entry.pkg.name);
  if (after[tag] !== expectedVersion) {
    throw new Error(
      `npm dist-tag ${tag} points to ${String(after[tag])}; expected ${expectedVersion}`
    );
  }
}

function retirePublicationStagingTag(entry) {
  const tags = npmDistTags(entry.pkg.name);
  if (tags[publicationStagingTag] !== entry.version) return;
  console.log(
    `[publish-npm] Removing ${publicationStagingTag} from ${entry.pkg.name}@${entry.version}.`
  );
  run("npm", ["dist-tag", "rm", entry.pkg.name, publicationStagingTag], {
    cwd: repoRoot,
    authenticated: true,
  });
  const after = npmDistTags(entry.pkg.name);
  if (after[publicationStagingTag] === entry.version) {
    throw new Error(
      `npm dist-tag ${publicationStagingTag} still points to ${entry.pkg.name}@${entry.version}`
    );
  }
}

async function verifyPublishedCandidate(entry, candidatePath) {
  const result = capture(
    "npm",
    ["view", `${entry.pkg.name}@${entry.version}`, "dist.tarball", "--json"],
    { cwd: repoRoot }
  );
  const failure = spawnResultFailure(
    result,
    `npm view ${entry.pkg.name}@${entry.version} dist.tarball`
  );
  if (failure) throw failure;
  let tarballUrl;
  try {
    tarballUrl = new URL(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error("npm returned an invalid published tarball URL", { cause: error });
  }
  if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") {
    throw new Error(`npm returned an unexpected published tarball URL: ${tarballUrl.origin}`);
  }
  const response = await fetch(tarballUrl, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download published npm archive for integrity verification: HTTP ${response.status}`
    );
  }
  const [candidatePayload, publishedPayload] = await Promise.all([
    npmArchivePayloadSha256(fs.createReadStream(candidatePath)),
    npmArchivePayloadSha256(Readable.fromWeb(response.body)),
  ]);
  if (publishedPayload !== candidatePayload) {
    throw new Error(
      `Published ${entry.pkg.name}@${entry.version} does not match the verified candidate payload`
    );
  }
}

export async function npmArchivePayloadSha256(compressedStream) {
  const hash = createHash("sha256");
  const payload = compressedStream.pipe(createGunzip());
  for await (const chunk of payload) hash.update(chunk);
  return hash.digest("hex");
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
  const whoami = capture("npm", ["whoami"], { cwd: repoRoot, authenticated: true });
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

/** One smoke owns its install, its server and their storage: all retire when it ends. */
function runInstallSmoke(entry, packageSpec, label, signal) {
  return withOwnership((ownership) => installSmoke(entry, packageSpec, label, ownership, signal));
}

async function installSmoke(entry, packageSpec, label, ownership, signal) {
  const root = await ownership.scratch(entry.pkg.smokePrefix);
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
    ownership,
    signal
  );
}

async function runServerStartupSmoke(serverBinary, launchDirectory, ownership, signal) {
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
  // Retired with the smoke's ownership once readiness is proven: stopped
  // gracefully, before the installed package and its state are removed.
  const { child } = ownership.spawn(
    serverBinary,
    ["--bootstrap-workspace", "npm-install-smoke", "--ready-file", readyFile],
    {
      kill: "graceful",
      label: "npm-install-smoke-server",
      cwd: launchDirectory,
      stdio: "inherit",
      env,
    }
  );
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  // Readiness is observed against the server's own lifecycle: its exit or an
  // operator's stop request ends the wait. No clock decides.
  while (!fs.existsSync(readyFile)) {
    signal.throwIfAborted();
    if (startupError) throw startupError;
    if (exit) {
      throw new Error(
        `Installed server exited before readiness (code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function run(command, args, options) {
  console.log(`\n[publish-npm] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: command === "npm" ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: npmEnv({ authenticated: options.authenticated }),
  });
  if (result.stdout) process.stdout.write(redactAuthToken(result.stdout));
  if (result.stderr) process.stderr.write(redactAuthToken(result.stderr));
  const failure = spawnResultFailure(result, `${command} ${args.join(" ")}`);
  if (failure) throw failure;
}

function capture(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: npmEnv({ authenticated: options.authenticated }),
  });
}

function npmEnv({ authenticated = false } = {}) {
  if (!authenticated) return publicNpmEnvironment(process.env);
  const auth = getNpmAuth();
  if (auth.token && !announcedTokenEnv) {
    console.log(`[publish-npm] Using npm publish token from ${auth.token.source}.`);
    announcedTokenEnv = true;
  }
  return auth.environment();
}

export function publicNpmEnvironment(env) {
  const clean = { ...env };
  for (const key of [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
  ]) {
    delete clean[key];
  }
  clean.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
  clean.npm_config_registry = "https://registry.npmjs.org/";
  return clean;
}

function getNpmAuth() {
  npmAuth ??= createNpmAuth();
  return npmAuth;
}

function getAuthToken() {
  return getNpmAuth().token;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
