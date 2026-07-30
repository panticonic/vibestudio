import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  internalDOExecutionArtifacts,
  internalDOExecutionIdentity,
  INTERNAL_DO_CLASSES,
  type InternalDOBundle,
} from "./internalDoLoader.js";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/retention";

function bundle(content = "export class EvalDO {};"): InternalDOBundle {
  return {
    bundle: content,
    buildKey: createHash("sha256").update(content).digest("hex"),
  };
}

describe("internalDOExecutionIdentity", () => {
  it("seals exact bundle bytes, class entrypoint, and reviewed authority", () => {
    const evalDo = internalDOExecutionIdentity(bundle(), "EvalDO");
    const workspace = internalDOExecutionIdentity(bundle(), "WorkspaceDO");

    expect(evalDo).toMatchObject({
      source: "vibestudio/internal",
      unitName: "@panticonic/builtin/eval.engine",
      stateHash: `state:${bundle().buildKey}`,
      buildKey: bundle().buildKey,
      effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(evalDo.authority.requests).toEqual([]);
    expect(workspace.executionDigest).not.toBe(evalDo.executionDigest);
    expect(verifyExecutionArtifactRef(evalDo.artifact)).toEqual(evalDo.artifact);
    expect(evalDo.artifact.sourceState).toMatchObject({
      kind: "product-seed",
      state: null,
      contentRoots: [{ repoPath: null, stateHash: `state:${bundle().buildKey}` }],
    });
  });

  it("enumerates every reviewed product-seed entrypoint with one shared bundle key", () => {
    const artifacts = internalDOExecutionArtifacts(bundle());
    expect(artifacts).toHaveLength(INTERNAL_DO_CLASSES.length);
    expect(new Set(artifacts.map((artifact) => artifact.buildKey))).toEqual(
      new Set([bundle().buildKey])
    );
    expect(new Set(artifacts.map((artifact) => artifact.executionDigest))).toHaveLength(
      INTERNAL_DO_CLASSES.length
    );
  });

  it("rejects mismatched bytes and unreviewed internal exports", () => {
    expect(() =>
      internalDOExecutionIdentity({ bundle: "changed", buildKey: bundle().buildKey }, "WorkspaceDO")
    ).toThrow(/does not match its exact bytes/);
    expect(() => internalDOExecutionIdentity(bundle(), "UnreviewedDO")).toThrow(
      /not a reviewed product export/
    );
  });
});
