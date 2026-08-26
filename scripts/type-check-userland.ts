import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareUserlandDependencyProjection,
  type UserlandDependencyProjection,
} from "./lib/userland-dependency-projection.js";
import { requireDevelopmentBaseCheckout } from "../src/dev/developmentBaseConfig.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceArgumentIndex = process.argv.indexOf("--workspace-root");
if (workspaceArgumentIndex >= 0 && !process.argv[workspaceArgumentIndex + 1]) {
  throw new Error("--workspace-root requires a directory");
}
const workspaceRoot = path.resolve(
  workspaceArgumentIndex >= 0
    ? process.argv[workspaceArgumentIndex + 1]!
    : requireDevelopmentBaseCheckout(appRoot)
);
const compiler = path.join(appRoot, "node_modules", "typescript", "bin", "tsc");
const projection = await prepareUserlandDependencyProjection({
  appRoot,
  workspaceRoot,
  includeDevelopmentDependencies: true,
});
const temporaryParent = path.join(appRoot, ".cache");
fs.mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "checkout-typecheck-"));
let failed = false;

try {
  projectCheckoutSource(temporaryRoot, projection.units);
  projectNodeModules(temporaryRoot, [
    projection.nodeModulesDir,
    path.join(appRoot, "node_modules"),
  ]);

  for (const configName of [
    "tsconfig.json",
    "tsconfig.integration.json",
    "tsconfig.integration.mobile.json",
  ]) {
    const projectedConfig = path.join(temporaryRoot, "workspace", configName);
    try {
      execFileSync(compiler, ["--project", projectedConfig, "--pretty", "false"], {
        cwd: temporaryRoot,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
      });
      console.log(`✓ ${path.relative(appRoot, workspaceRoot)}/${configName}`);
    } catch (error) {
      failed = true;
      const result = error as { stdout?: string; stderr?: string };
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  projection.release();
}

if (failed) {
  console.error("Userland typecheck failed.");
  process.exitCode = 1;
} else {
  console.log("✓ Userland typecheck passed using the semantic dependency projection.");
}

function projectCheckoutSource(
  targetRoot: string,
  units: UserlandDependencyProjection["units"]
): void {
  const projectedWorkspace = path.join(targetRoot, "workspace");
  fs.mkdirSync(projectedWorkspace, { recursive: true });
  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".cache") continue;
    const source = path.join(workspaceRoot, entry.name);
    const target = path.join(projectedWorkspace, entry.name);
    if (entry.isDirectory()) linkDirectory(source, target);
    else if (entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
      fs.copyFileSync(source, target);
      addDiscoveredPackagePaths(target, units);
    }
  }
  for (const entry of ["apps", "packages", "src", "tests"]) {
    linkDirectory(path.join(appRoot, entry), path.join(targetRoot, entry));
  }
}

interface UnitManifest {
  exports?: Record<string, unknown> | string;
}

/**
 * TypeScript's root wildcard is only a convenience for conventional package
 * entrypoints. Exact semantic packages are authoritative for their own export
 * map, including exports introduced by a contribution template. Derive those
 * paths from the discovered graph instead of teaching Base about every future
 * package name.
 */
function addDiscoveredPackagePaths(
  configPath: string,
  units: UserlandDependencyProjection["units"]
): void {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  if (!config.compilerOptions?.paths) return;
  const paths = { ...(config.compilerOptions?.paths ?? {}) };
  paths["@exact-userland/*"] = ["./*"];
  for (const unit of units) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(unit.path, "package.json"), "utf8")
    ) as UnitManifest;
    for (const [subpath, target] of normalizedExports(manifest.exports)) {
      const specifier = subpath === "." ? unit.name : `${unit.name}/${subpath.slice(2)}`;
      paths[specifier] = [`./${unit.relativePath}/${target.replace(/^\.\//, "")}`];
    }
  }
  config.compilerOptions = { ...(config.compilerOptions ?? {}), paths };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalizedExports(exports: UnitManifest["exports"]): Array<[string, string]> {
  if (typeof exports === "string") return [[".", exports]];
  if (!exports) return [];
  return Object.entries(exports).flatMap(([subpath, value]) => {
    const target = exportTarget(value);
    return target && (subpath === "." || subpath.startsWith("./")) ? [[subpath, target]] : [];
  });
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["types", "browser", "import", "default"]) {
    const target = exportTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}

function projectNodeModules(targetRoot: string, sourceRoots: string[]): void {
  const target = path.join(targetRoot, "node_modules");
  fs.mkdirSync(target, { recursive: true });
  for (const sourceRoot of sourceRoots.filter(Boolean)) mergeNodeModules(sourceRoot, target);
  linkDirectory(target, path.join(targetRoot, "workspace", "node_modules"));
}

function mergeNodeModules(sourceRoot: string, targetRoot: string): void {
  if (!fs.existsSync(sourceRoot)) return;
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === ".bin") continue;
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const scopedEntry of fs.readdirSync(sourceRoot + path.sep + entry.name, {
        withFileTypes: true,
      })) {
        if (scopedEntry.name.startsWith(".")) continue;
        const scopedTarget = path.join(target, scopedEntry.name);
        if (!fs.existsSync(scopedTarget)) {
          linkDirectory(path.join(source, scopedEntry.name), scopedTarget);
        }
      }
    } else if (!fs.existsSync(target)) {
      linkDirectory(source, target);
    }
  }
}

function linkDirectory(source: string, target: string): void {
  fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}
