import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Arch, Platform, build, getArchSuffix } from "electron-builder";
import { includeDesktopRuntimeScriptClosure } from "./lib/npm-runtime-script-closure.mjs";
import { consumeAfterPackCompletion } from "./lib/after-pack-completion.mjs";

function supports(values, target) {
  if (!values || values.length === 0) return true;
  if (values.includes(`!${target}`)) return false;
  const allowed = values.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(target) || allowed.includes("any");
}

/** Platform declarations select the runtime closure; source installs may hold every build target. */
export function excludedNativePackages(appRoot, platform, arch) {
  const modules = path.join(appRoot, "node_modules");
  const excluded = [];
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const names = entry.name.startsWith("@")
      ? fs.readdirSync(path.join(modules, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name];
    for (const name of names) {
      const manifest = path.join(modules, name, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (
        !supports(pkg.os, platform) ||
        !supports(pkg.cpu, arch) ||
        (platform === "linux" && !supports(pkg.libc, "glibc"))
      )
        excluded.push(name);
    }
  }
  return excluded.sort();
}

/** electron-builder's output directory uses the configured default-architecture suffix. */
export function linuxAppDirectoryName(arch, linuxConfig) {
  const architecture = Arch[arch];
  if (typeof architecture !== "number") throw new Error(`Unsupported Linux architecture: ${arch}`);
  return `linux${getArchSuffix(architecture, linuxConfig.defaultArch)}-unpacked`;
}

/** Match electron-builder's canonical appOutDir naming for the requested target. */
export function appOutDirectoryName(platform, arch, config) {
  const architecture = Arch[arch];
  if (typeof architecture !== "number")
    throw new Error(`Unsupported desktop architecture: ${arch}`);
  const platformConfig = config[platform.buildConfigurationKey] ?? {};
  const suffix = getArchSuffix(architecture, platformConfig.defaultArch);
  const unpacked = platform === Platform.MAC ? "" : "-unpacked";
  return `${platform.buildConfigurationKey}${suffix}${unpacked}`;
}

export function linuxAppDirectoryNameFromRoot(appRoot, arch) {
  const config = parse(fs.readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8"));
  return linuxAppDirectoryName(arch, config.linux);
}

/** Reject a dir target unless its canonical prepared-release seal validates. */
export async function assertCompleteLinuxApplication(appDirectory, arch) {
  const manifestPath = path.join(appDirectory, "resources/userland-builds/release.json");
  const unregisterTsx = (await import("tsx/esm/api")).register();
  let manifest;
  try {
    const { preparedWorkspaceReleaseManifestSchema } =
      await import("../src/server/preparedWorkspaceRelease.ts");
    manifest = preparedWorkspaceReleaseManifestSchema.parse(
      JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    );
  } catch (cause) {
    throw new Error(
      `Linux application has no complete prepared workspace release: ${manifestPath}`,
      {
        cause,
      }
    );
  } finally {
    unregisterTsx();
  }
  if (manifest.platform !== "linux" || manifest.arch !== arch)
    throw new Error(`Prepared workspace release target does not match linux-${arch}`);
  for (const workspace of ["base", "personal", "system"]) {
    if (!manifest.builds.some((buildRecord) => buildRecord.workspace === workspace))
      throw new Error(`Prepared workspace release contains no ${workspace} runtime builds`);
  }
}

export async function packageDesktop(
  platformName,
  {
    appRoot = process.cwd(),
    runBuild = build,
    arch = process.arch,
    linuxMode,
    linuxFormat,
    prepackaged,
  } = {}
) {
  const platform = Platform.fromString(platformName);
  if (linuxMode && platformName !== "linux")
    throw new Error(`Linux packaging mode cannot target ${platformName}`);
  if (linuxMode && !["app", "format"].includes(linuxMode))
    throw new Error(`Unsupported Linux packaging mode: ${linuxMode}`);
  if (linuxMode === "format" && !linuxFormat)
    throw new Error("Linux format packaging requires one declared target");
  if (linuxMode !== "format" && prepackaged)
    throw new Error("A prepackaged application is only valid for Linux format packaging");
  const base = parse(fs.readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8"));
  const targetSpecs = base[platform.buildConfigurationKey].target;
  const output = path.resolve(appRoot, base.directories.output);
  fs.mkdirSync(output, { recursive: true });
  const declaredArchitectures = [...new Set(targetSpecs.flatMap((target) => target.arch))];
  if (!declaredArchitectures.includes(arch))
    throw new Error(`No ${platform.nodeName}-${arch} desktop release target is declared`);
  // Userland builds execute the installed native compiler/runtime closure.
  // Each architecture is packaged on its matching release runner.
  const published = [];
  const targets =
    linuxMode === "app"
      ? ["dir"]
      : linuxMode === "format"
        ? targetSpecs
            .filter((target) => target.arch.includes(arch) && target.target === linuxFormat)
            .map((target) => target.target)
        : targetSpecs.filter((target) => target.arch.includes(arch)).map((target) => target.target);
  if (linuxMode === "format" && targets.length !== 1)
    throw new Error(`No Linux ${arch} ${linuxFormat} desktop release target is declared`);
  const prepackagedPath = prepackaged ? path.resolve(appRoot, prepackaged) : undefined;
  if (linuxMode === "format" && (!prepackagedPath || !fs.statSync(prepackagedPath).isDirectory()))
    throw new Error(
      `Prepackaged Linux application is not a directory: ${prepackaged ?? "<missing>"}`
    );
  const staging = fs.mkdtempSync(path.join(output, `.package-${platform.nodeName}-${arch}-`));
  let operationSettled = false;
  let eventLoopDrainReported = false;
  const onBeforeExit = () => {
    if (operationSettled || eventLoopDrainReported) return;
    eventLoopDrainReported = true;
    console.error(
      new Error(
        `Desktop packaging for ${platform.nodeName}/${arch} remained pending after Node had no active work`
      ).stack
    );
    process.exitCode = 1;
    // beforeExit is the process's authoritative no-active-work boundary. The
    // packager promise has no remaining event-loop owner, so its finally block
    // cannot run; retire only this call's unique staging tree here.
    fs.rmSync(staging, { recursive: true, force: true });
  };
  process.on("beforeExit", onBeforeExit);
  try {
    const config = structuredClone(base);
    config.directories.output = staging;
    includeDesktopRuntimeScriptClosure(appRoot, config);
    config.files.push(
      ...excludedNativePackages(appRoot, platform.nodeName, arch).map(
        (name) => `!node_modules/${name}{,/**/*}`
      )
    );
    // Pass one complete configuration file. Passing this object as overrides
    // would merge the repository YAML again and duplicate resource copies.
    const configPath = path.join(staging, "configuration.json");
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const artifacts = await runBuild({
      projectDir: appRoot,
      targets: platform.createTarget(targets, Arch[arch]),
      publish: "never",
      config: configPath,
      ...(prepackagedPath ? { prepackaged: prepackagedPath } : {}),
    });
    if (!(linuxMode === "format" && prepackagedPath))
      consumeAfterPackCompletion(
        staging,
        platform.nodeName,
        Arch[arch],
        appOutDirectoryName(platform, arch, base)
      );
    if (linuxMode === "app") {
      const appDirectory = path.join(staging, linuxAppDirectoryName(arch, base.linux));
      const appStat = fs.lstatSync(appDirectory);
      if (!appStat.isDirectory() || appStat.isSymbolicLink())
        throw new Error(`Linux application target did not produce ${appDirectory}`);
      await assertCompleteLinuxApplication(appDirectory, arch);
      const destination = path.join(output, "linux-unpacked");
      if (fs.existsSync(destination))
        throw new Error(`Refusing to replace an existing Linux application: ${destination}`);
      fs.renameSync(appDirectory, destination);
      published.push(destination);
      return published;
    }
    for (const artifact of artifacts) {
      const relative = path.relative(staging, artifact);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Packager artifact escapes owned staging: ${artifact}`);
      }
      const destination = path.join(output, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(artifact, destination);
      published.push(destination);
    }
  } finally {
    // build() joins every archive/signing job before this operation retires its tree.
    operationSettled = true;
    process.off("beforeExit", onBeforeExit);
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return published;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platformName, modeOrArch, format, prepackaged, requestedArch] = process.argv.slice(2);
  if (platformName === "linux" && modeOrArch === "app-path") {
    try {
      process.stdout.write(`${linuxAppDirectoryNameFromRoot(process.cwd(), format)}\n`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  } else {
    const options =
      platformName === "linux" && modeOrArch === "app"
        ? { linuxMode: "app", arch: format ?? process.arch }
        : platformName === "linux" && modeOrArch === "format"
          ? {
              linuxMode: "format",
              linuxFormat: format,
              prepackaged,
              arch: requestedArch ?? process.arch,
            }
          : { arch: modeOrArch ?? process.arch };
    packageDesktop(platformName, options).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
