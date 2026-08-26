import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import semver from "semver";
import {
  NPM_DESKTOP_PACKAGE_NAME,
  NPM_UPDATE_CONTRACT_VERSION,
  NPM_UPDATE_ENV,
  NPM_UPDATE_FILES,
  NPM_UPDATE_REQUESTED_EXIT_CODE,
  readPrivateJson,
  validateUpdateRequest,
  writePrivateJsonAtomic,
} from "./npm-update-contract.mjs";
import { terminateOwnedProcessTree } from "./owned-process-tree.mjs";
import { publishHistoricalHostSnapshot, semverMajor } from "./historical-host-snapshot.mjs";

const PROVENANCE_TIMEOUT_MS = 2_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOCK_STALE_MS = 75 * 60_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 8 * 1024;
const UPDATE_DIRECTORY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function getLauncherCentralDataPath(env = process.env, platform = process.platform) {
  const instanceRoot = env["VIBESTUDIO_INSTANCE_ROOT"]?.trim();
  if (instanceRoot) return path.resolve(instanceRoot);
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "vibestudio");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "vibestudio");
  }
  return path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "vibestudio");
}

export async function resolveNpmGlobalInstall(
  packageRoot,
  {
    timeoutMs = PROVENANCE_TIMEOUT_MS,
    env = process.env,
    platform = process.platform,
    centralDataPath = getLauncherCentralDataPath(env, platform),
    useCache = true,
  } = {}
) {
  let manifest;
  let manifestStat;
  const manifestPath = path.join(packageRoot, "package.json");
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifestStat = fs.statSync(manifestPath);
  } catch {
    return null;
  }
  if (
    manifest?.name !== NPM_DESKTOP_PACKAGE_NAME ||
    !semver.valid(manifest.version) ||
    !fs.existsSync(path.join(packageRoot, "node_modules", "electron"))
  ) {
    return null;
  }

  const canonicalPackageRoot = canonicalPath(packageRoot);
  const npmExecutable = resolveNpmExecutable(env, platform);
  if (!npmExecutable) return null;
  const cacheKey = JSON.stringify([
    canonicalPackageRoot,
    manifest.version,
    manifestStat.mtimeMs,
    npmExecutable,
  ]);
  const cachePath = path.join(centralDataPath, NPM_UPDATE_FILES.provenanceCache);
  const cached = useCache ? readCache(cachePath) : null;
  if (cached?.key === cacheKey) {
    const fromCache = validateProvenancePaths(
      canonicalPackageRoot,
      cached.globalRoot,
      cached.globalPrefix,
      platform
    );
    if (fromCache) {
      return {
        packageName: NPM_DESKTOP_PACKAGE_NAME,
        packageRoot: canonicalPackageRoot,
        globalRoot: fromCache.globalRoot,
        globalPrefix: fromCache.globalPrefix,
        npmExecutable,
        currentVersion: manifest.version,
        canInstall: canMutateGlobalInstall(fromCache.globalRoot, fromCache.globalPrefix, platform),
      };
    }
  }

  const rootPromise = runBounded(npmExecutable, ["root", "--global"], {
    timeoutMs,
    env,
    cwd: packageRoot,
  });
  const prefixPromise = runBounded(npmExecutable, ["prefix", "--global"], {
    timeoutMs,
    env,
    cwd: packageRoot,
  });
  const deadline = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const queried = await Promise.race([
    Promise.all([rootPromise, prefixPromise]).then(([rootResult, prefixResult]) => ({
      rootResult,
      prefixResult,
    })),
    deadline,
  ]);
  if (
    !queried ||
    queried.rootResult.code !== 0 ||
    queried.prefixResult.code !== 0 ||
    !queried.rootResult.stdout.trim() ||
    !queried.prefixResult.stdout.trim()
  ) {
    return null;
  }
  const proven = validateProvenancePaths(
    canonicalPackageRoot,
    queried.rootResult.stdout.trim(),
    queried.prefixResult.stdout.trim(),
    platform
  );
  if (!proven) return null;
  writeCache(cachePath, { key: cacheKey, ...proven });
  return {
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    packageRoot: canonicalPackageRoot,
    globalRoot: proven.globalRoot,
    globalPrefix: proven.globalPrefix,
    npmExecutable,
    currentVersion: manifest.version,
    canInstall: canMutateGlobalInstall(proven.globalRoot, proven.globalPrefix, platform),
  };
}

export function createUpdateLaunch(provenance) {
  const base = {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    ...provenance,
  };
  if (!provenance.canInstall) return base;
  pruneUpdateDirectories();
  const requestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-update-"), {
    encoding: "utf8",
  });
  if (process.platform !== "win32") fs.chmodSync(requestDirectory, 0o700);
  return {
    ...base,
    requestDirectory,
    nonce: randomBytes(32).toString("hex"),
  };
}

export async function checkForActiveUpdateLock(
  centralDataPath,
  { resultPath = process.env[NPM_UPDATE_ENV.resultPath], parentPid = process.ppid } = {}
) {
  const lockPath = path.join(centralDataPath, NPM_UPDATE_FILES.lock);
  let lock = readLock(lockPath);
  if (!lock) return { active: false, lockPath };
  if (lockIsStale(lock)) {
    removeMatchingLock(lockPath, lock.token);
    return { active: false, lockPath };
  }

  // The updater starts the replacement launcher before releasing its lock. Only
  // that nonce-bound result handoff may briefly wait for its own parent lock.
  if (resultPath && lock.pid === parentPid && lock.resultPath === resultPath) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      lock = readLock(lockPath);
      if (!lock || lockIsStale(lock)) return { active: false, lockPath };
    }
  }
  return { active: true, lockPath };
}

export async function handleElectronUpdateExit({
  code,
  signal,
  launch,
  centralDataPath,
  systemNode = process.execPath,
}) {
  const requestPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.request);
  const request = readPrivateJson(requestPath, validateUpdateRequest);
  if (
    signal ||
    code !== NPM_UPDATE_REQUESTED_EXIT_CODE ||
    !request ||
    request.nonce !== launch.nonce ||
    request.packageName !== NPM_DESKTOP_PACKAGE_NAME ||
    request.fromVersion !== launch.currentVersion ||
    !semver.valid(request.toVersion) ||
    !semver.gt(request.toVersion, request.fromVersion)
  ) {
    if (request) {
      const resultPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.result);
      writeResult(resultPath, request, {
        outcome: "failed",
        npmExitStatus: null,
        summary:
          code === NPM_UPDATE_REQUESTED_EXIT_CODE
            ? "The update request was rejected because its authority did not validate."
            : "Update could not start because Vibestudio did not shut down cleanly.",
        installedVersion: readInstalledVersion(launch.packageRoot),
      });
      return relaunchInstalled({
        packageRoot: launch.packageRoot,
        resultPath,
        systemNode,
      });
    }
    return { handled: false };
  }

  const reproven = await resolveNpmGlobalInstall(launch.packageRoot, {
    centralDataPath,
    useCache: false,
  });
  const resultPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.result);
  if (
    !reproven ||
    !reproven.canInstall ||
    reproven.globalPrefix !== launch.globalPrefix ||
    reproven.globalRoot !== launch.globalRoot
  ) {
    writeResult(resultPath, request, {
      outcome: "failed",
      npmExitStatus: null,
      summary: "The npm global installation could not be revalidated as writable.",
      installedVersion: readInstalledVersion(launch.packageRoot),
    });
    return relaunchInstalled({
      packageRoot: launch.packageRoot,
      resultPath,
      systemNode,
    });
  }

  const lock = acquireUpdateLock(centralDataPath, request.toVersion, resultPath);
  if (!lock) {
    writeResult(resultPath, request, {
      outcome: "failed",
      npmExitStatus: null,
      summary: "Another Vibestudio update is already in progress.",
      installedVersion: readInstalledVersion(launch.packageRoot),
    });
    return relaunchInstalled({
      packageRoot: launch.packageRoot,
      resultPath,
      systemNode,
    });
  }

  const logPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.log);
  let targetRun = null;
  let restoreRun = null;
  try {
    appendPhase(logPath, "lock-acquired", `target=${request.toVersion}`);
    appendPhase(logPath, "shutdown-confirmed", `from=${request.fromVersion}`);
    if (semverMajor(request.toVersion) !== semverMajor(request.fromVersion)) {
      try {
        const retained = publishHistoricalHostSnapshot({
          centralDataPath,
          artifactRoot: launch.packageRoot,
          appRoot: launch.packageRoot,
          serverEntry: path.join(launch.packageRoot, "dist", "server.mjs"),
          executable: systemNode,
          appVersion: request.fromVersion,
        });
        appendPhase(logPath, "historical-host-retained", retained.destination);
      } catch (error) {
        const summary = `The outgoing workspace host could not be retained: ${
          error instanceof Error ? error.message : String(error)
        }`;
        appendPhase(logPath, "historical-host-retention-failed", summary);
        writeResult(resultPath, request, {
          outcome: "failed",
          npmExitStatus: null,
          summary,
          installedVersion: readInstalledVersion(launch.packageRoot),
          logPath,
        });
        return await relaunchInstalled({
          packageRoot: launch.packageRoot,
          resultPath,
          systemNode,
        });
      }
    }
    targetRun = await runNpmInstall(reproven, request.toVersion, logPath);
    const targetVersion = readInstalledVersion(launch.packageRoot);
    if (targetRun.code === 0 && targetVersion === request.toVersion) {
      appendPhase(logPath, "manifest-verified", `version=${targetVersion}`);
      writeResult(resultPath, request, {
        outcome: "succeeded",
        npmExitStatus: targetRun.code,
        summary: `Updated Vibestudio to ${request.toVersion}.`,
        installedVersion: targetVersion,
        logPath,
      });
      return await relaunchInstalled({
        packageRoot: launch.packageRoot,
        resultPath,
        systemNode,
      });
    }

    appendPhase(
      logPath,
      "restore-started",
      `target-status=${formatStatus(targetRun)} manifest=${targetVersion ?? "missing"}`
    );
    restoreRun = await runNpmInstall(reproven, request.fromVersion, logPath);
    const restoredVersion = readInstalledVersion(launch.packageRoot);
    const restored = restoreRun.code === 0 && restoredVersion === request.fromVersion;
    appendPhase(
      logPath,
      "restore-finished",
      `status=${formatStatus(restoreRun)} manifest=${restoredVersion ?? "missing"}`
    );
    writeResult(resultPath, request, {
      outcome: restored ? "restored" : "failed",
      npmExitStatus: targetRun.code,
      summary: restored
        ? `The update failed; Vibestudio ${request.fromVersion} was restored. ${targetRun.summary}`
        : `The update and restoration both failed. ${targetRun.summary} ${restoreRun.summary}`,
      installedVersion: restoredVersion,
      logPath,
    });
    if (restored) {
      return await relaunchInstalled({
        packageRoot: launch.packageRoot,
        resultPath,
        systemNode,
      });
    }
    return { handled: true, relaunched: false, resultPath };
  } finally {
    if (lock) releaseUpdateLock(lock);
  }
}

function validateProvenancePaths(packageRoot, globalRootInput, globalPrefixInput, platform) {
  try {
    const globalRoot = canonicalPath(globalRootInput);
    const globalPrefix = canonicalPath(globalPrefixInput);
    const expectedPackageRoot = canonicalPath(path.join(globalRoot, "@panticonic", "vibestudio"));
    if (!samePath(packageRoot, expectedPackageRoot, platform)) return null;
    const expectedGlobalRoot =
      platform === "win32"
        ? path.join(globalPrefix, "node_modules")
        : path.join(globalPrefix, "lib", "node_modules");
    if (!samePath(globalRoot, canonicalPath(expectedGlobalRoot), platform)) return null;
    return { globalRoot, globalPrefix };
  } catch {
    return null;
  }
}

function canMutateGlobalInstall(globalRoot, globalPrefix, platform) {
  const targets = [
    globalRoot,
    path.join(globalRoot, "@panticonic"),
    platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin"),
  ];
  return targets.every((target) => {
    try {
      fs.accessSync(nearestExistingDirectory(target), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function nearestExistingDirectory(input) {
  let current = path.resolve(input);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Walk up to the directory npm would need to create into.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function resolveNpmExecutable(env, platform) {
  const executable = resolveExecutable(platform === "win32" ? "npm.cmd" : "npm", env, platform);
  if (!executable || platform !== "win32") return executable;
  const npmCli = path.join(path.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(npmCli) ? canonicalPath(npmCli) : null;
}

function resolveExecutable(name, env, platform) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? canonicalPath(name) : null;
  const extensions =
    platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names = path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension}`);
  for (const directory of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const candidateName of names) {
      const candidate = path.resolve(directory, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return canonicalPath(candidate);
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
}

function runBounded(executable, args, { timeoutMs, env, cwd }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const command = npmCommand(executable, args);
    const child = spawn(command.executable, command.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_SUMMARY_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_SUMMARY_BYTES);
    });
    child.once("error", (error) =>
      finish({ code: null, stdout, stderr: error.message, timedOut: false })
    );
    child.once("exit", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

async function runNpmInstall(provenance, version, logPath) {
  appendPhase(logPath, "install-started", `version=${version}`);
  const args = [
    "install",
    "--global",
    "--prefix",
    provenance.globalPrefix,
    `${NPM_DESKTOP_PACKAGE_NAME}@${version}`,
  ];
  const timeoutMs = positiveInteger(process.env["VIBESTUDIO_NPM_UPDATE_TIMEOUT_MS"])
    ? Number(process.env["VIBESTUDIO_NPM_UPDATE_TIMEOUT_MS"])
    : INSTALL_TIMEOUT_MS;
  return new Promise((resolve) => {
    let summary = "";
    let writtenBytes = 0;
    let settled = false;
    let timingOut = false;
    const command = npmCommand(provenance.npmExecutable, args);
    const child = spawn(command.executable, command.args, {
      cwd: provenance.globalPrefix,
      env: process.env,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (kind, chunk) => {
      const text = sanitizeLogOutput(String(chunk));
      summary = `${summary}${text}`.slice(-MAX_SUMMARY_BYTES);
      if (writtenBytes >= MAX_LOG_BYTES) return;
      const bounded = Buffer.from(`[npm:${kind}] ${text}`).subarray(
        0,
        MAX_LOG_BYTES - writtenBytes
      );
      fs.appendFileSync(logPath, bounded, { mode: 0o600 });
      writtenBytes += bounded.length;
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    const timer = setTimeout(() => {
      timingOut = true;
      void terminateOwnedProcessTree(child.pid, {
        termTimeoutMs: 5_000,
        killTimeoutMs: 5_000,
      }).then((termination) => {
        finish({
          code: null,
          timedOut: true,
          summary: `npm timed out after ${timeoutMs}ms; tree gone=${termination.gone}. ${summary}`,
        });
      });
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const boundedSummary = sanitizeSummary(result.summary || summary);
      appendPhase(
        logPath,
        "install-finished",
        `version=${version} status=${result.code ?? "none"} timedOut=${result.timedOut === true}`
      );
      resolve({ ...result, summary: boundedSummary });
    };
    child.once("error", (error) => finish({ code: null, timedOut: false, summary: error.message }));
    child.once("exit", (code, signal) => {
      if (timingOut) return;
      void (async () => {
        let treeDetail = "";
        if (child.pid) {
          const termination = await terminateOwnedProcessTree(child.pid, {
            termTimeoutMs: 500,
            killTimeoutMs: 5_000,
          });
          if (!termination.gone) treeDetail = " npm descendants survived process exit";
        }
        finish({
          code: treeDetail ? null : code,
          timedOut: false,
          summary: `${summary}${signal ? ` terminated by ${signal}` : ""}${treeDetail}`,
        });
      })();
    });
  });
}

async function relaunchInstalled({ packageRoot, resultPath, systemNode }) {
  const launcher = path.join(packageRoot, "scripts", "vibestudio-launcher.mjs");
  if (!fs.existsSync(launcher)) {
    return { handled: true, relaunched: false, resultPath };
  }
  appendPhase(path.join(path.dirname(resultPath), NPM_UPDATE_FILES.log), "relaunch-started", "");
  const child = spawn(systemNode, [launcher], {
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: { ...process.env, [NPM_UPDATE_ENV.resultPath]: resultPath },
  });
  child.unref();
  if (!child.pid) return { handled: true, relaunched: false, resultPath };
  return { handled: true, relaunched: true, resultPath };
}

function acquireUpdateLock(centralDataPath, targetVersion, resultPath) {
  fs.mkdirSync(centralDataPath, { recursive: true, mode: 0o700 });
  const lockPath = path.join(centralDataPath, NPM_UPDATE_FILES.lock);
  const token = randomUUID();
  const record = {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    pid: process.pid,
    targetVersion,
    startedAt: new Date().toISOString(),
    token,
    resultPath,
  };
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { path: lockPath, token, record };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readLock(lockPath);
    if (existing && lockIsStale(existing)) {
      removeMatchingLock(lockPath, existing.token);
      return acquireUpdateLock(centralDataPath, targetVersion, resultPath);
    }
    return null;
  }
}

function releaseUpdateLock(lock) {
  appendPhase(
    path.join(path.dirname(lock.record.resultPath), NPM_UPDATE_FILES.log),
    "lock-released",
    ""
  );
  removeMatchingLock(lock.path, lock.token);
}

function readLock(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (
      value?.contractVersion !== NPM_UPDATE_CONTRACT_VERSION ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== "string" ||
      typeof value.token !== "string"
    ) {
      return { pid: -1, startedAt: "", token: "invalid" };
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { pid: -1, startedAt: "", token: "invalid" };
  }
}

function lockIsStale(lock) {
  const age = Date.now() - Date.parse(lock.startedAt);
  return !pidAlive(lock.pid) || !Number.isFinite(age) || age > LOCK_STALE_MS;
}

function removeMatchingLock(lockPath, token) {
  try {
    const current = readLock(lockPath);
    if (current?.token === token) fs.rmSync(lockPath);
  } catch {
    // A later launcher owns any replacement lock.
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function writeResult(resultPath, request, values) {
  const logPath = values.logPath ?? path.join(path.dirname(resultPath), NPM_UPDATE_FILES.log);
  appendPhase(logPath, "result-recorded", `outcome=${values.outcome} target=${request.toVersion}`);
  writePrivateJsonAtomic(resultPath, {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    fromVersion: request.fromVersion,
    toVersion: request.toVersion,
    outcome: values.outcome,
    npmExitStatus: values.npmExitStatus,
    summary: sanitizeSummary(values.summary),
    logPath,
    completedAt: new Date().toISOString(),
    installedVersion: values.installedVersion,
  });
}

function readInstalledVersion(packageRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return semver.valid(value?.version) ? value.version : null;
  } catch {
    return null;
  }
}

function appendPhase(logPath, phase, detail) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    logPath,
    `${new Date().toISOString()} ${phase}${detail ? ` ${detail}` : ""}\n`,
    {
      mode: 0o600,
    }
  );
}

function sanitizeSummary(value) {
  return String(value)
    .replace(/(_authToken|token|password)\s*=\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-MAX_SUMMARY_BYTES);
}

function sanitizeLogOutput(value) {
  return String(value)
    .replace(/(_authToken|token|password)\s*=\s*\S+/gi, "$1=[redacted]")
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, "$1[redacted]");
}

function formatStatus(run) {
  return run.timedOut ? "timeout" : String(run.code ?? "error");
}

function positiveInteger(value) {
  return /^\d+$/.test(value ?? "") && Number(value) > 0;
}

function npmCommand(npmExecutable, args) {
  return npmExecutable.endsWith(".js")
    ? { executable: process.execPath, args: [npmExecutable, ...args] }
    : { executable: npmExecutable, args };
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a, b, platform) {
  return platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(cachePath, value) {
  try {
    writePrivateJsonAtomic(cachePath, value);
  } catch {
    // Provenance remains valid for this invocation; cache failure only costs time.
  }
}

function pruneUpdateDirectories() {
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("vibestudio-npm-update-")) continue;
    const target = path.join(os.tmpdir(), entry.name);
    try {
      if (Date.now() - fs.statSync(target).mtimeMs > UPDATE_DIRECTORY_MAX_AGE_MS) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Best-effort bounded retention.
    }
  }
}
