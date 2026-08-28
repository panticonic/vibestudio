import { describe, expect, it } from "vitest";

import { buildSourcemapForNode } from "./builder.js";
import type { GraphNode } from "./packageGraph.js";
import { sourcemapForKind } from "./stateTrigger.js";

function node(kind: GraphNode["kind"], sourcemap?: boolean): GraphNode {
  return { kind, manifest: { sourcemap } } as GraphNode;
}

describe("runtime source-map policy", () => {
  it("keeps normal runtime artifacts map-free unless the unit opts in", () => {
    for (const kind of ["panel", "app", "worker"] as const) {
      expect(buildSourcemapForNode(node(kind))).toBe(false);
      expect(buildSourcemapForNode(node(kind, false))).toBe(false);
      expect(buildSourcemapForNode(node(kind, true))).toBe(true);
      expect(sourcemapForKind(kind, undefined)).toBe(false);
      expect(sourcemapForKind(kind, false)).toBe(false);
      expect(sourcemapForKind(kind, true)).toBe(true);
    }
  });

  it("retains mapped extension stacks and map-free library artifacts", () => {
    expect(buildSourcemapForNode(node("extension"))).toBe(true);
    expect(sourcemapForKind("extension", undefined)).toBe(true);
    expect(buildSourcemapForNode(node("extension"), { library: true })).toBe(false);
  });
});
