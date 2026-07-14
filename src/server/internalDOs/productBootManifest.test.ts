import { describe, expect, it } from "vitest";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/identity";
import {
  PRODUCT_SEED_DOS,
  WORKSPACE_DO_CLASS,
  WORKSPACE_DO_SOURCE,
  getBootstrapBundle,
  getProductBootManifest,
  getProductExecutionArtifact,
  productSeedExecutionDigest,
  productSeedHostCapabilities,
  requiresStaticDoHost,
  resolveProductSeedArtifact,
} from "./productBootManifest.js";

describe("sealed product boot manifest", () => {
  it("keeps only the entity/grant substrate below ordinary exact launch", () => {
    const manifest = getProductBootManifest();
    expect(manifest.bootstrap).toMatchObject({
      source: WORKSPACE_DO_SOURCE,
      className: WORKSPACE_DO_CLASS,
      capabilities: ["content.read", "entity.registry", "authority.grants", "context.bind"],
    });
    expect(manifest.productSeeds.map(({ id }) => id)).toEqual([
      "eval",
      "browser-data",
      "webhook-store",
    ]);
    expect(manifest.hostPrincipal).toBe(`host:${manifest.productBuildDigest}`);
  });

  it("publishes independently addressed immutable artifacts for every product seed", () => {
    const digests = new Set<string>();
    for (const seed of PRODUCT_SEED_DOS) {
      const binding = resolveProductSeedArtifact(seed.source);
      expect(binding?.selectorPolicy).toEqual({
        kind: "artifact",
        executionDigest: binding?.artifact.executionDigest,
      });
      verifyExecutionArtifactRef(binding!.artifact);
      expect(binding!.artifact.executionDigest).toBe(productSeedExecutionDigest(seed.source));
      expect(getProductExecutionArtifact(binding!.artifact.executionDigest)?.ref).toEqual(
        binding!.artifact
      );
      digests.add(binding!.artifact.executionDigest);
    }
    expect(digests.size).toBe(PRODUCT_SEED_DOS.length);
    expect(digests.has(getBootstrapBundle().binding.artifact.executionDigest)).toBe(false);
  });

  it("gives static host custody only to the substrate and capability-bearing exact seeds", () => {
    expect(requiresStaticDoHost(WORKSPACE_DO_SOURCE, WORKSPACE_DO_CLASS)).toBe(true);
    expect(requiresStaticDoHost("product/eval", "EvalDO")).toBe(true);
    expect(productSeedHostCapabilities("product/eval", "EvalDO")).toEqual(["unsafe-eval"]);
    expect(requiresStaticDoHost("product/eval", "WrongClass")).toBe(false);
    expect(requiresStaticDoHost("product/browser-data", "BrowserDataDO")).toBe(false);
    expect(requiresStaticDoHost("workers/agent-worker", "AiChatWorker")).toBe(false);
  });

  it("does not expose mutable cached artifact bytes", () => {
    const digest = productSeedExecutionDigest(PRODUCT_SEED_DOS[0].source);
    const first = getProductExecutionArtifact(digest)!;
    first.entries[0]!.bytes[0] = first.entries[0]!.bytes[0] === 0 ? 1 : 0;
    const second = getProductExecutionArtifact(digest)!;
    expect(second.entries[0]!.bytes[0]).not.toBe(first.entries[0]!.bytes[0]);
  });
});
