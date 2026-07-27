import { describe, expect, it } from "vitest";
import { domainHash } from "./identity.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "./retention.js";

function productSeedRef(): ExecutionArtifactRefV1 {
  const contentRoots = [
    {
      repoPath: null,
      stateHash: `state:${"0".repeat(64)}`,
    },
  ] as const;
  const effectiveVersion = domainHash("vibestudio/test-effective/v1", "seed");
  const recipeDigest = domainHash("vibestudio/test-recipe/v1", "seed");
  const artifactDigest = domainHash("vibestudio/test-artifact/v1", "seed");
  const sourceClosureDigest = executionSourceClosureDigest(contentRoots);
  const workspaceId = "workspace:test";
  return {
    version: 1,
    sourceState: {
      kind: "product-seed",
      workspaceId,
      effectiveVersion,
      state: null,
      contentRoots,
      sourceClosureDigest,
    },
    recipeDigest,
    buildKey: recipeDigest,
    artifactDigest,
    executionDigest: executionArtifactDigest({
      version: 1,
      sourceState: {
        kind: "product-seed",
        workspaceId,
        effectiveVersion,
        state: null,
        contentRoots,
        sourceClosureDigest,
      },
      recipeDigest,
      buildKey: recipeDigest,
      artifactDigest,
    }),
  };
}

describe("execution artifact retention identity", () => {
  it("permits a null semantic state only for structurally identified product seeds", () => {
    expect(verifyExecutionArtifactRef(productSeedRef()).sourceState).toMatchObject({
      kind: "product-seed",
      state: null,
    });

    const invalidWorkspaceRef = structuredClone(productSeedRef()) as unknown as {
      sourceState: { kind: "workspace"; state: null };
    };
    invalidWorkspaceRef.sourceState.kind = "workspace";
    expect(() =>
      verifyExecutionArtifactRef(invalidWorkspaceRef as unknown as ExecutionArtifactRefV1)
    ).toThrow("Workspace execution semantic source state is required");
  });

  it("rejects product seeds that claim a workspace repository root", () => {
    const ref = productSeedRef();
    const invalid = {
      ...ref,
      sourceState: {
        ...ref.sourceState,
        contentRoots: [{ ...ref.sourceState.contentRoots[0], repoPath: "packages/seed" }],
      },
    };
    expect(() => verifyExecutionArtifactRef(invalid as ExecutionArtifactRefV1)).toThrow(
      "Product-seed execution content roots cannot name a workspace repository"
    );
  });

  it("verifies a development producer with independent recipe and build identities", () => {
    const effectiveVersion = domainHash("vibestudio/test-effective/v1", "development");
    const recipeDigest = domainHash("vibestudio/test-recipe/v1", "development");
    const buildKey = domainHash("vibestudio/test-build/v1", "development");
    const artifactDigest = domainHash("vibestudio/test-artifact/v1", "development");
    const contentRoots = [
      { repoPath: "packages/host", stateHash: `state:${"1".repeat(64)}` },
      { repoPath: "workspace", stateHash: `state:${"2".repeat(64)}` },
    ] as const;
    const sourceState = {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion,
      state: { kind: "application" as const, applicationId: "application:development" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    };
    const unsigned = {
      version: 1 as const,
      sourceState,
      recipeDigest,
      buildKey,
      artifactDigest,
    };

    expect(
      verifyExecutionArtifactRef({
        ...unsigned,
        executionDigest: executionArtifactDigest(unsigned),
      })
    ).toMatchObject({
      recipeDigest,
      buildKey,
      sourceState: { contentRoots: expect.arrayContaining([...contentRoots]) },
    });
    expect(recipeDigest).not.toBe(buildKey);
  });
});
