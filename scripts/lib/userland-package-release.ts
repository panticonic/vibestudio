import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import semver from "semver";
import { getInstalledNodeRuntime } from "../../packages/shared/src/runtimePaths.js";

interface Artifact {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  integrity: string;
  dependencies: Record<string, string>;
}

/** Host validation only: exercise packed release bytes before they can be published to the registry. */
export function installUserlandPackageRelease(options: {
  appRoot: string;
  releaseFile: string;
  dependencies: Readonly<Record<string, string>>;
  overrides: Readonly<Record<string, string>>;
}): { nodeModulesDir: string; release(): void } {
  const releaseFile = fs.realpathSync(options.releaseFile);
  const release = JSON.parse(fs.readFileSync(releaseFile, "utf8")) as { artifacts: Artifact[] };
  if (!Array.isArray(release.artifacts) || release.artifacts.length === 0)
    throw new Error("Package release must contain packed artifacts");
  const artifacts = new Map<string, Artifact>();
  const replacements: Record<string, string> = {};
  for (const artifact of release.artifacts) {
    if (
      artifacts.has(artifact.name) ||
      !semver.valid(artifact.version) ||
      path.basename(artifact.filename) !== artifact.filename
    )
      throw new Error("Package release has an invalid or duplicate artifact identity");
    const archive = fs.realpathSync(path.join(path.dirname(releaseFile), artifact.filename));
    if (path.dirname(archive) !== path.dirname(releaseFile))
      throw new Error("Package release archive escapes its directory");
    const bytes = fs.readFileSync(archive);
    if (
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 ||
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity
    )
      throw new Error(`Package release integrity mismatch: ${artifact.name}`);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
    );
    if (
      manifest.name !== artifact.name ||
      manifest.version !== artifact.version ||
      JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(artifact.dependencies)
    )
      throw new Error(`Package release manifest mismatch: ${artifact.name}`);
    artifacts.set(artifact.name, artifact);
    replacements[artifact.name] = `file:${archive}`;
  }
  const reachable = new Set<string>();
  function visit(name: string, requirement: string): void {
    const artifact = artifacts.get(name);
    if (!artifact) return;
    if (!semver.satisfies(artifact.version, requirement, { includePrerelease: true }))
      throw new Error(
        `Package release ${name}@${artifact.version} does not satisfy ${requirement}`
      );
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const [dependency, version] of Object.entries(artifact.dependencies))
      visit(dependency, version);
  }
  for (const [name, requirement] of Object.entries(options.dependencies)) visit(name, requirement);
  if (reachable.size !== artifacts.size)
    throw new Error("Package release contains artifacts outside the declared dependency closure");
  for (const [selector, requirement] of Object.entries(options.overrides)) {
    for (const artifact of artifacts.values()) {
      if (
        (selector === artifact.name || selector.startsWith(`${artifact.name}@`)) &&
        !semver.satisfies(artifact.version, requirement, { includePrerelease: true })
      )
        throw new Error(`Package release conflicts with dependency override ${selector}`);
    }
  }
  const parent = path.join(options.appRoot, ".cache");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "userland-package-release-"));
  const retire = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const dependencies = { ...options.dependencies, ...replacements };
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "userland-package-release-validation",
        version: "0.0.0",
        private: true,
        dependencies,
        overrides: {
          ...options.overrides,
          ...Object.fromEntries(Object.keys(replacements).map((name) => [name, `$${name}`])),
        },
      })
    );
    const runtime = getInstalledNodeRuntime(options.appRoot);
    execFileSync(
      runtime.executable,
      [
        runtime.npmCli,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        "--registry",
        "https://registry.npmjs.org",
        "--cache",
        path.join(root, "npm-cache"),
      ],
      { cwd: root, stdio: "inherit" }
    );
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { integrity?: string }>;
    };
    for (const artifact of artifacts.values()) {
      const installed = JSON.parse(
        fs.readFileSync(path.join(root, "node_modules", artifact.name, "package.json"), "utf8")
      );
      if (
        installed.name !== artifact.name ||
        installed.version !== artifact.version ||
        lock.packages[`node_modules/${artifact.name}`]?.integrity !== artifact.integrity
      )
        throw new Error(`Package release resolved another installed artifact: ${artifact.name}`);
    }
    return { nodeModulesDir: path.join(root, "node_modules"), release: retire };
  } catch (error) {
    retire();
    throw error;
  }
}
