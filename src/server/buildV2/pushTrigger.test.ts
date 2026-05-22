import { PushTrigger } from "./pushTrigger.js";
import { PackageGraph, type GraphNode } from "./packageGraph.js";

function makeNode(name: string, relativePath = `packages/${name}`): GraphNode {
  return {
    path: `/workspace/${relativePath}`,
    relativePath,
    name,
    kind: "package",
    dependencies: {},
    dependencyOverrides: {},
    internalDeps: [],
    internalDepRefs: {},
    manifest: {},
  };
}

describe("PushTrigger", () => {
  it("skips rediscovery for repos configured as dev mirrors", () => {
    const graph = new PackageGraph();
    graph.addNode(makeNode("@workspace/core"));
    const trigger = new PushTrigger(graph, {}, {}, "/workspace", new Set(["projects/natstack"]));
    const rediscoverySpy = vi
      .spyOn(trigger as unknown as { fullRediscovery: () => Promise<void> }, "fullRediscovery")
      .mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    (trigger as unknown as { handlePush: (event: unknown) => void }).handlePush({
      repo: "projects/natstack",
      branch: "main",
      commit: "abc123",
    });

    expect(rediscoverySpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Push from unknown repo"));
    logSpy.mockRestore();
  });
});
