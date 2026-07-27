import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { internalDOExecutionArtifacts } from "./internalDOs/internalDoLoader.js";
import { buildKeyRootProvider } from "./executionRootProviders.js";

describe("buildKeyRootProvider", () => {
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
