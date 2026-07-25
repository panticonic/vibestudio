import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NPM_UPDATE_CONTRACT_VERSION = 1;
// Only a normal Electron exit with this status and a nonce-bound request grants
// update authority. Signal-derived and crash-derived statuses never do.
export const NPM_UPDATE_REQUESTED_EXIT_CODE = 86;
export const NPM_DESKTOP_PACKAGE_NAME = "@panticonic/vibestudio";

export const NPM_UPDATE_ENV = Object.freeze({
  launch: "VIBESTUDIO_NPM_UPDATE_LAUNCH",
  resultPath: "VIBESTUDIO_NPM_UPDATE_RESULT",
});

export const NPM_UPDATE_FILES = Object.freeze({
  request: "request.json",
  result: "result.json",
  log: "update.log",
  lock: "npm-update.lock",
  provenanceCache: "npm-update-provenance.json",
});

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactSemver(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

export function validateUpdateLaunch(value) {
  if (!isRecord(value)) return null;
  const launchKeys = value.canInstall
    ? [
        "contractVersion",
        "packageName",
        "packageRoot",
        "globalRoot",
        "globalPrefix",
        "npmExecutable",
        "currentVersion",
        "canInstall",
        "requestDirectory",
        "nonce",
      ]
    : [
        "contractVersion",
        "packageName",
        "packageRoot",
        "globalRoot",
        "globalPrefix",
        "npmExecutable",
        "currentVersion",
        "canInstall",
      ];
  if (!hasExactKeys(value, launchKeys)) return null;
  const canInstall = value.canInstall;
  const baseValid =
    value.contractVersion === NPM_UPDATE_CONTRACT_VERSION &&
    value.packageName === NPM_DESKTOP_PACKAGE_NAME &&
    typeof value.packageRoot === "string" &&
    path.isAbsolute(value.packageRoot) &&
    typeof value.globalRoot === "string" &&
    path.isAbsolute(value.globalRoot) &&
    typeof value.globalPrefix === "string" &&
    path.isAbsolute(value.globalPrefix) &&
    typeof value.npmExecutable === "string" &&
    value.npmExecutable.length > 0 &&
    isExactSemver(value.currentVersion) &&
    typeof canInstall === "boolean";
  if (!baseValid) return null;
  if (canInstall) {
    if (
      typeof value.requestDirectory !== "string" ||
      !path.isAbsolute(value.requestDirectory) ||
      typeof value.nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.nonce)
    ) {
      return null;
    }
  } else if (value.requestDirectory !== undefined || value.nonce !== undefined) {
    return null;
  }
  return {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    packageRoot: value.packageRoot,
    globalRoot: value.globalRoot,
    globalPrefix: value.globalPrefix,
    npmExecutable: value.npmExecutable,
    currentVersion: value.currentVersion,
    canInstall,
    ...(canInstall ? { requestDirectory: value.requestDirectory, nonce: value.nonce } : {}),
  };
}

export function validateUpdateRequest(value) {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      "contractVersion",
      "action",
      "packageName",
      "nonce",
      "fromVersion",
      "toVersion",
      "requestedAt",
    ])
  ) {
    return null;
  }
  if (
    value.contractVersion !== NPM_UPDATE_CONTRACT_VERSION ||
    value.action !== "install-update" ||
    value.packageName !== NPM_DESKTOP_PACKAGE_NAME ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    !isExactSemver(value.fromVersion) ||
    !isExactSemver(value.toVersion) ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt))
  ) {
    return null;
  }
  return {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    action: "install-update",
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    nonce: value.nonce,
    fromVersion: value.fromVersion,
    toVersion: value.toVersion,
    requestedAt: value.requestedAt,
  };
}

export function validateUpdateResult(value) {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      "contractVersion",
      "packageName",
      "fromVersion",
      "toVersion",
      "outcome",
      "npmExitStatus",
      "summary",
      "logPath",
      "completedAt",
      "installedVersion",
    ])
  ) {
    return null;
  }
  if (
    value.contractVersion !== NPM_UPDATE_CONTRACT_VERSION ||
    value.packageName !== NPM_DESKTOP_PACKAGE_NAME ||
    !isExactSemver(value.fromVersion) ||
    !isExactSemver(value.toVersion) ||
    !["succeeded", "restored", "failed"].includes(value.outcome) ||
    (value.npmExitStatus !== null &&
      !(Number.isInteger(value.npmExitStatus) && Number.isSafeInteger(value.npmExitStatus))) ||
    typeof value.summary !== "string" ||
    typeof value.logPath !== "string" ||
    !path.isAbsolute(value.logPath) ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    (value.installedVersion !== null && !isExactSemver(value.installedVersion))
  ) {
    return null;
  }
  return {
    contractVersion: NPM_UPDATE_CONTRACT_VERSION,
    packageName: NPM_DESKTOP_PACKAGE_NAME,
    fromVersion: value.fromVersion,
    toVersion: value.toVersion,
    outcome: value.outcome,
    npmExitStatus: value.npmExitStatus,
    summary: value.summary.slice(0, 4_096),
    logPath: value.logPath,
    completedAt: value.completedAt,
    installedVersion: value.installedVersion,
  };
}

export function readPrivateJson(filePath, validator) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
    return validator(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function writePrivateJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

export function parseUpdateLaunchEnvironment(env = process.env) {
  const encoded = env[NPM_UPDATE_ENV.launch];
  if (!encoded) return null;
  try {
    return validateUpdateLaunch(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export function isPrivateUpdateFile(filePath, expectedBasename) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.basename(filePath) !== expectedBasename
  ) {
    return false;
  }
  const directory = path.dirname(filePath);
  if (!path.basename(directory).startsWith("vibestudio-npm-update-")) return false;
  if (path.resolve(path.dirname(directory)) !== path.resolve(os.tmpdir())) return false;
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      path.dirname(fs.realpathSync.native(directory)) === fs.realpathSync.native(os.tmpdir()) &&
      (process.platform === "win32" || (stat.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
