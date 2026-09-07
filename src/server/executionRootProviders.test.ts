import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { internalDOExecutionArtifacts } from "./internalDOs/internalDoLoader.js";
import { buildKeyRootProvider } from "./executionRootProviders.js";

describe("buildKeyRootProvider", () => {
  it("rejects another execution even when it shares the requested build bytes", async () => {
    const bundle = "export class InternalDO {}";
    const buildKey = createHash("sha256").update(bundle).digest("hex");
    const [first, second] = internalDOExecutionArtifacts({ bundle, buildKey });
    if (!first || !second) throw new Error("expected two product-seed execution artifacts");
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
    const bundle = "export class InternalDO {}";
    const buildKey = createHash("sha256").update(bundle).digest("hex");
    const [artifact] = internalDOExecutionArtifacts({ bundle, buildKey });
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
    const bundle = "export class InternalDO {}";
    const buildKey = createHash("sha256").update(bundle).digest("hex");
    const artifacts = internalDOExecutionArtifacts({ bundle, buildKey });
    const first = artifacts[0];
    const second = artifacts[1];
    if (!first || !second) throw new Error("expected two product-seed execution artifacts");
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
