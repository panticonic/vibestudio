import { describe, expect, it } from "vitest";
import {
  internalDOExecutionArtifacts,
  internalDOExecutionIdentity,
  INTERNAL_DO_CLASSES,
} from "./internalDoLoader.js";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/retention";
import { internalDoProgramsForFixture } from "../../../tests/fixtures/internalDoPrograms.js";

const bundle = internalDoProgramsForFixture;

describe("internalDOExecutionIdentity", () => {
  it("seals exact bundle bytes, class entrypoint, and reviewed authority", () => {
    const evalDo = internalDOExecutionIdentity(bundle(), "EvalDO");
    const workspace = internalDOExecutionIdentity(bundle(), "WorkspaceDO");

    expect(evalDo).toMatchObject({
      source: "vibestudio/internal",
      unitName: "@panticonic/builtin/eval.engine",
      stateHash: `state:${bundle().get("EvalDO").buildKey}`,
      buildKey: bundle().get("EvalDO").buildKey,
      effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(evalDo.authority.requests).toEqual([]);
    expect(workspace.executionDigest).not.toBe(evalDo.executionDigest);
    expect(verifyExecutionArtifactRef(evalDo.artifact)).toEqual(evalDo.artifact);
    expect(evalDo.artifact.sourceState).toMatchObject({
      kind: "product-seed",
      state: null,
      contentRoots: [{ repoPath: null, stateHash: `state:${bundle().get("EvalDO").buildKey}` }],
    });
  });

  it("enumerates each reviewed product-seed entrypoint with its own program key", () => {
    const artifacts = internalDOExecutionArtifacts(bundle());
    expect(artifacts).toHaveLength(INTERNAL_DO_CLASSES.length);
    expect(new Set(artifacts.map((artifact) => artifact.buildKey))).toHaveLength(
      INTERNAL_DO_CLASSES.length
    );
    expect(new Set(artifacts.map((artifact) => artifact.executionDigest))).toHaveLength(
      INTERNAL_DO_CLASSES.length
    );
  });

  it("rejects unreviewed exports and owns a frozen identity capture", () => {
    const programs = bundle();
    const identity = internalDOExecutionIdentity(programs, "EvalDO");
    expect(internalDOExecutionIdentity(programs, "EvalDO")).toBe(identity);
    expect(Object.isFrozen(identity.authority)).toBe(true);
    expect(Object.isFrozen(identity.artifact.sourceState)).toBe(true);
    expect(() => internalDOExecutionIdentity(bundle(), "UnreviewedDO")).toThrow(
      /not a reviewed product export/
    );
  });
});
