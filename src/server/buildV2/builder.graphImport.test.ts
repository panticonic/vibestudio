import { describe, expect, it } from "vitest";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import { createGraphImportResolver } from "./builder.js";

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
  });
});
