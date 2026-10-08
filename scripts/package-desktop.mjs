import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Arch, Platform, build } from "electron-builder";

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

export async function packageDesktop(
  platformName,
  { appRoot = process.cwd(), runBuild = build, arch = process.arch } = {}
) {
  const platform = Platform.fromString(platformName);
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
  const targets = targetSpecs
    .filter((target) => target.arch.includes(arch))
    .map((target) => target.target);
  const staging = fs.mkdtempSync(path.join(output, `.package-${platform.nodeName}-${arch}-`));
  try {
    const config = structuredClone(base);
    config.directories.output = staging;
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
    });
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
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return published;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageDesktop(process.argv[2], { arch: process.argv[3] ?? process.arch }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
