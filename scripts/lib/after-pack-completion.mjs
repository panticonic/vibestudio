import * as fs from "node:fs";
import * as path from "node:path";

export const AFTER_PACK_COMPLETION_FORMAT = "vibestudio-electron-after-pack/1";

export function afterPackCompletionPath(outputDirectory, platform, arch) {
  if (!/^[a-z][a-z0-9-]*$/u.test(platform) || !Number.isInteger(arch))
    throw new Error("Invalid electron afterPack completion identity");
  return path.join(outputDirectory, `.vibestudio-after-pack-${platform}-${arch}.json`);
}

/** Publish the completion witness beside, never inside, the signed app bundle. */
export function writeAfterPackCompletion(context) {
  const outputDirectory = path.resolve(context.outDir);
  const appOutDir = path.resolve(context.appOutDir);
  if (path.dirname(appOutDir) !== outputDirectory)
    throw new Error(`Packaged application is not a child of its output directory: ${appOutDir}`);
  const receiptPath = afterPackCompletionPath(
    outputDirectory,
    context.electronPlatformName,
    context.arch
  );
  const receipt = {
    format: AFTER_PACK_COMPLETION_FORMAT,
    platform: context.electronPlatformName,
    arch: context.arch,
    appOutDir: path.basename(appOutDir),
  };
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, receiptPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return receiptPath;
}

/** Consume the exact hook-completion witness after the configured build joins. */
export function consumeAfterPackCompletion(outputDirectory, platform, arch, expectedAppOutDir) {
  const receiptPath = afterPackCompletionPath(outputDirectory, platform, arch);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `Desktop build returned without completing its afterPack hook: ${receiptPath}`,
      {
        cause,
      }
    );
  }
  if (
    receipt?.format !== AFTER_PACK_COMPLETION_FORMAT ||
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    typeof receipt.appOutDir !== "string" ||
    !receipt.appOutDir ||
    path.basename(receipt.appOutDir) !== receipt.appOutDir ||
    receipt.appOutDir !== expectedAppOutDir
  )
    throw new Error(`Desktop afterPack completion witness does not match ${platform}/${arch}`);
  fs.rmSync(receiptPath);
  return receipt;
}
