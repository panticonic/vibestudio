import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertPassthroughScriptsStaged,
  SERVER_RUNTIME_ARTIFACTS,
  stageNpmUpdateLauncherFiles,
} from "../scripts/build-npm-packages.mjs";

describe("npm CLI packaging", () => {
  it("stages every standalone server boot artifact", () => {
    expect(SERVER_RUNTIME_ARTIFACTS).toEqual([
      "dist/server.mjs",
      "dist/browserTransport.js",
      "dist/authority-analysis-worker.mjs",
      "dist/library-lowering-worker.mjs",
      "dist/typecheck-worker.mjs",
      "dist/workspace-rpc-catalog-worker.mjs",
      "dist/sqlite-integrity-worker.mjs",
      "dist/internal-do.bundle.mjs",
      "dist/sql-wasm.wasm",
      "dist/host-build-fingerprint.json",
    ]);
    for (const relative of SERVER_RUNTIME_ARTIFACTS) {
      expect(fs.existsSync(path.resolve(relative))).toBe(true);
    }
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
  });

  it("stages the complete shared npm update launcher contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-update-staging-"));
    stageNpmUpdateLauncherFiles(root);
    for (const relative of [
      "scripts/npm-update-contract.mjs",
      "scripts/npm-update-launcher.mjs",
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
    ]) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    expect(() => assertPassthroughScriptsStaged(root)).not.toThrow();
    fs.rmSync(path.join(root, "scripts/cli/lib/pair-server.mjs"));
    expect(() => assertPassthroughScriptsStaged(root)).toThrow(/pair-server\.mjs/);
  });
});
