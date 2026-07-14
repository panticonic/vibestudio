import { describe, expect, it } from "vitest";
import {
  canonicalArtifactPath,
  codePrincipal,
  computeRecipeDigest,
  createExecutionArtifactRef,
  createSourceRevision,
  displayDigest,
  domainHash,
  parseSha256,
  sha256,
  type BuildRecipe,
} from "./identity.js";

const a = sha256("a");
const b = sha256("b");

function recipe(overrides: Partial<BuildRecipe> = {}): BuildRecipe {
  return {
    target: "worker",
    platform: "workerd",
    architecture: "wasm32",
    abi: null,
    options: { sourcemap: true, conditions: ["worker"] },
    toolchain: { digest: a, components: { esbuild: b } },
    dependencyGraph: { digest: b },
    builderDigest: a,
    declaredEnvironment: { LANG: "C.UTF-8" },
    ...overrides,
  };
}

describe("exact execution identity", () => {
  it("uses unambiguous, domain-separated full SHA-256 hashes", () => {
    expect(domainHash("vibestudio/execution/v1", "a", "bc")).not.toBe(
      domainHash("vibestudio/execution/v1", "ab", "c")
    );
    expect(domainHash("vibestudio/execution/v1", "a")).not.toBe(
      domainHash("vibestudio/build-input/v1", "a")
    );
    expect(domainHash("vibestudio/execution/v1", "a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts full state hashes and rejects shortened security identifiers", () => {
    expect(parseSha256(`state:${a}`)).toBe(a);
    expect(() => parseSha256(a.slice(0, 16))).toThrow("full lowercase SHA-256");
    expect(displayDigest(a, 16)).toHaveLength(16);
  });

  it("canonicalizes recipe object order and separates every output-affecting input", () => {
    const left = recipe({ options: { z: 1, a: 2 } });
    const right = recipe({ options: { a: 2, z: 1 } });
    expect(computeRecipeDigest(left)).toBe(computeRecipeDigest(right));
    expect(computeRecipeDigest(recipe({ architecture: "arm64" }))).not.toBe(
      computeRecipeDigest(recipe())
    );
    expect(computeRecipeDigest(recipe({ declaredEnvironment: { LANG: "de_DE.UTF-8" } }))).not.toBe(
      computeRecipeDigest(recipe())
    );
  });

  it("binds source, recipe, build key, manifest, and emitted bytes", () => {
    const source = createSourceRevision({ repoPath: "workers/example", stateHash: a });
    const first = createExecutionArtifactRef({
      source,
      recipe: recipe(),
      entries: [
        {
          path: "bundle.js",
          role: "primary",
          mode: 0o644,
          contentType: "text/javascript",
          bytes: Buffer.from("one"),
        },
      ],
    });
    const changedBytes = createExecutionArtifactRef({
      source,
      recipe: recipe(),
      entries: [
        {
          path: "bundle.js",
          role: "primary",
          mode: 0o644,
          contentType: "text/javascript",
          bytes: Buffer.from("two"),
        },
      ],
    });
    expect(first.ref.artifactDigest).not.toBe(changedBytes.ref.artifactDigest);
    expect(first.ref.executionDigest).not.toBe(changedBytes.ref.executionDigest);
    expect(codePrincipal(first.ref)).toBe(
      `code:workers/example@${first.ref.executionDigest}`
    );
  });

  it("normalizes portable paths and rejects traversal and duplicate aliases", () => {
    expect(canonicalArtifactPath("assets\\icon.png")).toBe("assets/icon.png");
    expect(() => canonicalArtifactPath("../secret")).toThrow("not canonical");
    const source = createSourceRevision({ repoPath: "workers/example", stateHash: a });
    expect(() =>
      createExecutionArtifactRef({
        source,
        recipe: recipe(),
        entries: [
          {
            path: "a\\b",
            role: "asset",
            mode: 0o644,
            contentType: "text/plain",
            bytes: Buffer.from("1"),
          },
          {
            path: "a/b",
            role: "asset",
            mode: 0o644,
            contentType: "text/plain",
            bytes: Buffer.from("2"),
          },
        ],
      })
    ).toThrow("Duplicate artifact path");
  });
});
