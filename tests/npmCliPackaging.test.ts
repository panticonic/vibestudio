import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertPassthroughScriptsStaged,
  SERVER_RUNTIME_ARTIFACTS,
  stageNativeIsolationArtifacts,
  stageNodeRuntimeInstaller,
  stagePackageDependencies,
  stagePinnedRootDependencies,
  stagePublishedPackage,
} from "../scripts/build-server-npm-package.mjs";
import { createRequire } from "node:module";
import { NATIVE_ISOLATION_TARGETS } from "../scripts/native-isolation-artifacts.mjs";

describe("npm CLI packaging", () => {
  it("stages the declared published files and assets without development source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-published-package-stage-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "staged");
      for (const dir of ["dist", "src", "assets"])
        mkdirSync(path.join(source, dir), { recursive: true });
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          name: "publication-fixture",
          version: "1.0.0",
          main: "dist/index.js",
          files: ["dist", "assets"],
        })
      );
      writeFileSync(path.join(source, "dist/index.js"), "module.exports = 42;");
      writeFileSync(path.join(source, "src/index.ts"), "export const answer = 42;");
      writeFileSync(path.join(source, "assets/icon.svg"), "<svg />");
      writeFileSync(path.join(source, "README.md"), "Published package");
      stagePublishedPackage(source, destination);
      expect(createRequire(path.join(destination, "package.json"))(destination)).toBe(42);
      expect(fs.readFileSync(path.join(destination, "assets/icon.svg"), "utf8")).toBe("<svg />");
      expect(fs.existsSync(path.join(destination, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(destination, "src"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves mobile peers with their consumer while retaining owned dependencies", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-mobile-dependency-stage-"));
    try {
      stagePackageDependencies(path.resolve("packages/mobile-iroh"), root);
      expect(fs.existsSync(path.join(root, "node_modules/react-native"))).toBe(false);
      expect(fs.existsSync(path.join(root, "node_modules/@react-native-async-storage"))).toBe(
        false
      );
      expect(fs.existsSync(path.join(root, "node_modules/react-native-keychain"))).toBe(true);
      expect(fs.existsSync(path.join(root, "node_modules/@react-native-community/netinfo"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(root, "node_modules/web-streams-polyfill"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains the repaired native binding instead of reinstalling upstream bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-native-dependency-stage-"));
    try {
      stagePinnedRootDependencies(root);
      const source = createRequire(path.resolve("package.json"));
      const installed = createRequire(path.join(root, "vendor/@number0/iroh/package.json"));
      const names: Record<string, string> = {
        "linux-x64": "@number0/iroh-linux-x64-gnu",
        "linux-arm64": "@number0/iroh-linux-arm64-gnu",
        "darwin-arm64": "@number0/iroh-darwin-arm64",
        "win32-x64": "@number0/iroh-win32-x64-msvc",
      };
      const name = names[`${process.platform}-${process.arch}`]!;
      expect(fs.existsSync(path.join(root, "vendor/@number0/iroh/node_modules", name))).toBe(false);
      // npm supplies the pinned optional binding at package root. The wrapper
      // must resolve those repaired bytes rather than a private upstream copy.
      const binding = path.join(root, "node_modules", name);
      mkdirSync(path.dirname(binding), { recursive: true });
      fs.symlinkSync(path.dirname(source.resolve(name)), binding, "junction");
      expect(
        fs.readFileSync(installed.resolve(name)).equals(fs.readFileSync(source.resolve(name)))
      ).toBe(true);
      expect(installed(name).Endpoint).toBeTypeOf("function");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains the Svelte checker's compiler version and transitive runtime dependencies", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-dependency-stage-"));
    try {
      stagePackageDependencies(path.resolve("packages/svelte-type-source"), root);
      // The generated npm manifest installs the shared Svelte dependency at
      // package root; only the checker's incompatible compiler stays nested.
      fs.symlinkSync(
        path.resolve("node_modules/svelte"),
        path.join(root, "node_modules/svelte"),
        "junction"
      );
      const require = createRequire(path.join(root, "package.json"));
      const typescript = require("typescript");
      expect(typescript.version).toBe("6.0.3");
      expect(require("svelte2tsx").svelte2tsx).toBeTypeOf("function");
      expect(fs.existsSync(path.join(root, "node_modules/svelte2tsx/node_modules/dedent-js"))).toBe(
        true
      );
      expect(
        fs.existsSync(path.join(root, "node_modules/svelte2tsx/node_modules/typescript"))
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages every standalone server boot artifact", () => {
    expect(SERVER_RUNTIME_ARTIFACTS).toEqual([
      "dist/server.mjs",
      "dist/fs-disk-worker.cjs",
      "dist/browserTransport.js",
      "dist/authority-analysis-worker.mjs",
      "dist/library-lowering-worker.mjs",
      "dist/typecheck-worker.mjs",
      "dist/workspace-rpc-catalog-worker.mjs",
      "dist/immutable-tree-worker.mjs",
      "dist/sqlite-integrity-worker.mjs",
      "dist/internal-do.bundle.mjs",
      "dist/sql-wasm.wasm",
      "dist/host-build-fingerprint.json",
    ]);
  });

  it("stages the passthrough script tree into the published server package", () => {
    const buildScript = fs.readFileSync(
      path.resolve("scripts/build-server-npm-package.mjs"),
      "utf8"
    );
    const copies = buildScript.match(
      /copyTree\(path\.join\(repoRoot, "scripts\/cli"\), path\.join\(root, "scripts\/cli"\), defaultSkip\)/g
    );
    expect(copies).toHaveLength(1);
    expect(fs.existsSync(path.resolve("scripts/cli/remote-serve.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/server-entry.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/smoke-remote-server.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/mobile-native-android.mjs"))).toBe(true);
    expect(buildScript).not.toContain("stageMobileNativeScaffold");
  });

  it("fails staging when a packaged passthrough dependency is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-package-guard-"));
    for (const relative of [
      "scripts/cli/remote-serve.mjs",
      "scripts/cli/remote-doctor.mjs",
      "scripts/cli/lib/server-entry.mjs",
      "scripts/cli/lib/pair-server.mjs",
      "scripts/cli/lib/smoke-remote-server.mjs",
      "scripts/cli/lib/connect-grammar.generated.mjs",
      "scripts/cli/lib/config-paths.mjs",
      "scripts/cli/lib/mobile-native-android.mjs",
      "scripts/host-build-generations.mjs",
      "scripts/server-runtime-artifacts.mjs",
      "scripts/owned-process-tree.mjs",
      "scripts/owned-process-identity.mjs",
    ]) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    expect(() => assertPassthroughScriptsStaged(root)).not.toThrow();
    fs.rmSync(path.join(root, "scripts/cli/lib/pair-server.mjs"));
    expect(() => assertPassthroughScriptsStaged(root)).toThrow(/pair-server\.mjs/);
  });

  it("copies absolute native artifact descriptors into the staged package", () => {
    const appRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-native-stage-"));
    const source = path.join(appRoot, "source-helper");
    const manifest = path.join(appRoot, "source-manifest.json");
    writeFileSync(source, "helper");
    writeFileSync(manifest, "{}");
    try {
      stageNativeIsolationArtifacts(appRoot, [
        { source, artifact: "dist/mxc/linux-x64/lxc-exec" },
        { source: manifest, artifact: "dist/mxc/linux-x64/manifest.json" },
      ]);
      expect(fs.readFileSync(path.join(appRoot, "dist/mxc/linux-x64/lxc-exec"), "utf8")).toBe(
        "helper"
      );
      expect(fs.readFileSync(path.join(appRoot, "dist/mxc/linux-x64/manifest.json"), "utf8")).toBe(
        "{}"
      );
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("stages the pinned Node installer without bundling platform runtimes", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-node-stage-"));
    try {
      stageNodeRuntimeInstaller(packageRoot);
      const distribution = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "native/node/distribution.json"), "utf8")
      );
      expect(fs.readFileSync(path.join(packageRoot, ".nvmrc"), "utf8").trim()).toBe(
        distribution.version
      );
      expect(fs.existsSync(path.join(packageRoot, "scripts/node-runtime-artifacts.mjs"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(packageRoot, "dist/node"))).toBe(false);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
