import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-only-"));
const checkout = path.join(temporaryParent, "checkout");
const omitted = new Set([".git", "dist", "node_modules", "workspace"]);

function linkInstalledDependencies(checkoutRoot) {
  const installedRoot = path.join(repositoryRoot, "node_modules");
  const targetRoot = path.join(checkoutRoot, "node_modules");
  fs.mkdirSync(targetRoot);
  for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
    const source = path.join(installedRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.name === "@workspace") {
      continue;
    }
    if (entry.name !== "@vibestudio") {
      fs.symlinkSync(source, target, entry.isDirectory() ? "dir" : "file");
      continue;
    }
    fs.mkdirSync(target);
    const localPackages = new Map();
    for (const directory of fs.readdirSync(path.join(checkoutRoot, "packages"))) {
      const manifestPath = path.join(checkoutRoot, "packages", directory, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string") {
        localPackages.set(manifest.name.slice("@vibestudio/".length), path.dirname(manifestPath));
      }
    }
    for (const [name, packageRoot] of localPackages) {
      fs.symlinkSync(packageRoot, path.join(target, name), "dir");
    }
    for (const dependency of fs.readdirSync(source, { withFileTypes: true })) {
      if (localPackages.has(dependency.name)) continue;
      fs.symlinkSync(path.join(source, dependency.name), path.join(target, dependency.name), "dir");
    }
  }
}

try {
  fs.cpSync(repositoryRoot, checkout, {
    recursive: true,
    filter(source) {
      if (source === repositoryRoot) return true;
      const relative = path.relative(repositoryRoot, source);
      const segments = relative.split(path.sep);
      return !omitted.has(segments[0] ?? "") && !segments.includes("node_modules");
    },
  });
  linkInstalledDependencies(checkout);

  const checks = [
    { label: "production build", command: process.execPath, args: ["build.mjs"] },
    {
      label: "host typecheck",
      command: process.execPath,
      args: ["node_modules/typescript/bin/tsc", "--noEmit"],
    },
    {
      label: "host isolation tests",
      command: process.execPath,
      args: [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.host.config.ts",
        "src/server/acquireRootTemplateSnapshot.test.ts",
        "src/server/workspaceRootTemplateBootstrap.test.ts",
        "src/server/runtimeExecutionIdentity.test.ts",
        "tests/host-boundary-checker.test.ts",
      ],
    },
  ];
  for (const check of checks) {
    const result = spawnSync(check.command, check.args, {
      cwd: checkout,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Host-only ${check.label} exited with status ${result.status ?? "unknown"}`);
    }
  }
  console.log(
    "Host production build, typecheck, and root-bootstrap/boundary tests passed with workspace/ absent."
  );
} finally {
  fs.rmSync(temporaryParent, { recursive: true, force: true });
}
