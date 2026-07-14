import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceRevision,
  sha256,
  type ArtifactBundleEntry,
  type BuildRecipe,
  type ExecutionArtifactRef,
} from "@vibestudio/shared/execution/identity";
import { ExecutionArtifactStore } from "./executionArtifactStore.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-execution-artifacts-"));
  roots.push(root);
  const digest = sha256("toolchain");
  const recipe: BuildRecipe = {
    target: "worker",
    platform: "workerd",
    architecture: "wasm32",
    abi: null,
    options: { sourcemap: true },
    toolchain: { digest, components: { node: digest, esbuild: digest } },
    dependencyGraph: { digest },
    builderDigest: digest,
    declaredEnvironment: { LANG: "C.UTF-8" },
  };
  const source = createSourceRevision({ repoPath: "workers/example", stateHash: sha256("state") });
  const entries: ArtifactBundleEntry[] = [
    {
      path: "bundle.js",
      role: "primary",
      mode: 0o644,
      contentType: "text/javascript",
      bytes: Buffer.from("export default 1"),
    },
  ];
  return { root, recipe, source, entries };
}

describe("ExecutionArtifactStore", () => {
  it("persists both exact recovery indexes and verifies a cold read", () => {
    const f = fixture();
    const store = new ExecutionArtifactStore(f.root);
    const ref = store.put(f);
    const cold = new ExecutionArtifactStore(f.root);
    expect(cold.get(ref.executionDigest)?.ref).toEqual(ref);
    expect(cold.resolve(f.source, f.recipe)?.ref).toEqual(ref);
    expect(cold.getByBuildKey(ref.buildKey)?.ref).toEqual(ref);
    expect(fs.readFileSync(cold.artifactPath(ref.executionDigest, "bundle.js"), "utf8")).toBe(
      "export default 1"
    );
  });

  it("rebuilds the index from a committed immutable record after an interrupted commit", () => {
    const f = fixture();
    const ref = new ExecutionArtifactStore(f.root).put(f);
    fs.rmSync(path.join(f.root, "index.json"));

    const recovered = new ExecutionArtifactStore(f.root);
    expect(recovered.get(ref.executionDigest)?.ref).toEqual(ref);
    expect(recovered.resolve(f.source, f.recipe)?.ref.executionDigest).toBe(ref.executionDigest);
  });

  it("fails closed when stored bytes are tampered", () => {
    const f = fixture();
    const store = new ExecutionArtifactStore(f.root);
    const ref = store.put(f);
    fs.writeFileSync(store.artifactPath(ref.executionDigest, "bundle.js"), "tampered");
    expect(() => new ExecutionArtifactStore(f.root).get(ref.executionDigest)).toThrow(
      "failed verification"
    );
  });

  it("rejects a second output for the same source and recipe", () => {
    const f = fixture();
    const store = new ExecutionArtifactStore(f.root);
    store.put(f);
    expect(() =>
      store.put({
        ...f,
        entries: [{ ...f.entries[0]!, bytes: Buffer.from("different") }],
      })
    ).toThrow("Non-reproducible build");
  });

  it("retains roots and sweeps only after complete grace epochs", () => {
    const f = fixture();
    const store = new ExecutionArtifactStore(f.root);
    const first = store.put(f);
    const secondSource = createSourceRevision({
      repoPath: "workers/example",
      stateHash: sha256("state-2"),
    });
    const second = store.put({ ...f, source: secondSource });
    const root = {
      kind: "active-incarnation" as const,
      id: "entity-1",
      executionDigest: first.executionDigest,
    };
    expect(store.collect([root], { graceEpochs: 2 }).eligible).toEqual([]);
    expect(store.collect([root], { graceEpochs: 2 }).eligible).toEqual([
      { executionDigest: second.executionDigest, unmarkedEpochs: 2 },
    ]);
    expect(store.get(first.executionDigest)).not.toBeNull();
    expect(store.get(second.executionDigest)).toBeNull();
    expect(store.explainRetention([root]).retained[0]?.roots[0]?.id).toBe("entity-1");
  });

  it("does not mutate during dry-run", () => {
    const f = fixture();
    const store = new ExecutionArtifactStore(f.root);
    const ref: ExecutionArtifactRef = store.put(f);
    expect(store.collect([], { graceEpochs: 1, dryRun: true }).eligible).toHaveLength(1);
    expect(store.get(ref.executionDigest)).not.toBeNull();
  });
});
