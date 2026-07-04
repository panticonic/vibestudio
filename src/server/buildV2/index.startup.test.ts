import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverPackageGraph } from "./packageGraph.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import type { BuildSystemV2 } from "./index.js";

function fakeWorkspaceSource(workspaceRoot: string): WorkspaceStateSource & BuildSourceProvider {
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
      return discoverPackageGraph(workspaceRoot);
    },
    onStateAdvanced() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild() {
      return { sourceRoot: workspaceRoot };
    },
  };
}

describe("BuildSystemV2 startup", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2 | null;
  let releaseBuild: (() => void) | null;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-build-startup-"));
    workspaceRoot = path.join(root, "workspace");
    const { setUserDataPath } = await import("@vibez1/env-paths");
    setUserDataPath(path.join(root, "state"));
    buildSystem = null;
    releaseBuild = null;
  });

  afterEach(async () => {
    releaseBuild?.();
    await buildSystem?.shutdown();
    vi.doUnmock("./builder.js");
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not await missing non-app initial builds", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "slow-panel");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/slow-panel",
        version: "0.1.0",
        type: "module",
      })
    );

    const pendingBuild = new Promise<unknown>((resolve) => {
      releaseBuild = () => resolve({});
    });
    vi.doMock("./builder.js", async () => {
      const actual = await vi.importActual<typeof import("./builder.js")>("./builder.js");
      return {
        ...actual,
        buildUnit: vi.fn(() => pendingBuild),
      };
    });

    const { initBuildSystemV2 } = await import("./index.js");
    const { buildUnit } = await import("./builder.js");
    const init = initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), []);

    await expect(
      Promise.race([
        init.then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ])
    ).resolves.toBe("resolved");
    buildSystem = await init;
    expect(vi.mocked(buildUnit)).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.mocked(buildUnit)).toHaveBeenCalledTimes(1);
    releaseBuild?.();
    releaseBuild = null;
  });

  it("uses the explicit dependency workspace root for root-dependency fingerprints", async () => {
    const appRoot = path.join(root, "app");
    const dependencyWorkspaceRoot = path.join(appRoot, "workspace");
    fs.mkdirSync(dependencyWorkspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "package.json"), '{"name":"host"}');
    fs.writeFileSync(path.join(appRoot, "pnpm-lock.yaml"), "host-lock\n");
    fs.writeFileSync(path.join(appRoot, "pnpm-workspace.yaml"), "packages: []\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "package.json"), '{"name":"userland"}');
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "pnpm-lock.yaml"), "userland-lock\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "pnpm-workspace.yaml"), "packages: []\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "tsconfig.integration.json"), "{}\n");

    const { initBuildSystemV2 } = await import("./index.js");
    const { getRootDependencyFingerprintInfo } = await import("./effectiveVersion.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [], {
      appRoot,
      dependencyWorkspaceRoot,
    });

    const info = getRootDependencyFingerprintInfo();
    const workspacePackage = info.files.find((file) => file.file === "workspace/package.json");
    expect(info.root).toBe(appRoot);
    expect(info.rootSource).toBe("injected");
    expect(workspacePackage?.present).toBe(true);
    expect(workspacePackage?.path).toBe(path.join(dependencyWorkspaceRoot, "package.json"));
  });
});
