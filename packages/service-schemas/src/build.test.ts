import { describe, expect, it } from "vitest";
import { buildMethods, executionArtifactRefSchema } from "./build.js";

const digest = "0".repeat(64);
const semanticState = { kind: "event" as const, eventId: "event:test" };

function sourceState(kind: "workspace" | "product-seed") {
  return {
    kind,
    workspaceId: "workspace:test",
    effectiveVersion: digest,
    state: kind === "workspace" ? semanticState : null,
    contentRoots: [
      {
        repoPath: kind === "workspace" ? "packages/test" : null,
        stateHash: `state:${digest}`,
      },
    ],
    sourceClosureDigest: digest,
  };
}

function artifact(source: ReturnType<typeof sourceState>) {
  return {
    version: 1,
    sourceState: source,
    recipeDigest: digest,
    buildKey: digest,
    artifactDigest: digest,
    executionDigest: digest,
  };
}

describe("execution artifact ref wire schema", () => {
  it("requires semantic state for workspace-derived artifacts", () => {
    expect(executionArtifactRefSchema.safeParse(artifact(sourceState("workspace"))).success).toBe(
      true
    );
    expect(
      executionArtifactRefSchema.safeParse(artifact({ ...sourceState("workspace"), state: null }))
        .success
    ).toBe(false);
  });

  it("reserves null semantic state for repository-free product seeds", () => {
    expect(
      executionArtifactRefSchema.safeParse(artifact(sourceState("product-seed"))).success
    ).toBe(true);
    expect(
      executionArtifactRefSchema.safeParse(
        artifact({
          ...sourceState("product-seed"),
          contentRoots: [{ repoPath: "packages/seed", stateHash: `state:${digest}` }],
        })
      ).success
    ).toBe(false);
  });
});

describe("build method effects", () => {
  it("treats workspace compilation as read-only and external acquisition as write", () => {
    expect(buildMethods.getBuild.access).toEqual({ sensitivity: "read" });
    expect(buildMethods.getBuildReport.access).toEqual({ sensitivity: "read" });
    expect(buildMethods.getBuildNpm.access).toEqual({ sensitivity: "write" });
  });
});
