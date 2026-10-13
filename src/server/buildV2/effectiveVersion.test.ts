/**
 * Tests for effectiveVersion.ts — pure EV computation over injected GAD
 * subtree hashes (no git, no DO, no filesystem beyond persistence).
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  recomputeFromNodes,
  diffEvMaps,
  computeBuildKey,
  prepareBuildRootConfig,
  type RootDependencyFingerprintInfo,
  computeRootDependencyFingerprint,
  loadPersistedEvState,
  persistEvState,
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
    peerDependencies: {},
    optionalPeerDependencies: [],
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
  let rootFingerprint: RootDependencyFingerprintInfo;
  describe("persisted EV cache", () => {
    it("rejects legacy truncated EVs and round-trips the versioned full-digest cache", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ev-cache-"));
      try {
        fs.writeFileSync(
          path.join(dir, "ev-state.json"),
          JSON.stringify({
            stateHash: `state:${"a".repeat(64)}`,
            evMap: { unit: "b".repeat(16) },
            contentHashes: { unit: "manifest:test" },
          })
        );
        expect(await loadPersistedEvState(dir)).toBeNull();

        await persistEvState(dir, {
          stateHash: `state:${"a".repeat(64)}`,
          evMap: { unit: "b".repeat(64) },
          contentHashes: { unit: "manifest:test" },
        });
        expect(await loadPersistedEvState(dir)).toEqual({
          version: 2,
          stateHash: `state:${"a".repeat(64)}`,
          evMap: { unit: "b".repeat(64) },
          contentHashes: { unit: "manifest:test" },
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  it("keeps concurrent sessions' dependency identity and EV persistence independent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ev-sessions-"));
    try {
      const roots = [path.join(root, "a"), path.join(root, "b")];
      for (const [index, appRoot] of roots.entries()) {
        fs.mkdirSync(appRoot);
        fs.writeFileSync(
          path.join(appRoot, "package.json"),
          JSON.stringify({ name: `host-${index}` })
        );
      }
      const [first, second] = await Promise.all(
        roots.map((appRoot) => prepareBuildRootConfig({ appRoot }))
      );
      const firstKey = computeBuildKey(first!, "unit", "ev", false);
      const secondKey = computeBuildKey(second!, "unit", "ev", false);
      expect(firstKey).not.toBe(secondKey);
      await prepareBuildRootConfig({ appRoot: roots[1]! });
      expect(computeBuildKey(first!, "unit", "ev", false)).toBe(firstKey);
      const states = roots.map((_, index) => ({
        stateHash: `state:${String(index).repeat(64)}`,
        evMap: { unit: String(index).repeat(64) },
        contentHashes: { unit: `manifest:${index}` },
      }));
      await Promise.all(roots.map((stateRoot, index) => persistEvState(stateRoot, states[index]!)));
      expect(await Promise.all(roots.map(loadPersistedEvState))).toEqual(
        states.map((state) => ({ version: 2, ...state }))
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  describe("computeEffectiveVersions", () => {
    it("derives EVs bottom-up from injected content hashes", () => {
      const graph = graphOf(
        node("@workspace/lib-a", "packages/lib-a"),
        node("@workspace-panels/chat", "panels/chat", ["@workspace/lib-a"], "panel")
      );
      const hashes: ContentHashMap = {
        "@workspace/lib-a": "m1",
        "@workspace-panels/chat": "m2",
      };
      const { evMap } = computeEffectiveVersions(graph, hashes);
      expect(evMap["@workspace/lib-a"]).toMatch(/^[0-9a-f]{64}$/);
      expect(evMap["@workspace-panels/chat"]).toMatch(/^[0-9a-f]{64}$/);
      expect(evMap["@workspace/lib-a"]).not.toBe(evMap["@workspace-panels/chat"]);
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
    beforeEach(async () => {
      rootFingerprint = await prepareBuildRootConfig({ appRoot: process.cwd() });
    });

    it("invalidates every build key when generated wrapper protocol output changes", () => {
      for (const sourcemap of [true, false]) {
        const before = computeBuildKey(rootFingerprint, "unit-a", "ev1", sourcemap, "protocol-a");
        expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", sourcemap, "protocol-b")).not.toBe(
          before
        );
      }
    });
    it("varies by unit name, ev, and sourcemap flag", () => {
      const base = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).toBe(base);
      expect(computeBuildKey(rootFingerprint, "unit-b", "ev1", true)).not.toBe(base);
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev2", true)).not.toBe(base);
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", false)).not.toBe(base);
    });

    it("does not invalidate workspace builds when host dist bundles change", async () => {
      const previousAppRoot = process.env["VIBESTUDIO_APP_ROOT"];
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-root-fingerprint-"));
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

        rootFingerprint = await prepareBuildRootConfig({ appRoot: rootA });
        const first = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
        rootFingerprint = await prepareBuildRootConfig({ appRoot: rootB });
        expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).toBe(first);
      } finally {
        if (previousAppRoot === undefined) delete process.env["VIBESTUDIO_APP_ROOT"];
        else process.env["VIBESTUDIO_APP_ROOT"] = previousAppRoot;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("invalidates workspace builds when a linked local package implementation changes", async () => {
      const previousAppRoot = process.env["VIBESTUDIO_APP_ROOT"];
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-local-package-"));
      try {
        fs.writeFileSync(path.join(root, "package.json"), '{"name":"host"}');
        fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lock\n");
        fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
        const rpcDir = path.join(root, "packages", "rpc");
        fs.mkdirSync(path.join(rpcDir, "dist"), { recursive: true });
        fs.writeFileSync(path.join(rpcDir, "package.json"), '{"name":"@vibestudio/rpc"}');
        fs.writeFileSync(path.join(rpcDir, "dist", "client.js"), "export const protocol = 1;\n");
        delete process.env["VIBESTUDIO_APP_ROOT"];
        rootFingerprint = await prepareBuildRootConfig({ appRoot: root });
        const before = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);

        fs.writeFileSync(path.join(rpcDir, "dist", "client.js"), "export const protocol = 2;\n");
        // A source-server restart/reconfiguration begins a new root snapshot.
        rootFingerprint = await prepareBuildRootConfig({ appRoot: root });
        expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(before);
      } finally {
        if (previousAppRoot === undefined) delete process.env["VIBESTUDIO_APP_ROOT"];
        else process.env["VIBESTUDIO_APP_ROOT"] = previousAppRoot;

        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("root-dependency fingerprint (build-key hermeticity)", () => {
    it("fingerprints the same physical SDK from Electron's ASAR and native Node coordinates", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-installed-sdk-"));
      try {
        const physical = path.join(root, "app.asar.unpacked");
        fs.mkdirSync(path.join(physical, "node_modules/dependency"), { recursive: true });
        fs.mkdirSync(path.join(physical, "packages/sdk"), { recursive: true });
        fs.writeFileSync(path.join(physical, "package.json"), '{"name":"installed"}');
        fs.writeFileSync(path.join(physical, "packages/sdk/package.json"), '{"name":"sdk"}');
        fs.writeFileSync(path.join(physical, "packages/sdk/index.js"), "export const sdk = 1;");
        fs.writeFileSync(
          path.join(physical, "node_modules/dependency/package.json"),
          '{"name":"dependency","version":"1"}'
        );
        const virtual = path.join(root, "app.asar");
        fs.mkdirSync(path.join(virtual, "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(virtual, "package.json"), '{"name":"virtual alias"}');
        const node = await computeRootDependencyFingerprint(physical);
        const electron = await computeRootDependencyFingerprint(virtual);
        expect(electron.value).toBe(node.value);
        fs.writeFileSync(path.join(physical, "packages/sdk/index.js"), "export const sdk = 2;");
        expect((await computeRootDependencyFingerprint(virtual)).value).not.toBe(electron.value);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    const previousAppRoot = process.env["VIBESTUDIO_APP_ROOT"];
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

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-"));
      delete process.env["VIBESTUDIO_APP_ROOT"];
    });

    afterEach(async () => {
      if (previousAppRoot === undefined) delete process.env["VIBESTUDIO_APP_ROOT"];
      else process.env["VIBESTUDIO_APP_ROOT"] = previousAppRoot;

      fs.rmSync(root, { recursive: true, force: true });
    });

    it("folds host-root file CONTENTS into the build key (content-based identity)", async () => {
      const dir = path.join(root, "app");
      writeRootFiles(
        dir,
        '{"name":"host","version":"1.0.0"}',
        "lockfileVersion: '9.0'\n",
        "packages: []\n"
      );
      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      const before = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);

      // Change package.json CONTENTS (add a dependency) — build key must change.
      fs.writeFileSync(
        path.join(dir, "package.json"),
        '{"name":"host","version":"1.0.0","dependencies":{"left-pad":"1.0.0"}}'
      );
      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(before);
    });

    it("invalidates builds when the installed dependency realm changes", async () => {
      const dir = path.join(root, "installed");
      writeRootFiles(dir, '{"name":"host"}', "lock\n", "ws\n");
      const dependencyManifest = path.join(dir, "node_modules", "zod", "package.json");
      fs.mkdirSync(path.dirname(dependencyManifest), { recursive: true });
      fs.writeFileSync(dependencyManifest, '{"name":"zod","version":"3.25.76"}');

      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      const before = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
      expect(rootFingerprint.files.map((file) => file.file)).toContain("installed-node-modules:0");

      fs.writeFileSync(dependencyManifest, '{"name":"zod","version":"4.3.6"}');
      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(before);
    });

    it("distinguishes a shared development installation from prepared production dependencies", async () => {
      const dir = path.join(root, "installation-policy");
      writeRootFiles(dir, '{"name":"host"}', "lock\n", "ws\n");
      const previous = process.env["NODE_ENV"];
      try {
        process.env["NODE_ENV"] = "development";
        const development = await prepareBuildRootConfig({ appRoot: dir });
        process.env["NODE_ENV"] = "production";
        const production = await prepareBuildRootConfig({ appRoot: dir });
        expect(computeBuildKey(development, "unit-a", "ev1", true)).not.toBe(
          computeBuildKey(production, "unit-a", "ev1", true)
        );
      } finally {
        if (previous === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previous;
      }
    });

    it("uses the injected app root when VIBESTUDIO_APP_ROOT is unset", async () => {
      const dirA = path.join(root, "a");
      const dirB = path.join(root, "b");
      writeRootFiles(dirA, '{"name":"a"}', "lockfileVersion: '9.0'\n", "packages: []\n");
      writeRootFiles(dirB, '{"name":"b"}', "lockfileVersion: '9.0'\n", "packages: []\n");

      rootFingerprint = await prepareBuildRootConfig({ appRoot: dirA });
      const keyA = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
      expect(rootFingerprint.rootSource).toBe("injected");
      expect(rootFingerprint.root).toBe(dirA);

      rootFingerprint = await prepareBuildRootConfig({ appRoot: dirB });
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(keyA);
    });

    it("shares one captured dependency environment across bootstrap and steady construction", async () => {
      const appRoot = path.join(root, "shared-host");
      writeRootFiles(appRoot, '{"name":"host"}', "lock\n", "ws\n");
      const fingerprint = await computeRootDependencyFingerprint(appRoot);
      rootFingerprint = await prepareBuildRootConfig({ appRoot, fingerprint });
      const bootstrapKey = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
      rootFingerprint = await prepareBuildRootConfig({ appRoot, fingerprint });
      expect(rootFingerprint).toBe(fingerprint);
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).toBe(bootstrapKey);
      await expect(
        prepareBuildRootConfig({ appRoot, workspaceRoot: path.join(appRoot, "other"), fingerprint })
      ).rejects.toThrow("different dependency environment");
      // A subsequent host generation inspects its own dependency inputs.
      fs.writeFileSync(path.join(appRoot, "package.json"), '{"name":"host","changed":true}');
      rootFingerprint = await prepareBuildRootConfig({ appRoot });
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(bootstrapKey);
    });

    it("folds nested workspace dependency/config files into the build key", async () => {
      const appRoot = path.join(root, "app");
      const workspaceRoot = path.join(appRoot, "workspace");
      writeRootFiles(appRoot, '{"name":"host"}', "lock\n", "ws\n");
      writeWorkspaceFiles(workspaceRoot);

      rootFingerprint = await prepareBuildRootConfig({ appRoot, workspaceRoot });
      const before = computeBuildKey(rootFingerprint, "unit-a", "ev1", true);
      const beforeInfo = rootFingerprint;
      expect(beforeInfo.files.map((f) => f.file)).toContain("workspace/package.json");

      fs.writeFileSync(
        path.join(workspaceRoot, "package.json"),
        '{"name":"workspace","overrides":{"x":"1.0.0"}}'
      );
      rootFingerprint = await prepareBuildRootConfig({ appRoot, workspaceRoot });
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).not.toBe(before);
    });

    it("does not let ambient environment override the injected app root", async () => {
      const injected = path.join(root, "injected");
      const overridden = path.join(root, "override");
      writeRootFiles(injected, '{"name":"injected"}', "lock\n", "ws\n");
      writeRootFiles(overridden, '{"name":"override"}', "lock\n", "ws\n");

      rootFingerprint = await prepareBuildRootConfig({ appRoot: injected });
      process.env["VIBESTUDIO_APP_ROOT"] = overridden;
      const info = rootFingerprint;
      expect(info.rootSource).toBe("injected");
      expect(info.root).toBe(injected);
    });

    it("handles missing files deterministically and distinctly from present-empty", async () => {
      const absentDir = path.join(root, "absent");
      const emptyDir = path.join(root, "empty");
      // absentDir: only package.json exists (lock + workspace missing).
      fs.mkdirSync(absentDir, { recursive: true });
      fs.writeFileSync(path.join(absentDir, "package.json"), '{"name":"x"}');
      // emptyDir: all three exist but lock + workspace are empty.
      writeRootFiles(emptyDir, '{"name":"x"}', "", "");

      rootFingerprint = await prepareBuildRootConfig({ appRoot: absentDir });
      const absentInfo = rootFingerprint;
      const absentKey = computeBuildKey(rootFingerprint, "u", "ev", true);
      expect(absentInfo.files.map((f) => f.present)).toEqual([true, false, false]);
      expect(absentInfo.files[1]?.contentHash).toBeNull();

      rootFingerprint = await prepareBuildRootConfig({ appRoot: emptyDir });
      const emptyInfo = rootFingerprint;
      const emptyKey = computeBuildKey(rootFingerprint, "u", "ev", true);
      expect(emptyInfo.files.map((f) => f.present)).toEqual([true, true, true]);

      // Present-empty must not collide with absent.
      expect(emptyKey).not.toBe(absentKey);

      // Deterministic: recomputing over the same absent root is stable.
      rootFingerprint = await prepareBuildRootConfig({ appRoot: absentDir });
      expect(computeBuildKey(rootFingerprint, "u", "ev", true)).toBe(absentKey);
    });

    it("surfaces input paths + presence for observability", async () => {
      const dir = path.join(root, "obs");
      writeRootFiles(dir, '{"name":"o"}', "lock\n", "ws\n");
      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      const info = rootFingerprint;
      expect(info.files.map((f) => f.file)).toEqual([
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ]);
      expect(info.files.every((f) => f.path.startsWith(dir))).toBe(true);
      expect(info.files.every((f) => f.present && f.contentHash)).toBe(true);
      expect(info.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("preserves the installed tree digest across batched manifests, scopes, links and nesting", async () => {
      const dir = path.join(root, "batched");
      writeRootFiles(dir, '{"name":"host"}', "lock", "ws");
      const hash = (text: string) => createHash("sha256").update(text).digest("hex");
      const records: string[] = [];
      const manifest = (relative: string, name: string) => {
        const folder = path.join(dir, "node_modules", relative);
        fs.mkdirSync(folder, { recursive: true });
        const contents = JSON.stringify({ name });
        fs.writeFileSync(path.join(folder, "package.json"), contents);
        records.push(`package\0${relative.replaceAll(path.sep, "/")}\0${hash(contents)}\0`);
      };
      // Expected records describe the original sorted depth-first encoding,
      // including a child before its parent's following sibling.
      manifest("@scope/alpha", "scoped");
      manifest("a", "parent");
      manifest("a/node_modules/child", "nested");
      for (let i = 0; i < 35; i++) manifest(`p${String(i).padStart(2, "0")}`, `package-${i}`);
      fs.symlinkSync("a", path.join(dir, "node_modules", "z-link"), "dir");
      records.push(
        `package\0z-link\0${hash(JSON.stringify({ name: "parent" }))}\0link\0z-link\0a\0`
      );
      fs.mkdirSync(path.join(dir, "node_modules", "empty"));
      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });
      const installed = rootFingerprint.files.find(
        (file) => file.file === "installed-node-modules:0"
      );
      expect(installed?.contentHash).toBe(hash(records.join("")));
    });

    it("preserves the local tree digest across streaming files, links and nested siblings", async () => {
      const dir = path.join(root, "streamed");
      writeRootFiles(dir, '{"name":"host"}', "lock", "ws");
      const packageDir = path.join(dir, "packages", "sdk");
      fs.mkdirSync(path.join(packageDir, "a"), { recursive: true });
      fs.mkdirSync(path.join(packageDir, "node_modules"));
      fs.writeFileSync(path.join(packageDir, "node_modules", "ignored.ts"), "ignored");
      const records: string[] = [];
      const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
      for (const [relative, contents] of [
        ["a/large.bin", Buffer.alloc(192 * 1024, 0xab)],
        ["b.ts", Buffer.from("export const value = '🙂';\n")],
        ["package.json", Buffer.from('{"name":"sdk"}')],
      ] as const) {
        fs.writeFileSync(path.join(packageDir, relative), contents);
        records.push(`file\0${relative}\0${hash(contents)}\0`);
      }
      fs.symlinkSync("a/large.bin", path.join(packageDir, "z-link"));
      records.push("link\0z-link\0a/large.bin\0");
      const fingerprint = await prepareBuildRootConfig({ appRoot: dir });
      expect(fingerprint.files.find((file) => file.file === "packages/sdk/**")?.contentHash).toBe(
        hash(records.join(""))
      );
    });

    it("yields the event loop while fingerprinting local package trees", async () => {
      const dir = path.join(root, "responsive");
      writeRootFiles(dir, '{"name":"host"}', "lock\n", "ws\n");
      const packageDir = path.join(dir, "packages", "large");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), '{"name":"large"}');
      for (let index = 0; index < 300; index += 1) {
        fs.writeFileSync(
          path.join(packageDir, `module-${index}.ts`),
          `export const n = ${index};\n`
        );
      }
      let timerAdvanced = false;
      setTimeout(() => {
        timerAdvanced = true;
      }, 0);

      rootFingerprint = await prepareBuildRootConfig({ appRoot: dir });

      expect(timerAdvanced).toBe(true);
      expect(computeBuildKey(rootFingerprint, "unit-a", "ev1", true)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
