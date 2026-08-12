/**
 * Tests for collectTransitiveExternalDeps from externalDeps.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const { testExtDepsRoot } = vi.hoisted(() => ({
  testExtDepsRoot: `/tmp/test-extdeps-${process.pid}`,
}));

vi.mock("@vibestudio/env-paths", () => ({
  getUserDataPath: vi.fn().mockReturnValue("/tmp/test-extdeps"),
  getCentralDataPath: vi.fn().mockReturnValue("/tmp/test-extdeps-instance"),
  getSharedDerivedDataPath: vi.fn().mockReturnValue(testExtDepsRoot),
}));

vi.mock("@vibestudio/shared/npmInstaller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vibestudio/shared/npmInstaller")>()),
  runNpmInstall: vi.fn(async (cwd: string) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const packages: Record<string, Record<string, unknown>> = {};
    const installPackage = (location: string, name: string, version: string) => {
      const packageDir = path.join(cwd, location);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name, version, exports: { ".": "./index.js" } })
      );
      fs.writeFileSync(path.join(packageDir, "index.js"), "export default true;\n");
      packages[location] = {
        version,
        resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-1.0.0.tgz`,
        integrity: "sha512-test",
      };
    };
    for (const [name, specifier] of Object.entries(manifest.dependencies)) {
      const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(specifier) ? specifier : "1.0.0";
      const location = path.join("node_modules", ...name.split("/"));
      installPackage(location, name, version);
      if (name === "parent-with-transitive") {
        installPackage(
          path.join(location, "node_modules", "transitive-target"),
          "transitive-target",
          "2.0.0"
        );
      }
    }
    const lock = { name: "external-deps-install", lockfileVersion: 3, packages };
    fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify(lock));
    fs.writeFileSync(path.join(cwd, "node_modules", ".package-lock.json"), JSON.stringify(lock));
  }),
}));

import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveDependencyPatches,
  collectTransitiveExternalDeps,
  dependencyPatchesForExternalRoots,
  ensureExternalDeps,
} from "./externalDeps.js";
import { NpmResolutionError, runNpmInstall } from "@vibestudio/shared/npmInstaller";

/** Helper: create a minimal GraphNode. */
function makeNode(
  name: string,
  dependencies: Record<string, string> = {},
  internalDeps: string[] = []
): GraphNode {
  return {
    path: `/ws/packages/${name}`,
    relativePath: `packages/${name}`,
    name,
    kind: "package",
    dependencies,
    dependencyOverrides: {},
    internalDeps,
    manifest: {},
  };
}

function patchDigest(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("collectTransitiveExternalDeps", () => {
  it("collects direct external deps from a leaf node", () => {
    const graph = new PackageGraph();
    const leaf = makeNode("@workspace/leaf", {
      react: "^18.2.0",
      lodash: "^4.17.21",
    });
    graph.addNode(leaf);

    const deps = collectTransitiveExternalDeps(leaf, graph);
    expect(deps).toEqual({
      react: "^18.2.0",
      lodash: "^4.17.21",
    });
  });

  it("walks internal deps transitively and collects their externals", () => {
    const graph = new PackageGraph();
    const inner = makeNode("@workspace/inner", { zod: "^3.0.0" });
    const middle = makeNode(
      "@workspace/middle",
      { "@workspace/inner": "workspace:*", axios: "^1.0.0" },
      ["@workspace/inner"]
    );
    const outer = makeNode(
      "@workspace/outer",
      { "@workspace/middle": "workspace:*", react: "^18.0.0" },
      ["@workspace/middle"]
    );
    graph.addNode(inner);
    graph.addNode(middle);
    graph.addNode(outer);

    const deps = collectTransitiveExternalDeps(outer, graph);
    expect(deps).toHaveProperty("react", "^18.0.0");
    expect(deps).toHaveProperty("axios", "^1.0.0");
    expect(deps).toHaveProperty("zod", "^3.0.0");
    // Internal workspace deps should NOT appear
    expect(deps).not.toHaveProperty("@workspace/inner");
    expect(deps).not.toHaveProperty("@workspace/middle");
  });

  it("collects external runtime deps from @vibestudio internal packages", () => {
    const graph = new PackageGraph();
    const shared = makeNode("@vibestudio/shared", {
      "@silvia-odwyer/photon-node": "^0.3.4",
    });
    const extension = makeNode(
      "@workspace-extensions/image-service",
      { "@vibestudio/shared": "workspace:*" },
      ["@vibestudio/shared"]
    );
    graph.addNode(shared);
    graph.addNode(extension);

    const deps = collectTransitiveExternalDeps(extension, graph);
    expect(deps).toEqual({
      "@silvia-odwyer/photon-node": "^0.3.4",
    });
  });

  it("walks repo-root workspace package manifests that are outside the workspace graph", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extdeps-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      const sharedDir = path.join(root, "packages", "shared");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "package.json"),
        JSON.stringify({
          name: "@vibestudio/shared",
          dependencies: {
            "@silvia-odwyer/photon-node": "^0.3.4",
          },
        })
      );

      const graph = new PackageGraph();
      const extension = makeNode("@workspace-extensions/image-service", {
        "@vibestudio/shared": "workspace:*",
      });
      graph.addNode(extension);

      const deps = collectTransitiveExternalDeps(extension, graph, workspaceRoot);
      expect(deps).toEqual({
        "@silvia-odwyer/photon-node": "^0.3.4",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks scoped workspace package manifests resolved from app node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extdeps-"));
    try {
      const workspaceRoot = path.join(root, "fresh-dev-workspace", "source");
      const appNodeModules = path.join(root, "app", "node_modules");
      const sharedDir = path.join(appNodeModules, "@vibestudio", "shared");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "package.json"),
        JSON.stringify({
          name: "@vibestudio/shared",
          dependencies: {
            "@silvia-odwyer/photon-node": "^0.3.4",
          },
        })
      );

      const graph = new PackageGraph();
      const extension = makeNode("@workspace-extensions/image-service", {
        "@vibestudio/shared": "workspace:*",
      });
      graph.addNode(extension);

      const deps = collectTransitiveExternalDeps(extension, graph, workspaceRoot, [appNodeModules]);
      expect(deps).toEqual({
        "@silvia-odwyer/photon-node": "^0.3.4",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects patched dependencies instead of borrowing an ambient host install", () => {
    const graph = new PackageGraph();
    const packageUsingPatchedDep = makeNode("@workspace/patched-dep-fixture", {
      "@earendil-works/pi-agent-core": "0.78.0",
      zod: "^3.25.0",
    });
    graph.addNode(packageUsingPatchedDep);

    expect(collectTransitiveExternalDeps(packageUsingPatchedDep, graph)).toEqual({
      "@earendil-works/pi-agent-core": "0.78.0",
      zod: "^3.25.0",
    });
  });

  it("skips workspace:* deps (they are internal)", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", {
      react: "^18.0.0",
      "@workspace/b": "workspace:*",
    });
    // @workspace/b is in dependencies but not in the graph — should be skipped
    // because version starts with "workspace:"
    graph.addNode(a);

    const deps = collectTransitiveExternalDeps(a, graph);
    expect(deps).toEqual({ react: "^18.0.0" });
  });

  it("takes higher version on conflict", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", { lodash: "^4.17.0" });
    const b = makeNode("@workspace/b", { lodash: "^4.18.0" });
    const root = makeNode(
      "@workspace/root",
      {
        "@workspace/a": "workspace:*",
        "@workspace/b": "workspace:*",
        lodash: "^4.16.0",
      },
      ["@workspace/a", "@workspace/b"]
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    // ^4.18.0 is the highest
    expect(deps["lodash"]).toBe("^4.18.0");
  });

  it("treats wildcards * as lowest priority in version comparison", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", { lodash: "*" });
    const b = makeNode("@workspace/b", { lodash: "^4.17.21" });
    const root = makeNode(
      "@workspace/root",
      {
        "@workspace/a": "workspace:*",
        "@workspace/b": "workspace:*",
      },
      ["@workspace/a", "@workspace/b"]
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    expect(deps["lodash"]).toBe("^4.17.21");
  });

  it("does not visit the same internal node twice (cycle-safe)", () => {
    const graph = new PackageGraph();
    // Create a diamond: root -> a, root -> b, a -> shared, b -> shared
    const shared = makeNode("@workspace/shared", { zod: "^3.0.0" });
    const a = makeNode("@workspace/a", { "@workspace/shared": "workspace:*", react: "^18.0.0" }, [
      "@workspace/shared",
    ]);
    const b = makeNode("@workspace/b", { "@workspace/shared": "workspace:*", axios: "^1.0.0" }, [
      "@workspace/shared",
    ]);
    const root = makeNode(
      "@workspace/root",
      { "@workspace/a": "workspace:*", "@workspace/b": "workspace:*" },
      ["@workspace/a", "@workspace/b"]
    );
    graph.addNode(shared);
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    // Should work without infinite recursion and collect all externals
    const deps = collectTransitiveExternalDeps(root, graph);
    expect(deps).toHaveProperty("zod", "^3.0.0");
    expect(deps).toHaveProperty("react", "^18.0.0");
    expect(deps).toHaveProperty("axios", "^1.0.0");
  });

  it("collects dependency overrides from transitive userland packages", () => {
    const graph = new PackageGraph();
    const shared = makeNode("@workspace/shared", { "left-pad": "^1.3.0" });
    shared.dependencyOverrides = { "left-pad": "1.3.0" };
    const panel = makeNode("@workspace/panel", { "@workspace/shared": "workspace:*" }, [
      "@workspace/shared",
    ]);
    panel.dependencyOverrides = { react: "19.0.0" };

    graph.addNode(shared);
    graph.addNode(panel);

    const overrides = collectTransitiveDependencyOverrides(panel, graph);

    expect(overrides).toEqual({
      react: "19.0.0",
      "left-pad": "1.3.0",
    });

    panel.dependencyOverrides["left-pad"] = "1.4.0";
    expect(() => collectTransitiveDependencyOverrides(panel, graph)).toThrow(/conflicts between/u);
  });

  it("collects owner-local patches from the exact materialized dependency closure", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-patch-closure-"));
    try {
      const owner = makeNode("@workspace/patch-owner", { "parent-with-transitive": "1.0.0" });
      owner.relativePath = "packages/patch-owner";
      const consumer = makeNode(
        "@workspace/consumer",
        { "@workspace/patch-owner": "workspace:*" },
        ["@workspace/patch-owner"]
      );
      consumer.relativePath = "workers/consumer";
      const graph = new PackageGraph();
      graph.addNode(owner);
      graph.addNode(consumer);

      const ownerRoot = path.join(sourceRoot, owner.relativePath);
      owner.manifest = {
        dependencyResolution: {
          patches: {
            "transitive-target@2.0.0": {
              path: "patches/transitive-target.patch",
              roots: ["parent-with-transitive"],
            },
          },
        },
      };
      fs.mkdirSync(path.join(ownerRoot, "patches"), { recursive: true });
      fs.writeFileSync(path.join(ownerRoot, "package.json"), "{}\n");
      fs.writeFileSync(
        path.join(ownerRoot, "patches", "transitive-target.patch"),
        "fixture patch\n"
      );
      fs.mkdirSync(path.join(sourceRoot, consumer.relativePath), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, consumer.relativePath, "package.json"), "{}\n");

      expect(collectTransitiveDependencyPatches(consumer, graph, sourceRoot)).toMatchObject([
        {
          selector: "transitive-target@2.0.0",
          packageName: "transitive-target",
          version: "2.0.0",
          owner: "@workspace/patch-owner",
          roots: ["parent-with-transitive"],
          content: "fixture patch\n",
        },
      ]);

      consumer.dependencies["transitive-target"] = "2.0.0";
      expect(() => collectTransitiveDependencyPatches(consumer, graph, sourceRoot)).toThrow(
        /depend on its patch owner/u
      );
      delete consumer.dependencies["transitive-target"];
      consumer.dependencyOverrides["transitive-target"] = "2.0.0";
      expect(() => collectTransitiveDependencyPatches(consumer, graph, sourceRoot)).toThrow(
        /policy belongs to/u
      );
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("selects transitive patches by the direct dependency roots present in a derived subset", () => {
    const patch = {
      selector: "transitive-target@2.0.0",
      packageName: "transitive-target",
      version: "2.0.0",
      owner: "@workspace/patch-owner",
      roots: ["parent-with-transitive"],
      content: "fixture patch\n",
      digest: patchDigest("fixture patch\n"),
    };

    expect(
      dependencyPatchesForExternalRoots([patch], { "parent-with-transitive": "1.0.0" })
    ).toEqual([patch]);
    expect(dependencyPatchesForExternalRoots([patch], { unrelated: "1.0.0" })).toEqual([]);
  });
});

describe("ensureExternalDeps", () => {
  it("applies an exact patch to every matching transitive package occurrence", async () => {
    vi.mocked(runNpmInstall).mockClear();
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });
    const patchContent = [
      "diff --git a/index.js b/index.js",
      "--- a/index.js",
      "+++ b/index.js",
      "@@ -1 +1 @@",
      "-export default true;",
      '+export default "patched";',
      "",
    ].join("\n");

    const nodeModulesDir = await ensureExternalDeps(
      { "parent-with-transitive": "1.0.0", "transitive-target": "2.0.0" },
      {},
      {
        patches: [
          {
            selector: "transitive-target@2.0.0",
            packageName: "transitive-target",
            version: "2.0.0",
            owner: "@workspace/patch-owner",
            roots: ["parent-with-transitive"],
            content: patchContent,
            digest: patchDigest(patchContent),
          },
        ],
      }
    );
    const patchedFile = path.join(
      nodeModulesDir,
      "parent-with-transitive",
      "node_modules",
      "transitive-target",
      "index.js"
    );
    expect(fs.readFileSync(patchedFile, "utf8")).toBe('export default "patched";\n');
    expect(
      fs.readFileSync(path.join(nodeModulesDir, "transitive-target", "index.js"), "utf8")
    ).toBe('export default "patched";\n');

    fs.writeFileSync(patchedFile, "tampered\n");
    await ensureExternalDeps(
      { "parent-with-transitive": "1.0.0", "transitive-target": "2.0.0" },
      {},
      {
        patches: [
          {
            selector: "transitive-target@2.0.0",
            packageName: "transitive-target",
            version: "2.0.0",
            owner: "@workspace/patch-owner",
            roots: ["parent-with-transitive"],
            content: patchContent,
            digest: patchDigest(patchContent),
          },
        ],
      }
    );
    expect(fs.readFileSync(patchedFile, "utf8")).toBe('export default "patched";\n');
    expect(runNpmInstall).toHaveBeenCalledTimes(2);
  });

  it("fails when an exact transitive patch selector matches no installed package", async () => {
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });
    await expect(
      ensureExternalDeps(
        { leftpad: "1.0.0" },
        {},
        {
          patches: [
            {
              selector: "missing-transitive@2.0.0",
              packageName: "missing-transitive",
              version: "2.0.0",
              owner: "@workspace/patch-owner",
              roots: ["leftpad"],
              content: "",
              digest: patchDigest(""),
            },
          ],
        }
      )
    ).rejects.toThrow(/matched no installed package/u);
  });
  it("stores validated dependency artifacts in the shared derived cache", async () => {
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });

    const nodeModulesDir = await ensureExternalDeps({ leftpad: "1.0.0" });

    expect(nodeModulesDir.startsWith(path.join(testExtDepsRoot, "external-deps"))).toBe(true);
    expect(nodeModulesDir.startsWith("/tmp/test-extdeps-instance")).toBe(false);
  });

  it("exposes npm registry misses as caller-correctable package resolution errors", async () => {
    vi.mocked(runNpmInstall).mockRejectedValueOnce(
      new NpmResolutionError("package-not-found", new Error("npm E404"))
    );
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });

    await expect(ensureExternalDeps({ "missing-package": "1.0.0" })).rejects.toMatchObject({
      code: "package_not_found",
      errorData: {
        code: "package_not_found",
        reason: "package-not-found",
        packages: [{ specifier: "missing-package", version: "1.0.0" }],
      },
    });
  });

  it("writes npm overrides into generated external-deps package.json", async () => {
    vi.mocked(runNpmInstall).mockClear();
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });

    const nodeModulesDir = await ensureExternalDeps(
      { "@earendil-works/pi-ai": "0.74.1", react: "^19.0.0" },
      { "@anthropic-ai/sdk": "0.97.1", react: "19.0.0" }
    );

    expect(runNpmInstall).toHaveBeenCalledTimes(1);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(nodeModulesDir), "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };
    expect(pkg.dependencies["react"]).toBe("19.0.0");
    expect(pkg.overrides).toMatchObject({
      "@anthropic-ai/sdk": "0.97.1",
    });
    expect(pkg.overrides).not.toHaveProperty("react");
  });

  it("folds a matching major-scoped override into a direct dependency for npm", async () => {
    vi.mocked(runNpmInstall).mockClear();
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });

    const nodeModulesDir = await ensureExternalDeps(
      { ws: "^8.18.3" },
      { "ws@6": "6.2.4", "ws@7": "7.5.11", "ws@8": "8.21.1" }
    );

    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(nodeModulesDir), "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ ws: "8.21.1" });
    expect(pkg.overrides).toMatchObject({ "ws@6": "6.2.4", "ws@7": "7.5.11" });
    expect(pkg.overrides).not.toHaveProperty("ws@8");
  });

  it("reinstalls a cache entry when the ready sentinel exists but node_modules is missing", async () => {
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });
    const first = await ensureExternalDeps({ leftpad: "1.0.0" });
    expect(fs.existsSync(first)).toBe(true);

    const cacheDir = path.dirname(first);
    fs.rmSync(first, { recursive: true, force: true });
    expect(fs.existsSync(path.join(cacheDir, ".ready"))).toBe(true);

    const repaired = await ensureExternalDeps({ leftpad: "1.0.0" });
    expect(repaired).toBe(first);
    expect(fs.existsSync(repaired)).toBe(true);
  });

  it("rejects and reinstalls a ready cache with incomplete npm integrity metadata", async () => {
    vi.mocked(runNpmInstall).mockClear();
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });
    const first = await ensureExternalDeps({ leftpad: "1.0.0" });
    const cacheDir = path.dirname(first);
    const hiddenLockPath = path.join(first, ".package-lock.json");
    const hiddenLock = JSON.parse(fs.readFileSync(hiddenLockPath, "utf8")) as {
      packages: Record<string, { integrity?: string }>;
    };
    delete hiddenLock.packages["node_modules/leftpad"]?.integrity;
    fs.writeFileSync(hiddenLockPath, JSON.stringify(hiddenLock));
    fs.writeFileSync(path.join(cacheDir, ".ready"), new Date().toISOString());
    expect(fs.existsSync(path.join(cacheDir, ".ready"))).toBe(true);

    const repaired = await ensureExternalDeps({ leftpad: "1.0.0" });
    expect(repaired).toBe(first);
    const repairedLock = JSON.parse(fs.readFileSync(hiddenLockPath, "utf8")) as {
      packages: Record<string, { integrity?: string }>;
    };
    expect(repairedLock.packages["node_modules/leftpad"]?.integrity).toBe("sha512-test");
    expect(runNpmInstall).toHaveBeenCalledTimes(2);
  });
});
