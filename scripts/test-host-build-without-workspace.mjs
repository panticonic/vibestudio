import * as fs from "node:fs";
import * as path from "node:path";
import { ownedEntry, retireOnAbort } from "./lib/owned-entry.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
await ownedEntry(
  async ({ ownership, signal, scratchRoot: temporaryParent }) => {
    const checkout = path.join(temporaryParent, "checkout");
    const omitted = new Set([".git", "dist", "node_modules", "workspace"]);

    function linkInstalledDependencies(checkoutRoot) {
      const localPackages = new Map();
      const unitRoots = [];
      for (const category of ["packages", "hosts", "services"]) {
        for (const entry of fs.readdirSync(path.join(repositoryRoot, category), {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          const relativeRoot = path.join(category, entry.name);
          const manifestPath = path.join(repositoryRoot, relativeRoot, "package.json");
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (typeof manifest.name !== "string") continue;
          localPackages.set(manifest.name, path.join(checkoutRoot, relativeRoot));
          unitRoots.push(relativeRoot);
        }
      }

      function projectDirectory(installedRoot, targetRoot, scope = "") {
        fs.mkdirSync(targetRoot, { recursive: true });
        for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
          // Workspace userland remains absent from this host isolation fixture.
          if (entry.name === "@workspace") continue;
          const source = path.join(installedRoot, entry.name);
          const target = path.join(targetRoot, entry.name);
          if (entry.name.startsWith("@") && entry.isDirectory()) {
            projectDirectory(source, target, `${entry.name}/`);
            continue;
          }
          const local = localPackages.get(`${scope}${entry.name}`);
          fs.symlinkSync(local ?? source, target, local || entry.isDirectory() ? "dir" : "file");
        }
      }

      projectDirectory(
        path.join(repositoryRoot, "node_modules"),
        path.join(checkoutRoot, "node_modules")
      );
      // Package-local dependency versions are part of the installed boundary.
      // Hoisting only the root map silently substituted root TypeScript 7 for
      // Svelte's declared TypeScript 6 parser (and can split any other dependency).
      for (const relativeRoot of unitRoots) {
        const installedRoot = path.join(repositoryRoot, relativeRoot, "node_modules");
        if (fs.existsSync(installedRoot))
          projectDirectory(installedRoot, path.join(checkoutRoot, relativeRoot, "node_modules"));
      }
    }

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
      signal.throwIfAborted();
      const owned = ownership.spawn(check.command, check.args, {
        cwd: checkout,
        env: process.env,
        stdio: "inherit",
        kill: "graceful",
        label: check.label,
      });
      retireOnAbort(ownership, signal, owned);
      try {
        const code = await new Promise((resolve, reject) => {
          owned.child.once("error", reject);
          owned.child.once("exit", resolve);
        });
        if (code !== 0) {
          signal.throwIfAborted();
          throw new Error(`Host-only ${check.label} exited with status ${code}`);
        }
      } finally {
        await owned.join();
      }
    }
    console.log(
      "Host production build, typecheck, and root-bootstrap/boundary tests passed with workspace/ absent."
    );
  },
  { appRoot: repositoryRoot, scratchPrefix: "vibestudio-host-only-" }
);
