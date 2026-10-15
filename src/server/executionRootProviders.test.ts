import { describe, expect, it, vi } from "vitest";
import { internalDOExecutionArtifacts } from "./internalDOs/internalDoLoader.js";
import { internalDoProgramsForFixture } from "../../tests/fixtures/internalDoPrograms.js";
import {
  executionArtifactDigest,
  verifyExecutionArtifactRef,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { buildKeyRootProvider } from "./executionRootProviders.js";

function sharedBuildArtifacts() {
  const first = internalDOExecutionArtifacts(internalDoProgramsForFixture())[0]!;
  const unsigned = { ...first, recipeDigest: sha256("a second recipe over the exact same bytes") };
  const second = verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
  return [first, second];
}

describe("buildKeyRootProvider", () => {
  it("rejects another execution even when it shares the requested build bytes", async () => {
    const [first, second] = sharedBuildArtifacts();
    if (!first || !second) throw new Error("expected two product-seed execution artifacts");
    const buildKey = first.buildKey;
    const provider = buildKeyRootProvider({
      id: "runtime-entity",
      owner: "runtime-entity",
      buildKeys: () => [
        {
          ownerId: "retained-object",
          buildKey,
          executionDigest: first.executionDigest,
          reason: "active",
        },
      ],
      resolve: () => second,
    });

    await expect(provider.snapshotRoots(1)).rejects.toThrow(
      "resolved a different execution artifact"
    );
  });

  it("rejects a resolver returning a different build", async () => {
    const [artifact] = sharedBuildArtifacts();
    if (!artifact) throw new Error("expected product-seed execution artifact");
    const provider = buildKeyRootProvider({
      id: "runtime-entity",
      owner: "runtime-entity",
      buildKeys: () => [
        {
          ownerId: "retained-object",
          buildKey: "a".repeat(64),
          reason: "active",
        },
      ],
      resolve: () => artifact,
    });

    await expect(provider.snapshotRoots(1)).rejects.toThrow(
      "resolved a different execution artifact"
    );
  });

  it("keeps an execution digest while resolving artifacts with a shared build key", async () => {
    const artifacts = sharedBuildArtifacts();
    const first = artifacts[0];
    const second = artifacts[1];
    if (!first || !second) throw new Error("expected two product-seed execution artifacts");
    const buildKey = first.buildKey;
    const resolve = vi.fn(({ executionDigest }: { executionDigest?: string }) =>
      executionDigest === first.executionDigest ? first : second
    );
    const provider = buildKeyRootProvider({
      id: "product-runtime-entity",
      owner: "runtime-entity",
      buildKeys: () => [
        {
          ownerId: "sealed-object",
          buildKey,
          executionDigest: first.executionDigest,
          reason: "active" as const,
        },
      ],
      resolve,
    });

    await expect(provider.snapshotRoots(1)).resolves.toEqual([
      expect.objectContaining({ artifact: first }),
    ]);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ buildKey, executionDigest: first.executionDigest })
    );
  });
});
