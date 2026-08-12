import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareUserlandDependencyProjection } from "./lib/userland-dependency-projection.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(appRoot, "workspace");
const compiler = path.join(appRoot, "node_modules", "typescript", "bin", "tsc");
const projection = await prepareUserlandDependencyProjection({
  appRoot,
  includeDevelopmentDependencies: true,
});
const temporaryParent = path.join(workspaceRoot, ".cache");
fs.mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "checkout-typecheck-"));
let failed = false;

try {
  projectCheckoutSource(temporaryRoot);
  projectNodeModules(temporaryRoot, [
    path.join(appRoot, "node_modules"),
    projection.nodeModulesDir,
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
      console.log(`✓ workspace/${configName}`);
    } catch (error) {
      failed = true;
      const result = error as { stdout?: string; stderr?: string };
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failed) {
  console.error("Userland typecheck failed.");
  process.exitCode = 1;
} else {
  console.log("✓ Userland typecheck passed using the semantic dependency projection.");
}

function projectCheckoutSource(targetRoot: string): void {
  const projectedWorkspace = path.join(targetRoot, "workspace");
  fs.mkdirSync(projectedWorkspace, { recursive: true });
  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".cache") continue;
    const source = path.join(workspaceRoot, entry.name);
    const target = path.join(projectedWorkspace, entry.name);
    if (entry.isDirectory()) linkDirectory(source, target);
    else if (entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
      fs.copyFileSync(source, target);
    }
  }
  for (const entry of ["apps", "packages", "src", "tests"]) {
    linkDirectory(path.join(appRoot, entry), path.join(targetRoot, entry));
  }
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
