import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { initBuildSystemV2, type BuildSystemV2 } from "./index.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import { discoverPackageGraph } from "./packageGraph.js";

/** Serves the working tree as the (only) workspace state. */
function fakeWorkspaceSource(
  getWorkspaceRoot: () => string
): WorkspaceStateSource & BuildSourceProvider {
  return {
    async ensureFresh() {
      return { stateHash: "state:test" };
    },
    async unitHashes(_stateHash, relPaths) {
      return Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}`]));
    },
    async resolveHead() {
      return "state:test";
    },
    async resolveContextView() {
      return "state:test";
    },
    async discoverGraph() {
      return discoverPackageGraph(getWorkspaceRoot());
    },
    onStateAdvanced() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild() {
      return { sourceRoot: getWorkspaceRoot() };
    },
  };
}

function fakeMultiStateWorkspaceSource(
  stateRoots: Record<string, string>,
  mainStateHash: string,
  heads: Record<string, string> = {}
): WorkspaceStateSource & BuildSourceProvider {
  const rootForState = (stateHash: string): string => {
    const root = stateRoots[stateHash];
    if (!root) throw new Error(`No fake source root for ${stateHash}`);
    return root;
  };
  return {
    async ensureFresh() {
      return { stateHash: mainStateHash };
    },
    async unitHashes(stateHash, relPaths) {
      const root = rootForState(stateHash);
      return Object.fromEntries(
        relPaths.map((relPath) => {
          const dir = path.join(root, ...relPath.split("/"));
          return [relPath, fs.existsSync(dir) ? `h:${stateHash}:${relPath}` : null];
        })
      );
    },
    async resolveHead(head) {
      return heads[head] ?? null;
    },
    async resolveContextView(contextId) {
      return heads[`ctx:${contextId}`] ?? "state:test";
    },
    async discoverGraph(stateHash) {
      return discoverPackageGraph(rootForState(stateHash));
    },
    onStateAdvanced() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild(_units, stateRef) {
      return { sourceRoot: rootForState(stateRef) };
    },
  };
}

describe("BuildSystemV2 library package subpaths", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2 | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-lib-subpath-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    buildSystem = null;
  });

  afterEach(async () => {
    await buildSystem?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds the requested package export subpath instead of the package root", async () => {
    const pkgDir = path.join(workspaceRoot, "packages", "split-library");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/split-library",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./src/root.ts",
          "./report": "./src/report.ts",
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "root.ts"),
      [
        'import { Buffer } from "node:buffer";',
        'export const root = await Promise.resolve(Buffer.from("root").toString("utf8"));',
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "report.ts"),
      'export const marker = "safe-report-entry";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      []
    );

    await expect(
      buildSystem.getBuild("@workspace/split-library", undefined, {
        library: true,
        libraryTarget: "panel",
      })
    ).rejects.toThrow(/Top-level await|node:buffer/);

    const result = await buildSystem.getBuild("@workspace/split-library/report", undefined, {
      library: true,
      libraryTarget: "panel",
    });
    expect(result.bundle).toContain("safe-report-entry");
    expect(result.bundle).not.toContain("Buffer.from");
  });

  it("builds a requested package wildcard export subpath", async () => {
    const pkgDir = path.join(workspaceRoot, "skills", "test-suite");
    fs.mkdirSync(path.join(pkgDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace-skills/test-suite",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./index.ts",
          "./tests/*": "./tests/*.ts",
        },
      })
    );
    fs.writeFileSync(path.join(pkgDir, "index.ts"), 'export const root = "root-entry";\n');
    fs.writeFileSync(
      path.join(pkgDir, "tests", "workers.ts"),
      'export const marker = "wildcard-workers-entry";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      []
    );

    const result = await buildSystem.getBuild(
      "@workspace-skills/test-suite/tests/workers",
      undefined,
      { library: true, libraryTarget: "worker" }
    );
    expect(result.bundle).toContain("wildcard-workers-entry");
    expect(result.bundle).not.toContain("root-entry");
  });

  it("selects package export conditions independently for panel, worker, and eval", async () => {
    // A package with target-forked entries — exactly the shape that broke eval
    // imports: a panel entry that must NOT be picked for a DO host.
    const pkgDir = path.join(workspaceRoot, "packages", "dual-entry");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/dual-entry",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": {
            "vibestudio-panel": "./src/panel.ts",
            "vibestudio-eval": "./src/eval.ts",
            worker: "./src/worker.ts",
            default: "./src/default.ts",
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "panel.ts"),
      'export const marker = "PANEL-ENTRY";\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "worker.ts"),
      'export const marker = "WORKER-ENTRY";\n'
    );
    fs.writeFileSync(path.join(pkgDir, "src", "eval.ts"), 'export const marker = "EVAL-ENTRY";\n');
    fs.writeFileSync(
      path.join(pkgDir, "src", "default.ts"),
      'export const marker = "DEFAULT-ENTRY";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      []
    );

    // Panel target resolves the `vibestudio-panel` condition.
    const panelBuild = await buildSystem.getBuild("@workspace/dual-entry", undefined, {
      library: true,
      libraryTarget: "panel",
    });
    expect(panelBuild.bundle).toContain("PANEL-ENTRY");
    expect(panelBuild.bundle).not.toContain("WORKER-ENTRY");

    // An ordinary worker still resolves its worker entry.
    const workerBuild = await buildSystem.getBuild("@workspace/dual-entry", undefined, {
      library: true,
      libraryTarget: "worker",
    });
    expect(workerBuild.bundle).toContain("WORKER-ENTRY");
    expect(workerBuild.bundle).not.toContain("PANEL-ENTRY");

    // Eval has its own static contract and cache identity; it does not borrow
    // the narrower worker entry merely because EvalDO itself runs in workerd.
    const evalBuild = await buildSystem.getBuild("@workspace/dual-entry", undefined, {
      library: true,
      libraryTarget: "eval",
    });
    expect(evalBuild.bundle).toContain("EVAL-ENTRY");
    expect(evalBuild.bundle).not.toContain("WORKER-ENTRY");
    expect(evalBuild.bundle).not.toContain("PANEL-ENTRY");
  });

  it("keeps the EvalDO-injected runtime external from eval library bundles", async () => {
    const runtimeDir = path.join(workspaceRoot, "packages", "runtime");
    const consumerDir = path.join(workspaceRoot, "packages", "consumer");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": {
            "vibestudio-eval": "./eval.ts",
            worker: "./worker.ts",
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(runtimeDir, "eval.ts"),
      [
        'throw new Error("HOST-INJECTION-MISSING");',
        'export const workspace = { marker: "STATIC-EVAL-FACADE" };',
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(runtimeDir, "worker.ts"),
      'export const workspace = { marker: "WORKER-FACADE" };\n'
    );
    fs.writeFileSync(
      path.join(consumerDir, "package.json"),
      JSON.stringify({
        name: "@workspace/consumer",
        version: "0.1.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "@workspace/runtime": "workspace:*" },
      })
    );
    fs.writeFileSync(
      path.join(consumerDir, "index.ts"),
      [
        'import { workspace } from "@workspace/runtime";',
        "export const readMarker = () => workspace.marker;",
        "",
      ].join("\n")
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      []
    );

    const result = await buildSystem.getBuild("@workspace/consumer", undefined, {
      library: true,
      libraryTarget: "eval",
      externals: ["@workspace/runtime"],
    });

    expect(result.bundle).toContain('require("@workspace/runtime")');
    expect(result.bundle).not.toContain("HOST-INJECTION-MISSING");
    expect(result.bundle).not.toContain("STATIC-EVAL-FACADE");
    expect(result.bundle).not.toContain("WORKER-FACADE");
  });

  it("resolves a build unit that exists only at a context ref", async () => {
    const mainRoot = path.join(root, "main-state");
    const contextRoot = path.join(root, "context-state");
    const pkgDir = path.join(contextRoot, "packages", "context-only");
    fs.mkdirSync(path.join(mainRoot, "packages"), { recursive: true });
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/context-only",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./index.ts",
        },
      })
    );
    fs.writeFileSync(path.join(pkgDir, "index.ts"), 'export const marker = "ctx-only-unit";\n');

    buildSystem = await initBuildSystemV2(
      mainRoot,
      fakeMultiStateWorkspaceSource(
        {
          "state:main": mainRoot,
          "state:ctx": contextRoot,
        },
        "state:main",
        { "ctx:agent-1": "state:ctx" }
      ),
      []
    );

    await expect(
      buildSystem.getBuild("@workspace/context-only", undefined, {
        library: true,
        libraryTarget: "panel",
      })
    ).rejects.toThrow(/Unknown build unit/);

    const result = await buildSystem.getBuild("@workspace/context-only", "ctx:agent-1", {
      library: true,
      libraryTarget: "panel",
    });
    expect(result.bundle).toContain("ctx-only-unit");
  });

  it("resolves context-only units without building them", async () => {
    const mainRoot = path.join(root, "main-resolve-state");
    const contextRoot = path.join(root, "context-resolve-state");
    const panelDir = path.join(contextRoot, "panels", "context-panel");
    fs.mkdirSync(path.join(mainRoot, "panels"), { recursive: true });
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/context-panel",
        version: "0.1.0",
        type: "module",
        vibestudio: { entry: "index.tsx" },
        dependencies: {},
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.tsx"),
      "export default function App() { return null; }\n"
    );

    buildSystem = await initBuildSystemV2(
      mainRoot,
      fakeMultiStateWorkspaceSource(
        {
          "state:main-resolve": mainRoot,
          "state:ctx-resolve": contextRoot,
        },
        "state:main-resolve",
        { "ctx:agent-resolve": "state:ctx-resolve" }
      ),
      []
    );

    await expect(buildSystem.resolveBuildUnit("panels/context-panel")).resolves.toBeNull();
    await expect(
      buildSystem.resolveBuildUnit("panels/context-panel", "ctx:agent-resolve")
    ).resolves.toMatchObject({
      unitPath: "panels/context-panel",
      unitName: "@workspace-panels/context-panel",
      kind: "panel",
      stateHash: "state:ctx-resolve",
    });
  });
});
