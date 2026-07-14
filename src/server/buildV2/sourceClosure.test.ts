/**
 * Tests for sourceClosure.ts — pure source-closure computation over injected GAD
 * subtree hashes (no git, no DO, no filesystem beyond persistence).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  computeSourceClosures,
  recomputeFromNodes,
  diffSourceMaps,
  computeCompilationCacheKey,
  sealBuildEnvironment,
  getSealedBuildEnvironment,
  type ContentHashMap,
} from "./sourceClosure.js";

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

describe("executionDigest", () => {
  describe("computeSourceClosures", () => {
    it("derives source digests bottom-up from injected content hashes", () => {
      const graph = graphOf(
        node("@workspace/lib-a", "packages/lib-a"),
        node("@workspace-panels/chat", "panels/chat", ["@workspace/lib-a"], "panel")
      );
      const hashes: ContentHashMap = {
        "@workspace/lib-a": "m1",
        "@workspace-panels/chat": "m2",
      };
      const { sourceMap } = computeSourceClosures(graph, hashes);
      expect(sourceMap["@workspace/lib-a"]).toMatch(/^[0-9a-f]{64}$/);
      expect(sourceMap["@workspace-panels/chat"]).toMatch(/^[0-9a-f]{64}$/);
      expect(sourceMap["@workspace/lib-a"]).not.toBe(sourceMap["@workspace-panels/chat"]);
    });

    it("skips nodes with no content hash (not in the workspace state)", () => {
      const graph = graphOf(node("@workspace/ghost", "packages/ghost"));
      const { sourceMap } = computeSourceClosures(graph, {});
      expect(sourceMap["@workspace/ghost"]).toBeUndefined();
    });

    it("is deterministic for the same inputs", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"])
      );
      const hashes: ContentHashMap = { "@workspace/a": "x", "@workspace/b": "y" };
      const first = computeSourceClosures(graph, hashes);
      const second = computeSourceClosures(graph, hashes);
      expect(first.sourceMap).toEqual(second.sourceMap);
    });

    it("changes a dependent's source digest when only the dep's hash changes", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"])
      );
      const before = computeSourceClosures(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
      });
      const after = computeSourceClosures(graph, {
        "@workspace/a": "x2",
        "@workspace/b": "y",
      });
      expect(after.sourceMap["@workspace/a"]).not.toBe(before.sourceMap["@workspace/a"]);
      expect(after.sourceMap["@workspace/b"]).not.toBe(before.sourceMap["@workspace/b"]);
    });
  });

  describe("recomputeFromNodes", () => {
    it("propagates a changed hash through reverse deps without touching others", () => {
      const graph = graphOf(
        node("@workspace/a", "packages/a"),
        node("@workspace/b", "packages/b", ["@workspace/a"]),
        node("@workspace/c", "packages/c")
      );
      const initial = computeSourceClosures(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });

      const result = recomputeFromNodes(
        graph,
        ["@workspace/a"],
        initial.sourceMap,
        initial.contentHashes,
        { "@workspace/a": "x2" }
      );
      expect(result.sourceMap["@workspace/a"]).not.toBe(initial.sourceMap["@workspace/a"]);
      expect(result.sourceMap["@workspace/b"]).not.toBe(initial.sourceMap["@workspace/b"]);
      expect(result.sourceMap["@workspace/c"]).toBe(initial.sourceMap["@workspace/c"]);
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
      const initial = computeSourceClosures(graph, {
        "@workspace/a": "x1",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });
      const incremental = recomputeFromNodes(
        graph,
        ["@workspace/a"],
        initial.sourceMap,
        initial.contentHashes,
        { "@workspace/a": "x2" }
      );
      const fromScratch = computeSourceClosures(graph, {
        "@workspace/a": "x2",
        "@workspace/b": "y",
        "@workspace/c": "z",
      });
      expect(incremental.sourceMap).toEqual(fromScratch.sourceMap);
    });
  });

  describe("diffSourceMaps", () => {
    it("detects changed, added, and removed entries", () => {
      const changes = diffSourceMaps({ a: "1", b: "2", gone: "3" }, { a: "1", b: "9", fresh: "4" });
      expect(changes.changed).toEqual(["b"]);
      expect(changes.added).toEqual(["fresh"]);
      expect(changes.removed).toEqual(["gone"]);
    });

    it("returns empty arrays when maps are identical", () => {
      const changes = diffSourceMaps({ a: "1" }, { a: "1" });
      expect(changes).toEqual({ changed: [], added: [], removed: [] });
    });
  });

  describe("sealed compilation environment", () => {
    let root: string;

    function writeRootFiles(dir: string, pkg: string, lock: string, ws: string): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), pkg);
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), lock);
      fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), ws);
    }

    function writeWorkspaceFiles(dir: string, pkg = '{"name":"workspace"}'): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), pkg);
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "workspace-lock\n");
      fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "workspace-packages\n");
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "tsconfig.integration.json"), "{}\n");
    }

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-"));
      sealBuildEnvironment(null);
    });

    afterEach(() => {
      sealBuildEnvironment(null);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("varies cache identity by unit, source digest and sourcemap", () => {
      const dir = path.join(root, "app");
      writeRootFiles(dir, '{"name":"host"}', "lock\n", "ws\n");
      sealBuildEnvironment({ appRoot: dir });
      const base = computeCompilationCacheKey("unit-a", "ev1", true);
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      expect(computeCompilationCacheKey("unit-a", "ev1", true)).toBe(base);
      expect(computeCompilationCacheKey("unit-b", "ev1", true)).not.toBe(base);
      expect(computeCompilationCacheKey("unit-a", "ev2", true)).not.toBe(base);
      expect(computeCompilationCacheKey("unit-a", "ev1", false)).not.toBe(base);
    });

    it("captures host and workspace dependency files with full hashes", () => {
      const appRoot = path.join(root, "app");
      const workspaceRoot = path.join(appRoot, "workspace");
      writeRootFiles(appRoot, '{"name":"host"}', "lock\n", "ws\n");
      writeWorkspaceFiles(workspaceRoot);

      const manifest = sealBuildEnvironment({ appRoot, workspaceRoot });
      expect(manifest?.inputs.map((input) => input.file)).toContain("workspace/package.json");
      expect(manifest?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        manifest?.inputs
          .filter((input) => input.present)
          .every((input) => /^[0-9a-f]{64}$/.test(input.contentHash ?? ""))
      ).toBe(true);
    });

    it("distinguishes missing files from present-empty files", () => {
      const absentDir = path.join(root, "absent");
      const emptyDir = path.join(root, "empty");
      fs.mkdirSync(absentDir, { recursive: true });
      fs.writeFileSync(path.join(absentDir, "package.json"), '{"name":"x"}');
      writeRootFiles(emptyDir, '{"name":"x"}', "", "");

      const absent = sealBuildEnvironment({ appRoot: absentDir });
      expect(absent?.inputs.map((input) => input.present)).toEqual([true, false, false]);
      const absentDigest = absent?.digest;
      const empty = sealBuildEnvironment({ appRoot: emptyDir });
      expect(empty?.inputs.map((input) => input.present)).toEqual([true, true, true]);
      expect(empty?.digest).not.toBe(absentDigest);
    });

    it("does not reread live files after sealing", () => {
      const dir = path.join(root, "app");
      writeRootFiles(dir, '{"name":"host"}', "lock\n", "ws\n");
      sealBuildEnvironment({ appRoot: dir });
      const before = computeCompilationCacheKey("unit", "sourceDigest", true);
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"mutated"}');
      expect(computeCompilationCacheKey("unit", "sourceDigest", true)).toBe(before);
      expect(getSealedBuildEnvironment().root).toBe(dir);

      sealBuildEnvironment({ appRoot: dir });
      expect(computeCompilationCacheKey("unit", "sourceDigest", true)).not.toBe(before);
    });
  });
});
