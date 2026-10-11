import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { vibestudioCacheDir } from "../cli/lib/android-platform-tools.mjs";

const execFile = promisify(execFileCallback);
export const actionlintVersion = "1.7.12";

const targets = {
  "darwin-x64": {
    archive: `actionlint_${actionlintVersion}_darwin_amd64.tar.gz`,
    sha256: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    executable: "actionlint",
    format: "tar.gz",
  },
  "darwin-arm64": {
    archive: `actionlint_${actionlintVersion}_darwin_arm64.tar.gz`,
    sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    executable: "actionlint",
    format: "tar.gz",
  },
  "linux-x64": {
    archive: `actionlint_${actionlintVersion}_linux_amd64.tar.gz`,
    sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    executable: "actionlint",
    format: "tar.gz",
  },
  "linux-arm64": {
    archive: `actionlint_${actionlintVersion}_linux_arm64.tar.gz`,
    sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    executable: "actionlint",
    format: "tar.gz",
  },
  "win32-x64": {
    archive: `actionlint_${actionlintVersion}_windows_amd64.zip`,
    sha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
    executable: "actionlint.exe",
    format: "zip",
  },
  "win32-arm64": {
    archive: `actionlint_${actionlintVersion}_windows_arm64.zip`,
    sha256: "cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41",
    executable: "actionlint.exe",
    format: "zip",
  },
};

export function actionlintTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = targets[key];
  if (!target) throw new Error(`Pinned actionlint ${actionlintVersion} is unavailable for ${key}.`);
  return { ...target, key };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function run(executable, args) {
  return execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function assertActionlint(executable, target) {
  const { stdout, stderr } = await run(executable, ["-version"]);
  const version = `${stdout}\n${stderr}`;
  if (!new RegExp(`(?:^|\\s)${actionlintVersion.replaceAll(".", "\\.")}(?:\\s|$)`).test(version)) {
    throw new Error(`Cached actionlint did not report pinned version ${actionlintVersion}.`);
  }
  return executable;
}

async function assertCachedArtifact(executable, receiptPath, target) {
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (
    receipt.version !== actionlintVersion ||
    receipt.target !== target.key ||
    receipt.archiveSha256 !== target.sha256 ||
    typeof receipt.executableSha256 !== "string"
  ) {
    throw new Error("Cached actionlint artifact receipt does not match the pinned target.");
  }
  const executableBytes = await fs.readFile(executable);
  if (sha256(executableBytes) !== receipt.executableSha256) {
    throw new Error("Cached actionlint executable does not match its verified receipt.");
  }
  return assertActionlint(executable, target);
}

async function extractArchive(archivePath, destination, target, platform) {
  await fs.mkdir(destination, { recursive: true });
  if (target.format === "zip") {
    // Windows includes tar.exe, which supports zip extraction on supported runners.
    await run("tar", ["-xf", archivePath, "-C", destination]);
  } else {
    await run("tar", ["-xzf", archivePath, "-C", destination]);
  }
  const executable = path.join(destination, target.executable);
  if (platform !== "win32") await fs.chmod(executable, 0o755);
  return executable;
}

export async function withOwnedTemporaryDirectory(parent, operation, remove = fs.rm) {
  const temporary = await fs.mkdtemp(path.join(parent, ".install-"));
  let result;
  let operationFailure;
  let operationFailed = false;
  try {
    result = await operation(temporary);
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  let cleanupFailure;
  let cleanupFailed = false;
  try {
    await remove(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Actionlint installation and its temporary-directory cleanup both failed.",
      { cause: operationFailure }
    );
  }
  if (operationFailed) throw operationFailure;
  if (cleanupFailed) throw cleanupFailure;
  return result;
}

export async function resolveActionlint({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = path.join(vibestudioCacheDir(), "actionlint"),
  fetchImpl = fetch,
  extract = extractArchive,
} = {}) {
  const target = actionlintTarget(platform, arch);
  const installRoot = path.join(cacheRoot, actionlintVersion, target.key);
  const executable = path.join(installRoot, target.executable);
  const receiptPath = path.join(installRoot, "artifact.json");

  let cachePresent = false;
  try {
    await fs.access(installRoot);
    cachePresent = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (cachePresent) {
    try {
      return await assertCachedArtifact(executable, receiptPath, target);
    } catch (error) {
      throw new Error(`Pinned actionlint cache entry failed verification at ${installRoot}.`, {
        cause: error,
      });
    }
  }

  const response = await fetchImpl(
    `https://github.com/rhysd/actionlint/releases/download/v${actionlintVersion}/${target.archive}`
  );
  if (!response.ok)
    throw new Error(`Could not download pinned actionlint archive (HTTP ${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== target.sha256) {
    throw new Error(`Pinned actionlint archive checksum mismatch for ${target.key}.`);
  }

  await fs.mkdir(cacheRoot, { recursive: true });
  return withOwnedTemporaryDirectory(cacheRoot, async (temporary) => {
    let result;
    const archivePath = path.join(temporary, target.archive);
    const unpacked = path.join(temporary, "unpacked");
    await fs.writeFile(archivePath, archive);
    const extractedExecutable = await extract(archivePath, unpacked, target, platform);
    await assertActionlint(extractedExecutable, target);
    const executableSha256 = sha256(await fs.readFile(extractedExecutable));
    await fs.writeFile(
      path.join(unpacked, "artifact.json"),
      `${JSON.stringify(
        {
          version: actionlintVersion,
          target: target.key,
          archiveSha256: target.sha256,
          executableSha256,
        },
        null,
        2
      )}\n`
    );

    await fs.mkdir(path.dirname(installRoot), { recursive: true });
    try {
      await fs.rename(unpacked, installRoot);
    } catch (error) {
      // A concurrent checker may have published this same pinned artifact.
      try {
        result = await assertCachedArtifact(executable, receiptPath, target);
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          `Concurrent actionlint cache publication failed verification at ${installRoot}.`,
          { cause: error }
        );
      }
    }
    if (!result) result = await assertActionlint(executable, target);
    return result;
  });
}
