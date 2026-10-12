import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build as esbuildBuild } from "esbuild";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  createGraphImportResolver,
  createTsExtensionPlugin,
  createWorkspaceResolvePlugin,
} from "./builder.js";

function graphNode(name: string): GraphNode {
  return {
    name,
    path: `/workspace/${name}`,
    relativePath: `packages/${name}`,
    kind: "package",
    dependencies: {},
    peerDependencies: {},
    optionalPeerDependencies: [],
    dependencyOverrides: {},
    internalDeps: [],
    manifest: {},
  };
}

describe("workspace graph import resolver", () => {
  it("chooses the longest package boundary and preserves exact and subpath imports", () => {
    const graph = new PackageGraph();
    graph.addNode(graphNode("@workspace/a"));
    graph.addNode(graphNode("@workspace/a/b"));
    graph.addNode(graphNode("@workspace/a-long"));

    const resolve = createGraphImportResolver(graph);

    expect(resolve("@workspace/a")).toEqual({ packageName: "@workspace/a", subpath: "." });
    expect(resolve("@workspace/a/b/item")).toEqual({
      packageName: "@workspace/a/b",
      subpath: "./item",
    });
    expect(resolve("@workspace/a-long/feature")).toEqual({
      packageName: "@workspace/a-long",
      subpath: "./feature",
    });
    expect(resolve("@workspace/a-b/feature")).toBeNull();
    expect(resolve("/not-a-package")).toBeNull();
  });

  it("keeps build-output source fallback ahead of stale generated files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-resolver-"));
    try {
      const packageRoot = path.join(root, "packages/@workspace/pkg");
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@workspace/pkg", exports: { ".": "./dist/index.js" } })
      );
      fs.writeFileSync(path.join(packageRoot, "src/index.ts"), 'export default "source";\n');
      fs.writeFileSync(path.join(packageRoot, "dist/index.js"), 'export default "stale-dist";\n');

      const graph = new PackageGraph();
      graph.addNode(graphNode("@workspace/pkg"));
      const result = await esbuildBuild({
        stdin: {
          contents: 'import value from "@workspace/pkg"; console.log(value);',
          resolveDir: root,
          sourcefile: "entry.ts",
          loader: "ts",
        },
        bundle: true,
        write: false,
        platform: "node",
        plugins: [createWorkspaceResolvePlugin(graph, root)],
      });

      expect(result.outputFiles[0]?.text).toContain('"source"');
      expect(result.outputFiles[0]?.text).not.toContain("stale-dist");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps existing JavaScript imports and rewrites missing .js paths to TypeScript", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-extension-resolver-"));
    try {
      const entry = path.join(root, "entry.ts");
      const javascript = path.join(root, "dependency.js");
      const typescript = path.join(root, "dependency.ts");
      fs.writeFileSync(entry, 'import value from "./dependency.js"; console.log(value);\n');
      fs.writeFileSync(javascript, 'export default "javascript";\n');
      fs.writeFileSync(typescript, 'export default "typescript";\n');

      const plugins = [createTsExtensionPlugin(root)];
      const existing = await esbuildBuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: "node",
        plugins,
      });
      expect(existing.outputFiles[0]?.text).toContain('"javascript"');

      fs.rmSync(javascript);
      const fallback = await esbuildBuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: "node",
        plugins: [createTsExtensionPlugin(root)],
      });
      expect(fallback.outputFiles[0]?.text).toContain('"typescript"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
