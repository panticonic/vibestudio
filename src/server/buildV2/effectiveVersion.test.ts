/**
 * Tests for effectiveVersion.ts — pure EV computation over injected GAD
 * subtree hashes (no git, no DO, no filesystem beyond persistence).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  recomputeFromNodes,
  diffEvMaps,
  computeBuildKey,
  type ContentHashMap,
} from "./effectiveVersion.js";

function node(
  name: string,
  relativePath: string,
  internalDeps: string[] = [],
  kind: GraphNode["kind"] = "package"
): GraphNode {
  return {
    path: `/ws/${relativePath}`,
    relativePath,
    name,
    kind,
    dependencies: {},
    dependencyOverrides: {},
    internalDeps,
    manifest: {},
  };
}

function graphOf(...nodes: GraphNode[]): PackageGraph {
  const graph = new PackageGraph();
  for (const n of nodes) graph.addNode(n);
  graph.computeTopologicalOrder();
  return graph;
}

describe("effectiveVersion", () => {
  describe("computeEffectiveVersions", () => {
    it("derives EVs bottom-up from injected content hashes", () => {
      const graph = graphOf(
        node("@workspace/core", "packages/core"),
        node("@workspace-panels/chat", "panels/chat", ["@workspace/core"], "panel")
      );
      const hashes: ContentHashMap = {
        "@workspace/core": "m1",
        "@workspace-panels/chat": "m2",
      };
      const { evMap } = computeEffectiveVersions(graph, hashes);
      expect(evMap["@workspace/core"]).toMatch(/^[0-9a-f]{16}$/);
      expect(evMap["@workspace-panels/chat"]).toMatch(/^[0-9a-f]{16}$/);
      expect(evMap["@workspace/core"]).not.toBe(evMap["@workspace-panels/chat"]);
    });

    it("skips nodes with no content hash (not in the workspace state)", () => {
      const graph = graphOf(node("@workspace/ghost", "packages/ghost"));
      const { evMap } = computeEffectiveVersions(graph, {});
      expect(evMap["@workspace/ghost"]).toBeUndefined();
    });

    it("is deterministic for the same inputs", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"])
      );
      const hashes: ContentHashMap = { "@workspace/a": "x", "@workspace/b": "y" };
      const first = computeEffectiveVersions(graph, hashes);
      const second = computeEffectiveVersions(graph, hashes);
      expect(first.evMap).toEqual(second.evMap);
    });

    it("changes a dependent's EV when only the dep's hash changes", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"])
      );
      const before = computeEffectiveVersions(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
      });
      const after = computeEffectiveVersions(graph, {
        "@workspace/a": "x2",
        "@workspace/b": "y",
      });
      expect(after.evMap["@workspace/a"]).not.toBe(before.evMap["@workspace/a"]);
      expect(after.evMap["@workspace/b"]).not.toBe(before.evMap["@workspace/b"]);
    });
  });

  describe("recomputeFromNodes", () => {
    it("propagates a changed hash through reverse deps without touching others", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"]),
        node("@workspace/c", "packages/c")
      );
      const initial = computeEffectiveVersions(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });

      const result = recomputeFromNodes(
        graph,
        ["@workspace/a"],
        initial.evMap,
        initial.contentHashes,
        { "@workspace/a": "x2" }
      );
      expect(result.evMap["@workspace/a"]).not.toBe(initial.evMap["@workspace/a"]);
      expect(result.evMap["@workspace/b"]).not.toBe(initial.evMap["@workspace/b"]);
      expect(result.evMap["@workspace/c"]).toBe(initial.evMap["@workspace/c"]);
      expect(result.contentHashes["@workspace/a"]).toBe("x2");
      // inputs not mutated
      expect(initial.contentHashes["@workspace/a"]).toBe("x1");
    });

    it("matches a from-scratch computation after the change", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"]),
        node("@workspace/c", "panels/c", ["@workspace/b"], "panel")
      );
      const initial = computeEffectiveVersions(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });
      const incremental = recomputeFromNodes(
        graph,
        ["@workspace/a"],
        initial.evMap,
        initial.contentHashes,
        { "@workspace/a": "x2" }
      );
      const fromScratch = computeEffectiveVersions(graph, {
        "@workspace/a": "x2",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });
      expect(incremental.evMap).toEqual(fromScratch.evMap);
    });
  });

  describe("diffEvMaps", () => {
    it("detects changed, added, and removed entries", () => {
      const changes = diffEvMaps({ a: "1", b: "2", gone: "3" }, { a: "1", b: "9", fresh: "4" });
      expect(changes.changed).toEqual(["b"]);
      expect(changes.added).toEqual(["fresh"]);
      expect(changes.removed).toEqual(["gone"]);
    });

    it("returns empty arrays when maps are identical", () => {
      const changes = diffEvMaps({ a: "1" }, { a: "1" });
      expect(changes).toEqual({ changed: [], added: [], removed: [] });
    });
  });

  describe("computeBuildKey", () => {
    it("varies by unit name, ev, and sourcemap flag", () => {
      const base = computeBuildKey("unit-a", "ev1", true);
      expect(computeBuildKey("unit-a", "ev1", true)).toBe(base);
      expect(computeBuildKey("unit-b", "ev1", true)).not.toBe(base);
      expect(computeBuildKey("unit-a", "ev2", true)).not.toBe(base);
      expect(computeBuildKey("unit-a", "ev1", false)).not.toBe(base);
    });

    it("does not invalidate workspace builds when host dist bundles change", () => {
      const previousAppRoot = process.env["NATSTACK_APP_ROOT"];
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-root-fingerprint-"));
      const rootA = path.join(root, "a");
      const rootB = path.join(root, "b");
      try {
        for (const dir of [rootA, rootB]) {
          fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
          fs.writeFileSync(path.join(dir, "package.json"), '{"name":"host","version":"1.0.0"}');
          fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
          fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
        }
        fs.writeFileSync(path.join(rootA, "dist", "server.mjs"), "console.log('old server');\n");
        fs.writeFileSync(path.join(rootA, "dist", "main.cjs"), "console.log('old main');\n");
        fs.writeFileSync(path.join(rootB, "dist", "server.mjs"), "console.log('new server');\n");
        fs.writeFileSync(path.join(rootB, "dist", "main.cjs"), "console.log('new main');\n");

        process.env["NATSTACK_APP_ROOT"] = rootA;
        const first = computeBuildKey("unit-a", "ev1", true);
        process.env["NATSTACK_APP_ROOT"] = rootB;
        expect(computeBuildKey("unit-a", "ev1", true)).toBe(first);
      } finally {
        if (previousAppRoot === undefined) delete process.env["NATSTACK_APP_ROOT"];
        else process.env["NATSTACK_APP_ROOT"] = previousAppRoot;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
