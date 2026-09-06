import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertPassthroughScriptsStaged,
  SERVER_RUNTIME_ARTIFACTS,
  stageNpmUpdateLauncherFiles,
  stageNativeIsolationArtifacts,
  stageNodeRuntimeArtifacts,
} from "../scripts/build-npm-packages.mjs";
import {
  NATIVE_ISOLATION_TARGETS,
  nativeIsolationTarget,
} from "../scripts/native-isolation-artifacts.mjs";

describe("npm CLI packaging", () => {
  it("stages every standalone server boot artifact", () => {
    expect(SERVER_RUNTIME_ARTIFACTS).toEqual([
      "dist/server.mjs",
      "dist/fs-disk-worker.cjs",
      nativeIsolationTarget().artifact,
      `dist/mxc/${process.platform}-${process.arch}/manifest.json`,
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

  it("stages the passthrough script tree into both published packages", () => {
    const buildScript = fs.readFileSync(path.resolve("scripts/build-npm-packages.mjs"), "utf8");
    const copies = buildScript.match(
      /copyTree\(path\.join\(repoRoot, "scripts\/cli"\), path\.join\(root, "scripts\/cli"\), defaultSkip\)/g
    );
    expect(copies).toHaveLength(2);
    expect(fs.existsSync(path.resolve("scripts/cli/remote-serve.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/server-entry.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/smoke-remote-server.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/mobile-native-android.mjs"))).toBe(true);
    expect(buildScript).not.toContain("stageMobileNativeScaffold");
  });

  it("stages the complete shared npm update launcher contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-update-staging-"));
    stageNpmUpdateLauncherFiles(root);
    for (const relative of [
      "scripts/npm-update-contract.mjs",
      "scripts/npm-update-launcher.mjs",
      "scripts/historical-host-snapshot.mjs",
      "scripts/owned-process-tree.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, relative))).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
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
      "scripts/cli/lib/iroh-relays.mjs",
      "scripts/cli/lib/mobile-native-android.mjs",
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

  it("stages the pinned stock Node runtime into the standalone server package", () => {
    const appRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-node-stage-"));
    const sourceRoot = path.join(appRoot, "source-runtime");
    const packageRoot = path.join(appRoot, "package");
    mkdirSync(path.join(sourceRoot, "dist", "node", "linux-x64", "bin"), { recursive: true });
    writeFileSync(path.join(sourceRoot, "dist", "node", "linux-x64", "bin", "node"), "node");
    if (process.platform !== "win32")
      fs.symlinkSync("node", path.join(sourceRoot, "dist", "node", "linux-x64", "bin", "npm"));
    writeFileSync(path.join(sourceRoot, "dist", "node", "linux-x64", "runtime.json"), "{}");
    try {
      stageNodeRuntimeArtifacts(packageRoot, {
        root: path.join(sourceRoot, "dist", "node", "linux-x64"),
      });
      expect(
        fs.existsSync(path.join(packageRoot, "dist", "node", "linux-x64", "bin", "node"))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(packageRoot, "dist", "node", "linux-x64", "runtime.json"))
      ).toBe(true);
      if (process.platform !== "win32") {
        const npmLink = path.join(packageRoot, "dist", "node", "linux-x64", "bin", "npm");
        expect(fs.lstatSync(npmLink).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(npmLink)).toBe("node");
      }
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
